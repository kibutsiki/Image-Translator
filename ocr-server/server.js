import "dotenv/config";
import express from "express";

const app = express();
const PORT = process.env.PORT || 3000;

// Parse JSON payloads from the extension
app.use(express.json({ limit: "15mb" }));

// Health check
app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// --- TAMU AI helpers (reuse your existing AI backend) ---

function requireTamu() {
  const endpoint = process.env.TAMUS_AI_CHAT_API_ENDPOINT;
  const apiKey = process.env.TAMUS_AI_CHAT_API_KEY;
  if (!endpoint || !apiKey) {
    throw new Error("Missing TAMUS_AI_CHAT_API_ENDPOINT or TAMUS_AI_CHAT_API_KEY");
  }
  return { endpoint: endpoint.replace(/\/+$/, ""), apiKey };
}

async function tamuChatCompletions(messages) {
  const { endpoint, apiKey } = requireTamu();

  const payload = {
    model: "protected.gemini-2.0-flash-lite",
    stream: false,
    messages
  };

  const startedAt = Date.now();
  const resp = await fetch(`${endpoint}/api/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(`TAMU upstream error ${resp.status}: ${JSON.stringify(data)}`);
  }

  const out = data.choices?.[0]?.message?.content;
  if (!out) {
    throw new Error("TAMU response missing choices[0].message.content");
  }
  return {
    content: out,
    upstream: {
      model: data.model || payload.model,
      usage: data.usage || null,
      latency_ms: Date.now() - startedAt
    }
  };
}

function logUpstreamResult(tag, result) {
  const model = result?.upstream?.model || "unknown";
  const usage = result?.upstream?.usage || null;
  const text = String(result?.content || "");
  const preview = text.length > 400 ? `${text.slice(0, 400)}…` : text;

  console.log(`[${tag}] model=${model}`);
  if (usage) {
    console.log(`[${tag}] tokens prompt=${usage.prompt_tokens} completion=${usage.completion_tokens} total=${usage.total_tokens}`);
  } else {
    console.log(`[${tag}] tokens usage not provided by upstream`);
  }
  console.log(`[${tag}] message:\n${preview}\n---`);
}

async function tamuTranslate(text, targetLang) {
  return tamuChatCompletions([
    {
      role: "system",
      content:
        `Translate the user's text to ${targetLang}. ` +
        "Preserve line breaks and punctuation. Return only the translation."
    },
    { role: "user", content: text }
  ]);
}

// --- Routes ---

function parseDataUrl(dataUrl) {
  const match = String(dataUrl || "").match(/^data:([^;]+);base64,(.*)$/);
  if (!match) return null;
  return { mimeType: match[1], base64: match[2] };
}

async function tamuVisionExtractFromBase64(base64, mimeType) {
  return tamuChatCompletions([
    {
      role: "system",
      content: "Extract all readable text from this image. Return only the text, no commentary."
    },
    {
      role: "user",
      content: [
        {
          type: "image_url",
          image_url: { url: `data:${mimeType};base64,${base64}` }
        }
      ]
    }
  ]);
}

async function tamuVisionExtractBubbles(base64, mimeType) {
  return tamuChatCompletions([
    {
      role: "system",
      content:
        "You read manga/comic images. Find every speech bubble and text box in this panel.\n" +
        "Return ONLY the text from speech bubbles, in reading order (top to bottom, right to left for manga).\n" +
        "Separate each bubble's text with the exact delimiter: ---BUBBLE---\n" +
        "Ignore sound effects, decorative text, and watermarks.\n" +
        "Return the original text exactly as written. Do NOT translate.\n" +
        "If no speech bubbles found, return nothing."
    },
    {
      role: "user",
      content: [
        {
          type: "image_url",
          image_url: { url: `data:${mimeType};base64,${base64}` }
        }
      ]
    }
  ]);
}

// Text-only translation endpoint used by the extension.
// Body: { text: string, target_lang?: string }
// Default language is English ("en") if not provided.
app.post("/translate-text", async (req, res) => {
  const { text, target_lang } = req.body || {};
  const lang = (target_lang || "en").trim();

  if (!text) {
    return res.status(400).json({ error: "text is required" });
  }

  try {
    const result = await tamuTranslate(text, lang);
    logUpstreamResult("translate-text", result);
    return res.json({
      translated_text: result.content,
      target_lang: lang,
      meta: {
        input_chars: String(text).length,
        upstream: result.upstream
      }
    });
  } catch (err) {
    console.error("[/translate-text] error", err);
    return res.status(500).json({
      error: err.message || "Translation failed"
    });
  }
});

// Vision OCR + translate endpoint (recommended for better extraction).
// Body: { imageBase64: string (data URL), target_lang?: string }
app.post("/vision-translate", async (req, res) => {
  const { imageBase64, target_lang } = req.body || {};
  const lang = (target_lang || "en").trim();

  const parsed = parseDataUrl(imageBase64);
  if (!parsed) {
    return res.status(400).json({ error: "imageBase64 must be a data URL like data:image/png;base64,..." });
  }

  const startedAt = Date.now();
  try {
    const extractResult = await tamuVisionExtractFromBase64(parsed.base64, parsed.mimeType);
    logUpstreamResult("vision-extract", extractResult);
    const extracted_text = extractResult.content || "";

    const translateResult = extracted_text ? await tamuTranslate(extracted_text, lang) : null;
    if (translateResult) logUpstreamResult("vision-translate", translateResult);
    const translated_text = translateResult?.content || "";

    return res.json({
      extracted_text,
      translated_text,
      target_lang: lang,
      meta: {
        mimeType: parsed.mimeType,
        extracted_chars: extracted_text.length,
        translated_chars: translated_text.length,
        total_latency_ms: Date.now() - startedAt,
        upstream: {
          extract: extractResult.upstream,
          translate: translateResult?.upstream || null
        }
      }
    });
  } catch (err) {
    console.error("[/vision-translate] error", err);
    return res.status(500).json({ error: err.message || "Vision translate failed" });
  }
});

// Vision extract + translate endpoint.
// Step 1: vision model reads all speech bubble text (no coordinates).
// Step 2: text-only model translates all bubble texts in one batch call.
app.post("/vision-translate-bubbles", async (req, res) => {
  const { imageBase64, target_lang } = req.body || {};
  const lang = (target_lang || "en").trim();

  const parsed = parseDataUrl(imageBase64);
  if (!parsed) {
    return res.status(400).json({ error: "imageBase64 must be a data URL like data:image/png;base64,..." });
  }

  const startedAt = Date.now();
  try {
    const extractResult = await tamuVisionExtractBubbles(parsed.base64, parsed.mimeType);
    logUpstreamResult("vision-extract-bubbles", extractResult);

    const rawText = (extractResult.content || "").trim();
    if (!rawText) {
      return res.json({
        bubbles: [],
        target_lang: lang,
        meta: { total_latency_ms: Date.now() - startedAt, upstream: { extract: extractResult.upstream } }
      });
    }

    const originals = rawText.split(/---BUBBLE---/).map((s) => s.trim()).filter(Boolean);

    if (originals.length === 0) {
      return res.json({
        bubbles: [],
        target_lang: lang,
        meta: { total_latency_ms: Date.now() - startedAt, upstream: { extract: extractResult.upstream } }
      });
    }

    const SEPARATOR = "\n---BUBBLE---\n";
    const translateResult = await tamuTranslate(originals.join(SEPARATOR), lang);
    logUpstreamResult("bubble-translate", translateResult);

    const translated = (translateResult.content || "").split(/---BUBBLE---/).map((s) => s.trim());

    const bubbles = originals.map((orig, i) => ({
      original: orig,
      text: translated[i] || orig
    }));

    return res.json({
      bubbles,
      target_lang: lang,
      meta: {
        mimeType: parsed.mimeType,
        bubble_count: bubbles.length,
        total_latency_ms: Date.now() - startedAt,
        upstream: {
          extract: extractResult.upstream,
          translate: translateResult.upstream
        }
      }
    });
  } catch (err) {
    console.error("[/vision-translate-bubbles] error", err);
    return res.status(500).json({ error: err.message || "Vision bubble translate failed" });
  }
});

app.listen(PORT, () => {
  console.log(`Listening on port ${PORT}`);
});