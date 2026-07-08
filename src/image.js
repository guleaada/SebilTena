// Normalize an image input that may be a raw base64 string or a data URL into
// its parts. Shared by the OCR path and the vision client.
export function parseImage(input) {
  if (!input || typeof input !== "string") return null;
  const trimmed = input.trim();
  const m = /^data:([^;]+);base64,(.*)$/s.exec(trimmed);
  if (m) {
    return { mime: m[1], base64: m[2], dataUrl: trimmed };
  }
  const base64 = trimmed;
  const mime = "image/jpeg";
  return { mime, base64, dataUrl: `data:${mime};base64,${base64}` };
}
