import { parseImage } from "./image.js";

// Server-side Tesseract OCR for the /api/scan path. In M3 the same OCR runs
// client-side in the browser so verification works offline; this server path
// mirrors it for the API and for callers without a browser.
//
// Resilient by design: any failure (worker can't load its wasm/lang data,
// bad image, etc.) returns empty text + zero confidence so the caller falls
// through to the vision LLM rather than crashing.
export async function ocrImage(imageBase64) {
  const parsed = parseImage(imageBase64);
  if (!parsed?.base64) return { text: "", confidence: 0 };

  let worker;
  try {
    const { createWorker } = await import("tesseract.js");
    const buf = Buffer.from(parsed.base64, "base64");
    worker = await createWorker("eng");
    const { data } = await worker.recognize(buf);
    return { text: data?.text || "", confidence: Number(data?.confidence ?? 0) };
  } catch (err) {
    return { text: "", confidence: 0, error: String(err?.message || err) };
  } finally {
    if (worker) {
      try {
        await worker.terminate();
      } catch {
        /* ignore */
      }
    }
  }
}
