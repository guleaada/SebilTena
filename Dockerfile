# Sebil Tena — production image (M8 STAGING demo).
# Node 20, non-root, NODE_ENV=production, self-contained: the Tesseract core +
# English language data are vendored into our own origin at BUILD time so client
# OCR works offline and the server NEVER fetches language data from a third party
# at runtime. See SAFETY.md (the production boot-gate refuses to serve unreviewed
# first-aid) and DEPLOY.md.
FROM node:20-slim

ENV NODE_ENV=production
WORKDIR /app

# Minimal build-time tools for vendoring assets (curl to fetch the traineddata
# ONCE, at build). Removed from the layer's package lists to keep the image lean.
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Install production dependencies only, from the lockfile (reproducible).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# App source (node_modules, .env, local db, tests are excluded via .dockerignore).
COPY . .

# Vendor Tesseract assets into /public/vendor/tesseract (our own origin). The
# traineddata is fetched here at BUILD time only; at runtime nothing is fetched
# from a third party (client + server OCR both read these local files).
RUN mkdir -p public/vendor/tesseract \
 && curl -fsSL https://tessdata.projectnaptha.com/4.0.0/eng.traineddata.gz \
      -o public/vendor/tesseract/eng.traineddata.gz \
 && cp node_modules/tesseract.js-core/*.js node_modules/tesseract.js-core/*.wasm public/vendor/tesseract/ \
 && cp node_modules/tesseract.js/dist/worker.min.js public/vendor/tesseract/worker.min.js \
 && cp node_modules/tesseract.js/dist/tesseract.min.js public/vendor/tesseract/tesseract.min.js

# Drop privileges: run as the built-in non-root `node` user.
RUN chown -R node:node /app
USER node

ENV PORT=8080
EXPOSE 8080

# Liveness: /api/health must answer 200. Node 20 has global fetch.
HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
