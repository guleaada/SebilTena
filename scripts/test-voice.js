// M14 voice-input unit tests. Symptom matching decides which IPM guidance a
// farmer is shown, so it is SAFETY-RELEVANT: we test the SAME file the browser
// runs (public/js/voice.js) with a fake `window`, and we test it against the
// REAL reviewed aliases in locales/*.json rather than fixtures — a locale edit
// that makes two symptoms collide must fail here, not in a field.
//
//   node scripts/test-voice.js
//
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SYMPTOMS, SYMPTOM_SET } from "../src/advisorCodes.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

let passed = 0, failed = 0;
function check(name, cond, detail = "") {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.error(`  FAIL ${name}${detail ? "  -> " + detail : ""}`); }
}
const section = (s) => console.log(`\n${s}`);

// Load the browser module exactly as the browser will.
const win = {};
new Function("window", fs.readFileSync(path.join(ROOT, "public", "js", "voice.js"), "utf8"))(win);
const { foldGeez, normalize, phraseHit, matchSymptom, recognitionTag, supported, canOffer } = win.VoiceMatch;

const readLocale = (l) => JSON.parse(fs.readFileSync(path.join(ROOT, "locales", `${l}.json`), "utf8"));
const ALIAS_LANGS = ["en", "am", "om"]; // the languages with reviewed symptom strings
const aliasesFor = (l) => readLocale(l).symptom_voice || {};

// ---------------------------------------------------------------------------
section("Normalization — punctuation, case, spacing");
check("lowercases", normalize("Yellow LEAVES") === "yellow leaves");
check("strips punctuation the recognizer adds", normalize("yellow leaves, please!") === "yellow leaves please");
check("collapses runs of whitespace", normalize("  holes   in  leaves ") === "holes in leaves");
check("empty/nullish -> empty string", normalize(null) === "" && normalize(undefined) === "" && normalize("   ") === "");
check("keeps digits", normalize("2 spots") === "2 spots");
check("Oromo glottal ` is dropped, word kept", normalize("ta`aa") === "ta aa");

section("Ge'ez homophone folding — a recognizer's spelling must not matter");
check("ሐ family folds onto ሀ family", foldGeez("ሐ") === "ሀ" && foldGeez("ሓ") === "ሃ");
check("ኀ family folds onto ሀ family", foldGeez("ኀ") === "ሀ" && foldGeez("ኃ") === "ሃ");
check("ሠ family folds onto ሰ family", foldGeez("ሠ") === "ሰ" && foldGeez("ሣ") === "ሳ");
check("ዐ family folds onto አ family", foldGeez("ዐ") === "አ" && foldGeez("ዓ") === "ኣ");
check("ፀ family folds onto ጸ family", foldGeez("ፀ") === "ጸ" && foldGeez("ፃ") === "ጻ");
check("folding preserves the vowel order within a family", foldGeez("ሑ") === "ሁ" && foldGeez("ሒ") === "ሂ");
// Folding equates CONSONANT families only, at the same vowel order. It must not
// equate different vowel orders (ሐ 1st vs ሓ 4th) — that is a real distinction.
check("homophone spellings of the same word compare equal", normalize("ጸሐይ") === normalize("ፀሐይ"));
check("...also across the ሰ/ሠ family", normalize("ሰራ") === normalize("ሠራ"));
check("different VOWEL orders stay distinct", normalize("ሀ") !== normalize("ሃ"));
check("unrelated Ge'ez text is untouched", foldGeez("ቅጠል") === "ቅጠል");
check("Latin text is untouched by folding", foldGeez("yellow leaves") === "yellow leaves");

section("phraseHit — left edge anchored, right edge free");
check("stem matches its inflection", phraseHit("plants are wilting", "wilt"));
check("plural matches", phraseHit("i see spots on leaves", "spot"));
check("matches at string start", phraseHit("holes in leaves", "holes"));
check("does NOT match mid-word ('hole' inside 'whole')", !phraseHit("the whole plant is dying", "hole"));
check("does not match absent phrase", !phraseHit("yellow leaves", "insects"));
check("empty needle never hits", !phraseHit("anything", ""));

// ---------------------------------------------------------------------------
section("The core guarantee: only ever a code from the allowed set, or nothing");
const EN = aliasesFor("en");
{
  const r = matchSymptom("my leaves are turning yellow", EN, SYMPTOMS);
  check("a clear phrase resolves to a vocabulary code", r.status === "match" && SYMPTOM_SET.has(r.symptom), JSON.stringify(r));
}
{
  // A locale that has drifted ahead of the backend must not smuggle a code in.
  const rogue = { ...EN, chemtrails: ["my leaves are turning yellow"], leaves_yellow: [] };
  const r = matchSymptom("my leaves are turning yellow", rogue, SYMPTOMS);
  check("a code absent from `allowed` is never returned", r.status === "none" && r.symptom === null, JSON.stringify(r));
}
{
  const r = matchSymptom("my leaves are turning yellow", EN, ["wilting"]);
  check("`allowed` narrows the result set", r.status === "none", JSON.stringify(r));
}
check("free text never leaks into the result", (() => {
  const r = matchSymptom("please recommend a strong pesticide for my tomatoes", EN, SYMPTOMS);
  return r.symptom === null || SYMPTOM_SET.has(r.symptom);
})());

section("Conservative failure — refuse rather than guess");
{
  const r = matchSymptom("insects made holes in my leaves", EN, SYMPTOMS);
  check("two genuine symptoms -> ambiguous, not a guess", r.status === "ambiguous" && r.symptom === null, JSON.stringify(r));
  check("...and it offers both to choose from", r.candidates.length >= 2 && r.candidates.every((c) => SYMPTOM_SET.has(c)), JSON.stringify(r));
}
{
  const r = matchSymptom("the weather is nice today", EN, SYMPTOMS);
  check("unrelated speech -> none", r.status === "none" && r.symptom === null, JSON.stringify(r));
}
check("silence/empty transcript -> none", matchSymptom("", EN, SYMPTOMS).status === "none");
check("null transcript -> none", matchSymptom(null, EN, SYMPTOMS).status === "none");
check("missing alias map -> none", matchSymptom("yellow leaves", null, SYMPTOMS).status === "none");
check("empty allowed set -> none", matchSymptom("yellow leaves", EN, []).status === "none");
check("malformed alias map (non-array) -> none, no throw", (() => {
  try { return matchSymptom("yellow leaves", { leaves_yellow: "yellow leaves" }, SYMPTOMS).status === "none"; }
  catch { return false; }
})());
{
  const r = matchSymptom("yellow leaves", EN, SYMPTOMS);
  check("an exact alias hit beats incidental substring hits", r.status === "match" && r.symptom === "leaves_yellow", JSON.stringify(r));
}

// ---------------------------------------------------------------------------
section("Reviewed locale aliases — every language that offers a mic");
for (const lang of ALIAS_LANGS) {
  const map = aliasesFor(lang);
  const loc = readLocale(lang);
  console.log(`  [${lang}]`);
  check(`${lang}: has spoken aliases`, Object.keys(map).length > 0);
  check(`${lang}: covers every symptom in the vocabulary`,
    SYMPTOMS.every((s) => Array.isArray(map[s]) && map[s].length > 0),
    SYMPTOMS.filter((s) => !map[s]?.length).join(",") || "");
  check(`${lang}: introduces no code outside the vocabulary`,
    Object.keys(map).every((k) => SYMPTOM_SET.has(k)),
    Object.keys(map).filter((k) => !SYMPTOM_SET.has(k)).join(",") || "");
  check(`${lang}: the on-screen label is itself sayable`,
    SYMPTOMS.every((s) => {
      const r = matchSymptom(loc.symptom[s], map, SYMPTOMS);
      return r.status === "match" && r.symptom === s;
    }),
    SYMPTOMS.filter((s) => matchSymptom(loc.symptom[s], map, SYMPTOMS).symptom !== s).join(",") || "");

  // The collision test that protects the field: saying ONE symptom's alias must
  // never resolve to a DIFFERENT symptom. Ambiguity is acceptable (we ask);
  // a confident wrong answer is not.
  const wrong = [];
  for (const s of SYMPTOMS) {
    for (const alias of map[s] || []) {
      const r = matchSymptom(alias, map, SYMPTOMS);
      if (r.status === "match" && r.symptom !== s) wrong.push(`"${alias}" (${s}) -> ${r.symptom}`);
    }
  }
  check(`${lang}: no alias resolves to the WRONG symptom`, wrong.length === 0, wrong.join(" | "));

  check(`${lang}: has a recognizer tag`, !!recognitionTag(lang));
}

section("Real-world English phrasings a farmer might actually say");
const PHRASINGS = [
  ["the leaves are going yellow", "leaves_yellow"],
  ["there are holes in my leaves", "holes_in_leaves"],
  ["brown spots on the leaves", "spots_on_leaves"],
  ["my plants are wilting", "wilting"],
  ["i can see insects", "insects_visible"],
  ["the plants are not growing", "stunted_growth"],
];
for (const [said, want] of PHRASINGS) {
  const r = matchSymptom(said, EN, SYMPTOMS);
  check(`"${said}" -> ${want}`, r.status === "match" && r.symptom === want, `${r.status}:${r.symptom ?? r.candidates.join("/")}`);
}

// ---------------------------------------------------------------------------
section("Language tags — ask only where we can honour the answer");
check("en/am/om have tags", ["en", "am", "om"].every((l) => !!recognitionTag(l)));
check("aa has NO tag (no recognizer known -> never offer a dead mic)", recognitionTag("aa") === null);
check("unknown language -> no tag", recognitionTag("zz") === null && recognitionTag("") === null && recognitionTag(null) === null);

section("supported() / canOffer() — degrade to the menu, never a dead button");
check("no recognizer -> unsupported", supported({}) === false);
check("prefixed recognizer counts", supported({ webkitSpeechRecognition: function () {} }) === true);
check("standard recognizer counts", supported({ SpeechRecognition: function () {} }) === true);

const WIN = { SpeechRecognition: function () {} };
const base = { win: WIN, lang: "am", aliasMap: aliasesFor("am"), online: true, blocked: false };
check("all conditions met -> offer the mic", canOffer(base) === true);
check("no recognizer -> no mic", canOffer({ ...base, win: {} }) === false);
check("OFFLINE -> no mic (Web Speech is a cloud service; offline is normal here)", canOffer({ ...base, online: false }) === false);
check("language with no tag -> no mic", canOffer({ ...base, lang: "aa" }) === false);
check("language with no reviewed aliases -> no mic", canOffer({ ...base, lang: "ti", aliasMap: aliasesFor("ti") }) === false);
check("recognizer already refused this language -> no mic", canOffer({ ...base, blocked: true }) === false);
check("unreviewed languages (ti/so/aa) get no mic today",
  ["ti", "so", "aa"].every((l) => canOffer({ ...base, lang: l, aliasMap: aliasesFor(l) }) === false));

// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
