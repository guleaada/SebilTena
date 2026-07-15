import "dotenv/config";
import { config } from "../src/config.js";
import { parseImage } from "../src/image.js";

// ---------------------------------------------------------------------------
// VISION FALLBACK CHAIN — Groq -> OpenRouter -> Gemini.
//
// This module reads an IDENTITY off a label photo. It is NEVER a source of
// dosage, safety, PPE or first-aid data (see SAFETY.md). The prompt forbids it,
// and readLabel() strips every key except the four identity fields before
// returning — even if a model tries to volunteer more.
// ---------------------------------------------------------------------------

// The exact intent sent to every provider. Constrained hard.
export const VISION_PROMPT =
  'You are reading a pesticide product label. Return STRICT JSON only, no prose: ' +
  '{"registration_no": string|null, "product_name": string|null, ' +
  '"active_ingredient": string|null, "confidence": "high"|"medium"|"low"}. ' +
  "Read ONLY what is printed on the label. Do NOT infer, guess, or provide " +
  "dosage, safety, PPE, or first-aid information. If a field is not clearly " +
  "visible, return null for it.";

const LOW = Object.freeze({
  registration_no: null,
  product_name: null,
  active_ingredient: null,
  confidence: "low",
  provider: null,
});

function strOrNull(v) {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length ? t : null;
}

// Keep ONLY the four identity keys. Anything else the model returns is dropped.
function sanitize(obj, provider) {
  const conf = ["high", "medium", "low"].includes(obj?.confidence) ? obj.confidence : "low";
  return {
    registration_no: strOrNull(obj?.registration_no),
    product_name: strOrNull(obj?.product_name),
    active_ingredient: strOrNull(obj?.active_ingredient),
    confidence: conf,
    provider,
  };
}

// Strip code fences and pull the first {...} block, then JSON.parse in a guard.
function extractJSON(text) {
  if (!text || typeof text !== "string") return null;
  let t = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(t.slice(start, end + 1));
  } catch {
    return null;
  }
}

async function fetchJSON(url, options) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), config.aiTimeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status} ${body.slice(0, 180)}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// ---- Provider adapters. Each returns a raw parsed identity object or throws --

// OpenAI-compatible (Groq, OpenRouter).
async function callOpenAICompatible({ url, apiKey, model, dataUrl, extraHeaders }) {
  const json = await fetchJSON(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...extraHeaders,
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: 300,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: VISION_PROMPT },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        },
      ],
    }),
  });
  return extractJSON(json?.choices?.[0]?.message?.content);
}

// Google Gemini generateContent.
async function callGemini({ apiKey, model, mime, base64 }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const json = await fetchJSON(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            { text: VISION_PROMPT },
            { inline_data: { mime_type: mime, data: base64 } },
          ],
        },
      ],
      generationConfig: { temperature: 0, maxOutputTokens: 300 },
    }),
  });
  const text = json?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";
  return extractJSON(text);
}

function providerChain(img) {
  return [
    {
      name: "groq",
      key: process.env.GROQ_API_KEY,
      run: () =>
        callOpenAICompatible({
          url: "https://api.groq.com/openai/v1/chat/completions",
          apiKey: process.env.GROQ_API_KEY,
          model: config.models.groq,
          dataUrl: img.dataUrl,
        }),
    },
    {
      name: "openrouter",
      key: process.env.OPENROUTER_API_KEY,
      run: () =>
        callOpenAICompatible({
          url: "https://openrouter.ai/api/v1/chat/completions",
          apiKey: process.env.OPENROUTER_API_KEY,
          model: config.models.openrouter,
          dataUrl: img.dataUrl,
          extraHeaders: {
            "HTTP-Referer": "https://medaguard.app",
            "X-Title": "Sebil Tena",
          },
        }),
    },
    {
      name: "gemini",
      key: process.env.GEMINI_API_KEY,
      run: () =>
        callGemini({
          apiKey: process.env.GEMINI_API_KEY,
          model: config.models.gemini,
          mime: img.mime,
          base64: img.base64,
        }),
    },
  ];
}

/**
 * Read the identity fields off a pesticide label image.
 * Tries Groq -> OpenRouter -> Gemini, falling through on error, timeout, or a
 * returned confidence below threshold. Never throws to the caller.
 * @param {string} imageBase64  raw base64 or data URL
 * @returns {Promise<{registration_no,product_name,active_ingredient,confidence,provider}>}
 */
export async function readLabel(imageBase64) {
  const img = parseImage(imageBase64);
  if (!img?.base64) return { ...LOW };

  for (const provider of providerChain(img)) {
    if (!provider.key) continue; // no key configured -> skip provider
    try {
      const raw = await provider.run();
      if (!raw) continue; // unparseable -> fall through
      const candidate = sanitize(raw, provider.name);
      const hasIdentity =
        candidate.registration_no || candidate.product_name || candidate.active_ingredient;
      if (config.visionAcceptConfidence.includes(candidate.confidence) && hasIdentity) {
        return candidate;
      }
      // Confidence too low or empty read -> try next provider.
    } catch (err) {
      // Error/timeout -> try next provider.
      console.warn(`aiClient: ${provider.name} failed: ${err?.message || err}`);
    }
  }

  // All providers unavailable / failed / low -> caller applies conservative default.
  return { ...LOW };
}
