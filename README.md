# Image Translator

A Chrome extension that translates the speech bubbles in manga, manhwa and comic images on any web page, plus the small server that does the translating.

Open a chapter, press **Scan all images** (or **Click to translate** and pick one), and the translation appears in a panel over the image, in reading order, with the original text underneath.

```
 web page ──► content scripts ──► background service worker ──► your server ──► AI model
 (images)    capture + tile         adds token, retries 429       auth, rate limit   finds bubbles
             show the panels                                       validates input    and translates
```

## What's in here

| Folder | What it is |
| --- | --- |
| `extension/` | Manifest V3 Chrome extension (popup, background service worker, content scripts) |
| `ocr-server/` | Node/Express backend. Keeps your AI key off the client, and rate-limits and authenticates requests. (The folder name is historical; it no longer does OCR itself.) |

## Set up the server

Requires Node 20+.

```bash
cd ocr-server
npm install
cp .env.example .env     # then edit .env
npm start
```

In `.env`, set:

1. **`TRANSLATOR_API_KEY`**: a long random secret. Generate one with
   `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`
2. **TAMUS AI credentials**: `TAMUS_AI_CHAT_API_ENDPOINT` and `TAMUS_AI_CHAT_API_KEY`.
   The server uses only TAMUS AI's `protected.gemini-2.5-flash-lite` model.

The server refuses to start if the token or provider is missing, so a misconfiguration shows up immediately instead of as confusing errors later.

## Set up the extension

1. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and choose the `extension/` folder.
2. Click the extension icon. Under **Server**, enter your server URL (`http://localhost:3000` locally) and the same `TRANSLATOR_API_KEY`, then press **Save** and **Test connection**. It should say *Connected*.
3. Open a page with images, pick a target language, and press **Scan all images** or **Click to translate**.

## Configuration

All optional except the first two groups above.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | Port to listen on |
| `RATE_LIMIT_PER_MIN` | `30` | Max requests per minute per client IP |
| `RATE_LIMIT_PER_DAY` | `1500` | Max requests per day per client IP (protects a free-tier AI quota) |
| `UPSTREAM_CONCURRENCY` | `4` | Max simultaneous calls to the AI provider |
| `UPSTREAM_TIMEOUT_MS` | `45000` | Per-call timeout to the AI provider |
| `TRUST_PROXY` | `1` on Render, else off | Set to `1` behind a reverse proxy so limits use the real client IP |

## How it behaves

- **Authentication.** Every translation request needs `Authorization: Bearer <TRANSLATOR_API_KEY>`. Tokens are compared in constant time. After 20 wrong tokens from one IP, that IP is locked out for 15 minutes.
- **Rate limiting.** Per-IP sliding windows (per minute and per day). Over the limit, the server answers `429` with a `Retry-After` header, and the extension waits and retries automatically (up to 3 attempts, never more than 30 s per wait). The limiter lives in memory, so counts reset when the server restarts and aren't shared between multiple instances.
- **Tall images.** Long webtoon strips are cut into tiles (up to 6) so text stays readable instead of being shrunk to fit one request. Each tile is one API call.
- **Cross-origin images.** If the browser won't let the page read an image's pixels, the extension fetches it through its own permissions instead.
- **Errors you can read.** Bad token, rate limit, unreachable server and AI-service failures each show a plain message on the page and in the popup instead of failing silently.
- **Safe rendering.** Translated text is inserted with `textContent`, never as HTML.
- **No secrets in the client.** The AI key stays on the server. The extension only holds the app token, in `chrome.storage.local`.

## API

All routes except `/health` need the bearer token.

| Route | Body | Response |
| --- | --- | --- |
| `GET /health` | none | `{ ok, provider }` |
| `GET /auth-check` | none | `{ ok: true }` if the token is valid (costs no AI quota) |
| `POST /translate-text` | `{ text, target_lang? }` | `{ translated_text, target_lang }` |
| `POST /vision-translate-bubbles` | `{ imageBase64, target_lang? }` (a `data:image/...;base64,...` URL) | `{ bubbles: [{ original, text }], target_lang, meta }` |

Errors are JSON `{ error }` with a meaningful status: `400` bad input, `401` bad token, `413` too large, `429` rate limited, `502`/`503`/`504` upstream AI problems.

## Tests

```bash
cd ocr-server && npm test       # server: auth, validation, rate limits, both AI providers, upstream failures
cd extension && node --test     # service worker: 429 retry/backoff, friendly errors
```

The server tests start the real server against a mock AI service, so they need no API keys and use no quota.

## Deploy (Render free tier)

1. Push this repo to GitHub.
2. In [Render](https://render.com): **New → Web Service**, connect the repo, set **Root Directory** to `ocr-server`, **Build Command** `npm install`, **Start Command** `npm start`.
3. Add the environment variables from `.env.example` in Render's dashboard (never commit `.env`).
4. Put the service URL in the extension popup's **Server URL**.

On the free tier the service sleeps after inactivity, so the first request after a pause can take a while.

## Troubleshooting

| Message | Likely cause |
| --- | --- |
| *No API token set* | Enter the token in the popup and press Save |
| *The server rejected your API token* | The popup's token doesn't match the server's `TRANSLATOR_API_KEY` |
| *Cannot reach the server at …* | Server isn't running, wrong URL, or (on Render) it's waking up |
| *The AI service rejected this server's credentials* | The server's TAMUS AI key is wrong, expired or revoked |
| *Rate limit exceeded* | You hit `RATE_LIMIT_PER_MIN`. The extension retries by itself; raise the limit if it's too tight |
| *No translatable images found* | Scroll so lazy-loaded images actually load, then try again |
