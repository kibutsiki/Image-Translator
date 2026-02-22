# OCR Server (Native Tesseract)

Used by the Image Translator extension. Accepts a base64 image, runs Tesseract OCR, returns text.

## Local (no Docker)

- Install [Tesseract](https://github.com/tesseract-ocr/tesseract) and language packs (e.g. `tesseract-ocr-jpn`, `tesseract-ocr-kor`) on your machine.
- `npm install && npm start`
- Server: `http://localhost:3000`. In the extension Settings, set OCR Server URL to `http://localhost:3000`.

## Deploy to Render (free tier)

1. Push this repo (or just the `ocr-server` folder) to GitHub.
2. In [Render](https://render.com): New → Web Service → connect repo.
3. Set **Root Directory** to `ocr-server` (if the Dockerfile is inside `ocr-server`).
4. Set **Environment** to **Docker** (so Render uses the Dockerfile).
5. Deploy. Render will build the image (Node + Tesseract + language packs) and run the server.
6. Copy the service URL (e.g. `https://your-ocr-server.onrender.com`).
7. In the extension: Settings → OCR Server URL → paste that URL → Save URL.

**Note:** On the free tier the service may sleep after inactivity; the first request after sleep can be slow.

## API

- `GET /` — Health check.
- `POST /ocr` — Body: `{ "imageBase64": "data:image/png;base64,...", "languages": "eng+kor+jpn" }`. Response: `{ "success": true, "text": "...", "wordCount": N }`.
