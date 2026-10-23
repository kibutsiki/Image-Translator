import "dotenv/config";
import crypto from "node:crypto";
import express from "express";


const env = process.env;

function positiveInt(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const PORT = env.PORT === "0" ? 0 : positiveInt(env.PORT, 3000);

// Shared secret the extension must send as "Authorization: Bearer <key>".
const APP_KEY = env.TRANSLATOR_API_KEY || "";

// TAMUS AI chat endpoint (OpenAI-compatible).
const TAMU_ENDPOINT = (env.TAMUS_AI_CHAT_API_ENDPOINT || "").replace(/\/+$/, "");
const TAMU_KEY = env.TAMUS_AI_CHAT_API_KEY || "";
const TAMU_MODEL = "protected.gemini-2.5-flash-lite";

const PER_MIN = positiveInt(env.RATE_LIMIT_PER_MIN, 30);
const PER_DAY = positiveInt(env.RATE_LIMIT_PER_DAY, 1500);
const UPSTREAM_CONCURRENCY = positiveInt(env.UPSTREAM_CONCURRENCY, 4);
const UPSTREAM_TIMEOUT_MS = positiveInt(env.UPSTREAM_TIMEOUT_MS, 45000);

const MAX_TEXT_CHARS = 10_000;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // decoded size
const ALLOWED_MIME = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

const PROVIDER = TAMU_ENDPOINT && TAMU_KEY ? "tamu" : null;

if (!APP_KEY || APP_KEY.length < 16) {
  console.error(
    "Refusing to start: set TRANSLATOR_API_KEY to a random string of at least 16 characters.\n" +
      "Generate one with:  node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\""
  );
  process.exit(1);
}
if (!PROVIDER) {
  console.error(
    "Refusing to start: configure the TAMUS AI provider. Set both " +
      "TAMUS_AI_CHAT_API_ENDPOINT and TAMUS_AI_CHAT_API_KEY."
  );
  process.exit(1);
}

// ───────────────────────── small helpers ─────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest();
const APP_KEY_DIGEST = sha256(APP_KEY);

const LANGUAGES = {
  en: "English", vi: "Vietnamese", ja: "Japanese", ko: "Korean", fr: "French",
  de: "German", es: "Spanish", pt: "Portuguese", it: "Italian", ru: "Russian",
  zh: "Chinese", id: "Indonesian", th: "Thai", ar: "Arabic"
};

/** Returns a language name for the prompt, or null if the code looks invalid. */
function resolveLanguage(input) {
  const code = String(input ?? "en").trim();
  if (!/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(code)) return null;
  return LANGUAGES[code.toLowerCase()] || code;
}

function parseDataUrl(dataUrl) {
  const m = /^data:([a-z]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\r\n]+)$/i.exec(String(dataUrl || ""));
  if (!m) return { error: "imageBase64 must be a base64 data URL like data:image/png;base64,..." };
  const mime = m[1].toLowerCase();
  if (!ALLOWED_MIME.has(mime)) return { error: `Unsupported image type ${mime}. Use PNG, JPEG, WebP or GIF.` };
  const base64 = m[2].replace(/\s+/g, "");
  if (Math.floor((base64.length * 3) / 4) > MAX_IMAGE_BYTES) {
    return { error: `Image too large (max ${MAX_IMAGE_BYTES / (1024 * 1024)} MB).`, status: 413 };
  }
  return { mime, base64 };
}

// Sliding-window rate limiter: allows at most `limit` hits per key in any `windowMs` span.
// In-memory, so limits reset when the server restarts and are per server instance.
class WindowLimiter {
  constructor(windowMs, limit) {
    this.windowMs = windowMs;
    this.limit = limit;
    this.hits = new Map(); // key -> ascending list of hit timestamps
    setInterval(() => this.sweep(), 60_000).unref();
  }
  recent(key, now) {
    const list = this.hits.get(key) || [];
    const cutoff = now - this.windowMs;
    let i = 0;
    while (i < list.length && list[i] <= cutoff) i++;
    if (i > 0) list.splice(0, i);
    if (list.length === 0) this.hits.delete(key);
    else this.hits.set(key, list);
    return list;
  }
  /** Is this key currently over the limit? Does not record a hit. */
  status(key, now = Date.now()) {
    const list = this.recent(key, now);
    if (list.length >= this.limit) {
      return { blocked: true, retryAfter: Math.max(1, Math.ceil((list[0] + this.windowMs - now) / 1000)) };
    }
    return { blocked: false, remaining: this.limit - list.length };
  }
  hit(key, now = Date.now()) {
    const list = this.recent(key, now);
    list.push(now);
    this.hits.set(key, list);
  }
  /** Check the limit and, if allowed, record the hit. */
  consume(key, now = Date.now()) {
    const s = this.status(key, now);
    if (!s.blocked) this.hit(key, now);
    return s;
  }
  sweep(now = Date.now()) {
    for (const key of [...this.hits.keys()]) this.recent(key, now);
  }
}

// Limits how many requests we have in flight to the upstream AI service.
class Semaphore {
  constructor(n) { this.free = n; this.waiters = []; }
  async run(fn) {
    if (this.free > 0) this.free--;
    else await new Promise((resolve) => this.waiters.push(resolve));
    try {
      return await fn();
    } finally {
      const next = this.waiters.shift();
      if (next) next(); else this.free++;
    }
  }
}
const upstreamSlots = new Semaphore(UPSTREAM_CONCURRENCY);

// ───────────────────────── upstream AI providers ─────────────────────────

class UpstreamError extends Error {
  constructor(httpStatus, publicMessage, { retryable = false, retryAfter = 0, detail = "" } = {}) {
    super(publicMessage);
    this.httpStatus = httpStatus;
    this.retryable = retryable;
    this.retryAfter = retryAfter;
    this.detail = detail;
  }
}

function errorFromStatus(status, retryAfterHeader, detail) {
  const retryAfter = Number.parseInt(retryAfterHeader, 10) || 0;
  if (status === 401 || status === 403) {
    return new UpstreamError(502, "The AI service rejected this server's credentials. Check the server's API key.", { detail });
  }
  if (status === 429) {
    return new UpstreamError(503, "The AI service is rate limiting requests. Try again shortly.", { retryable: true, retryAfter: retryAfter || 5, detail });
  }
  if (status >= 500) {
    return new UpstreamError(502, "The AI service had an error.", { retryable: true, detail });
  }
  return new UpstreamError(502, "The AI service rejected the request.", { detail });
}

async function postJson(url, headers, body) {
  let resp;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
    });
  } catch (err) {
    const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError";
    throw new UpstreamError(timedOut ? 504 : 502, timedOut ? "The AI service timed out." : "Could not reach the AI service.", {
      retryable: true,
      detail: String(err?.message || err)
    });
  }
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw errorFromStatus(resp.status, resp.headers.get("retry-after"), JSON.stringify(data).slice(0, 500));
  }
  return data;
}

async function tamuChat({ system, text, image }) {
  const userContent = image
    ? [{ type: "text", text }, { type: "image_url", image_url: { url: `data:${image.mime};base64,${image.base64}` } }]
    : text;
  const data = await postJson(
    `${TAMU_ENDPOINT}/api/chat/completions`,
    { Authorization: `Bearer ${TAMU_KEY}` },
    {
      model: TAMU_MODEL,
      stream: false,
      messages: [{ role: "system", content: system }, { role: "user", content: userContent }]
    }
  );
  const out = String(data.choices?.[0]?.message?.content || "").trim();
  if (!out) throw new UpstreamError(502, "The AI service returned an empty response.", { retryable: true });
  return out;
}

async function chat(args) {
  const call = () => tamuChat(args);
  return upstreamSlots.run(async () => {
    try {
      return await call();
    } catch (err) {
      if (err instanceof UpstreamError && err.retryable) {
        await sleep(Math.min(err.retryAfter * 1000 || 1000, 3000));
        return call();
      }
      throw err;
    }
  });
}

// ───────────────────────── translation tasks ─────────────────────────

async function translateText(text, languageName) {
  return chat({
    system:
      `Translate the user's text into ${languageName}. Preserve line breaks and punctuation. ` +
      "Return only the translation, with no commentary.",
    text
  });
}

function bubblePrompt(languageName) {
  return (
    "You read manga, manhwa and comic pages. Find every speech bubble and dialogue text box in the image, " +
    "in reading order (top to bottom; right to left for manga). Ignore sound effects, watermarks and decorative text. " +
    `Translate each bubble into ${languageName}. ` +
    'Respond with ONLY JSON in this exact shape: {"bubbles":[{"original":"<text as written>","translation":"<translation>"}]}. ' +
    'If there are no speech bubbles, respond with {"bubbles":[]}.'
  );
}

/** Pulls a JSON object out of a model reply, tolerating ```json fences and stray prose. */
function parseBubbles(raw) {
  const cleaned = String(raw).replace(/```(?:json)?/gi, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  const candidate = start >= 0 && end > start ? cleaned.slice(start, end + 1) : cleaned;
  let parsed;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    throw new UpstreamError(502, "The AI service returned an unreadable response.", { retryable: false, detail: cleaned.slice(0, 200) });
  }
  const list = Array.isArray(parsed) ? parsed : parsed?.bubbles;
  if (!Array.isArray(list)) {
    throw new UpstreamError(502, "The AI service returned an unreadable response.", { detail: "missing bubbles array" });
  }
  return list
    .map((b) => ({
      original: String(b?.original ?? "").trim(),
      text: String(b?.translation ?? b?.text ?? "").trim()
    }))
    .filter((b) => b.text);
}

// ───────────────────────── express app ─────────────────────────

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", env.TRUST_PROXY ?? (env.RENDER ? "1" : "0"));
app.use(express.json({ limit: "15mb" }));

app.use((req, res, next) => {
  const started = Date.now();
  res.on("finish", () => console.log(`${req.method} ${req.path} ${res.statusCode} ${Date.now() - started}ms`));
  next();
});

function tooManyRequests(res, retryAfter, message) {
  res.set("Retry-After", String(retryAfter));
  return res.status(429).json({ error: message, retry_after_s: retryAfter });
}

// Limits are tracked per client IP (req.ip; set TRUST_PROXY when behind a proxy).
const authFailures = new WindowLimiter(15 * 60 * 1000, 20);
const perMinute = new WindowLimiter(60 * 1000, PER_MIN);
const perDay = new WindowLimiter(24 * 60 * 60 * 1000, PER_DAY);

// A client that keeps sending wrong tokens is locked out for the rest of the window.
function rejectIfLockedOut(req, res, next) {
  const s = authFailures.status(req.ip);
  if (s.blocked) return tooManyRequests(res, s.retryAfter, "Too many failed authentication attempts. Try again later.");
  next();
}

function authenticate(req, res, next) {
  const m = /^Bearer\s+(.+)$/i.exec(req.get("authorization") || "");
  const ok = m && crypto.timingSafeEqual(sha256(m[1].trim()), APP_KEY_DIGEST);
  if (!ok) {
    authFailures.hit(req.ip);
    return res.status(401).json({ error: "Missing or invalid API token." });
  }
  next();
}

function enforceRateLimits(req, res, next) {
  const minute = perMinute.consume(req.ip);
  if (minute.blocked) {
    return tooManyRequests(res, minute.retryAfter, `Rate limit exceeded (${PER_MIN} requests per minute). Slow down and retry.`);
  }
  const day = perDay.consume(req.ip);
  if (day.blocked) {
    return tooManyRequests(res, day.retryAfter, `Daily request limit reached (${PER_DAY} per day).`);
  }
  res.set("X-RateLimit-Remaining", String(minute.remaining - 1));
  next();
}

const protect = [rejectIfLockedOut, authenticate, enforceRateLimits];
const wrap = (fn) => (req, res, next) => fn(req, res).catch(next);

app.get("/health", (_req, res) => res.json({ ok: true, provider: PROVIDER }));

// Lets the extension's "Test connection" button verify the token without spending AI quota.
app.get("/auth-check", rejectIfLockedOut, authenticate, (_req, res) => res.json({ ok: true }));

// Body: { text, target_lang? }
app.post("/translate-text", ...protect, wrap(async (req, res) => {
  const { text, target_lang } = req.body || {};
  if (typeof text !== "string" || !text.trim()) return res.status(400).json({ error: "text is required." });
  if (text.length > MAX_TEXT_CHARS) return res.status(413).json({ error: `text is too long (max ${MAX_TEXT_CHARS} characters).` });
  const language = resolveLanguage(target_lang);
  if (!language) return res.status(400).json({ error: "target_lang must be a language code like en, ja or ko." });

  const translated = await translateText(text, language);
  res.json({ translated_text: translated, target_lang: String(target_lang ?? "en").trim() });
}));

// Body: { imageBase64: data URL, target_lang? }
// One model call finds the speech bubbles and translates them, in reading order.
app.post("/vision-translate-bubbles", ...protect, wrap(async (req, res) => {
  const { imageBase64, target_lang } = req.body || {};
  const language = resolveLanguage(target_lang);
  if (!language) return res.status(400).json({ error: "target_lang must be a language code like en, ja or ko." });
  const image = parseDataUrl(imageBase64);
  if (image.error) return res.status(image.status || 400).json({ error: image.error });

  const started = Date.now();
  const raw = await chat({
    system: bubblePrompt(language),
    text: "Translate the speech bubbles in this image.",
    image,
    json: true
  });
  const bubbles = parseBubbles(raw);
  res.json({
    bubbles,
    target_lang: String(target_lang ?? "en").trim(),
    meta: { bubble_count: bubbles.length, latency_ms: Date.now() - started }
  });
}));

app.use((_req, res) => res.status(404).json({ error: "Not found." }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  if (err?.type === "entity.too.large") return res.status(413).json({ error: "Request body too large." });
  if (err?.type === "entity.parse.failed") return res.status(400).json({ error: "Request body must be valid JSON." });
  if (err instanceof UpstreamError) {
    console.error(`[upstream] ${req.path} -> ${err.httpStatus}: ${err.message} ${err.detail}`);
    if (err.retryAfter) res.set("Retry-After", String(err.retryAfter));
    return res.status(err.httpStatus).json({ error: err.message, ...(err.retryAfter ? { retry_after_s: err.retryAfter } : {}) });
  }
  console.error(`[error] ${req.path}`, err);
  res.status(500).json({ error: "Internal server error." });
});

const server = app.listen(PORT, () => {
  console.log(`Listening on port ${server.address().port} (provider: ${PROVIDER}, ${PER_MIN} req/min per IP)`);
});
