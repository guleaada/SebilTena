#!/usr/bin/env bash
# Vendor the tesseract.js browser assets into public/vendor/tesseract so client
# OCR (M6 Part A) works offline from our own origin (never a CDN). The large
# binaries (*.wasm, eng.traineddata.gz) are gitignored — run this after `npm i`.
#   bash scripts/vendor-tesseract.sh
set -euo pipefail
cd "$(dirname "$0")/.."
DEST=public/vendor/tesseract
mkdir -p "$DEST"
cp node_modules/tesseract.js-core/*.js node_modules/tesseract.js-core/*.wasm "$DEST"/
cp node_modules/tesseract.js/dist/worker.min.js "$DEST"/worker.min.js
cp node_modules/tesseract.js/dist/tesseract.min.js "$DEST"/tesseract.min.js
# tesseract langPath expects the gzipped traineddata; reuse the server-downloaded copy.
if [ -f eng.traineddata ]; then
  gzip -c eng.traineddata > "$DEST"/eng.traineddata.gz
else
  echo "eng.traineddata not found — run a server-side scan once (M2) to fetch it, then re-run." >&2
fi
echo "Vendored tesseract assets into $DEST"
