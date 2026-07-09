# MedaGuard — Native Speaker Recording Script

**Purpose:** These are all the phrases MedaGuard speaks aloud to farmers. Recording them once per language gives us perfect pronunciation, full offline operation, and coverage for languages no text-to-speech provider supports.

**Languages needed:** Amharic · Afaan Oromo · Sidaamu Afoo · Tigrinya · Somali · Wolaytta

> This file is the **canonical phrase-key inventory**. The app requests audio by
> exactly these `key`s (`public/js/audio.js`, resolving `/audio/{lang}/{key}.{fmt}`),
> and `scripts/gen-audio-placeholders.js` generates the English placeholders from
> this same list. Add/rename a key here and in the generator together.

---

## Instructions for the recorder

- **One audio file per phrase.** Filename = the `key` column exactly, e.g. `verdict_verified.mp3`.
- **Folder per language**, using these codes: `am` (Amharic), `om` (Afaan Oromo), `sid` (Sidaamu Afoo), `ti` (Tigrinya), `so` (Somali), `wal` (Wolaytta).
- **Phone recording is fine.** Quiet room, phone ~20cm from mouth, no music, no background voices.
- **Speak clearly and calmly**, slightly slower than normal conversation. A frightened farmer is listening.
- **Leave ~0.5s of silence** at the start and end of each clip.
- **The English column is a meaning guide, not a script to translate literally.** Say it the way a trusted extension agent would say it to a farmer in the field. Natural beats literal.
- **Emergency phrases (Section 3) are the top priority.** If time is short, record those first.

---

## 1. Verdicts (spoken the moment a scan result appears)

| key | Meaning to convey |
|---|---|
| `verdict_verified` | This product is registered. It is safe to use as directed. |
| `verdict_confirm` | Is this your product? |
| `verdict_unregistered` | Warning. This product is not registered. It may be fake. Do not use it. |
| `verdict_banned` | Stop. This product is banned. Do not use it. |
| `verdict_expired` | Caution. This product's registration has expired. Do not use it until you check. |
| `verdict_unconfirmed` | Could not confirm this product. Do not use it until it is checked. |
| `verdict_offline` | No connection. Please try again when you have signal. |
| `scanning` | Reading the label. Please wait. |

---

## 2. Safety & dosage

| key | Meaning to convey |
|---|---|
| `dose_is` | The correct amount is |
| `wait_before_harvest` | Wait this many days before harvesting |
| `days` | days |
| `wear_protection` | Wear protection |
| `ppe_gloves` | Gloves |
| `ppe_mask` | Face mask |
| `ppe_boots` | Boots |
| `ppe_goggles` | Eye goggles |
| `ppe_overall` | Long clothing that covers your body |
| `hazard_low` | Low danger |
| `hazard_moderate` | Moderate danger |
| `hazard_high` | High danger |
| `hazard_extreme` | Extreme danger |
| `crop_not_covered` | This product is not approved for that crop. Ask your extension agent. |
| `ask_agent` | Contact your extension agent |
| `disclaimer` | This is official information. If you are unsure, ask your extension agent. |
| `replay` | Listen again |

---

## 3. EMERGENCY — record these first

| key | Meaning to convey |
|---|---|
| `emergency_title` | Emergency. Poisoning help. |
| `emergency_ask_route` | How did the poison touch the person? |
| `route_skin` | On the skin |
| `route_eyes` | In the eyes |
| `route_swallowed` | Swallowed |
| `route_breathed` | Breathed in |
| `emergency_call_help` | Call for help now |
| `emergency_next_step` | Next step |
| `emergency_stay_calm` | Stay calm. Follow these steps. |

### Universal first-aid steps (used when the product is unknown)

| key | Meaning to convey |
|---|---|
| `aid_move_air` | Move the person to fresh air, away from the chemical. |
| `aid_remove_clothes` | Remove any clothing that has the chemical on it. |
| `aid_rinse_skin` | Rinse the skin with clean running water for twenty minutes. |
| `aid_rinse_eyes` | Rinse the eyes with clean running water for twenty minutes. Keep the eye open. |
| `aid_do_not_vomit` | Do not make the person vomit. |
| `aid_no_food_drink` | Do not give food or drink. |
| `aid_keep_container` | Keep the pesticide container to show the health worker. |
| `aid_seek_help` | Take the person to a health centre immediately. |
| `aid_if_unconscious` | If the person is not awake, lay them on their side and get help immediately. |

---

## 4. Numbers & units (for speaking doses and waiting periods)

Record each number **on its own**, as a single spoken word.

- `num_0` through `num_20` — zero, one, two … twenty
- `num_30`, `num_40`, `num_50`, `num_60`, `num_70`, `num_80`, `num_90`, `num_100`
- `point` — the decimal separator (as in "two **point** five")
- `unit_ml_per_litre` — millilitres per litre
- `unit_g_per_litre` — grams per litre
- `unit_kg_per_hectare` — kilograms per hectare
- `unit_l_per_hectare` — litres per hectare
- `unit_ml_per_knapsack` — millilitres per knapsack sprayer

> Numbers 21–99 are composed from tens + ones (e.g. 45 = `num_40` + `num_5`),
> so only 0–20 and the tens need recording. Decimals use `point` + a single
> digit (`num_0`–`num_9`).

---

## 5. Navigation

| key | Meaning to convey |
|---|---|
| `scan_bottle` | Scan a bottle |
| `yes` | Yes |
| `no` | No |
| `next` | Next |
| `back` | Back |
| `try_again` | Try again |
| `choose_crop` | Choose your crop |

---

**Total: ~80 clips per language.** A focused session takes about an hour. Emergency section (Section 3) is the priority if time is limited.

**Send back:** one folder per language, named with the language code, containing the MP3 files named exactly by their key.
