// Service worker: talks to the translation server and does the cross-origin work
// that content scripts can't. Settings live in chrome.storage.local:
//   serverUrl, apiToken, targetLang

const DEFAULTS = { serverUrl: "http://localhost:3000", apiToken: "", targetLang: "en" };
const REQUEST_TIMEOUT_MS = 90_000;
const MAX_ATTEMPTS = 3;          // initial try + retries when the server says 429
const MAX_WAIT_S = 30;           // never wait longer than this between retries

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getSettings() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULTS));
  const serverUrl = String(stored.serverUrl || DEFAULTS.serverUrl).trim().replace(/\/+$/, "");
  return {
    serverUrl,
    apiToken: String(stored.apiToken || "").trim(),
    targetLang: String(stored.targetLang || DEFAULTS.targetLang).trim() || "en"
  };
}

function describeHttpError(status, data) {
  const serverMsg = data && typeof data.error === "string" ? data.error : "";
  if (status === 401) return "The server rejected your API token. Check it in the extension popup.";
  if (status === 429) return serverMsg || "Rate limit reached. Try again in a moment.";
  return serverMsg ? `Server error ${status}: ${serverMsg}` : `Server error ${status}`;
}

/** Calls the translation server, retrying politely when it answers 429 (rate limited). */
async function callServer(path, { method = "POST", body } = {}) {
  const { serverUrl, apiToken } = await getSettings();
  if (!apiToken) throw new Error("No API token set. Open the extension popup and paste your token.");

  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let resp;
    try {
      resp = await fetch(`${serverUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${apiToken}`,
          ...(body ? { "Content-Type": "application/json" } : {})
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
    } catch (err) {
      const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError";
      throw new Error(
        timedOut
          ? "The server took too long to respond."
          : `Cannot reach the server at ${serverUrl}. Is it running, and is the URL correct?`
      );
    }

    const data = await resp.json().catch(() => ({}));
    if (resp.ok) return data;

    lastError = new Error(describeHttpError(resp.status, data));
    const retriable = resp.status === 429 || resp.status === 503;
    if (!retriable || attempt === MAX_ATTEMPTS) break;

    const headerWait = Number.parseInt(resp.headers.get("retry-after") || "", 10);
    const waitS = Math.min(MAX_WAIT_S, headerWait || data.retry_after_s || 5);
    await sleep(waitS * 1000);
  }
  throw lastError;
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

// ── Referer rules (for hotlink-protected image hosts) ──
let nextRuleId = 1;

/** Makes the next extension-initiated requests to this image's host carry the page as Referer. */
async function addRefererRule(imageUrl, referer) {
  if (!referer || !chrome.declarativeNetRequest?.updateSessionRules) return 0;
  let host;
  try { host = new URL(imageUrl).hostname; } catch { return 0; }
  const id = nextRuleId++;
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      addRules: [{
        id,
        priority: 1,
        action: { type: "modifyHeaders", requestHeaders: [{ header: "referer", operation: "set", value: referer }] },
        // tabIds -1 = requests that don't come from a tab, i.e. this service worker's own fetches
        condition: { requestDomains: [host], resourceTypes: ["xmlhttprequest"], tabIds: [-1] }
      }]
    });
    return id;
  } catch (err) {
    console.warn("[Image Translator] could not set Referer for", host, err?.message);
    return 0;
  }
}

async function removeRule(id) {
  try { await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [id] }); } catch { /* already gone */ }
}

const handlers = {
  async "translate-image"(message) {
    if (!message.imageBase64) throw new Error("Missing image data");
    const { targetLang } = await getSettings();
    const data = await callServer("/vision-translate-bubbles", {
      body: { imageBase64: message.imageBase64, target_lang: targetLang }
    });
    return { bubbles: Array.isArray(data.bubbles) ? data.bubbles : [] };
  },

  // Popup "Test connection": checks the server is up and the token is accepted.
  async "test-connection"() {
    const { serverUrl } = await getSettings();
    let health;
    try {
      health = await fetch(`${serverUrl}/health`, { signal: AbortSignal.timeout(10_000) });
    } catch {
      throw new Error(`Cannot reach the server at ${serverUrl}. Is it running, and is the URL correct?`);
    }
    if (!health.ok) throw new Error(`Server answered ${health.status} at ${serverUrl}/health`);
    await callServer("/auth-check", { method: "GET" });
    return { message: "Connected. Server is up and your token works." };
  },

  // Fetch the image from inside the page (keeps the page's cookies / referer).
  async "fetch-image-page"(message, sender) {
    const tabId = sender.tab?.id;
    if (!tabId) throw new Error("No tab context");
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: async (imageUrl) => {
        const resp = await fetch(imageUrl, { credentials: "include" });
        if (!resp.ok) throw new Error("fetch " + resp.status);
        const blob = await resp.blob();
        return new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(new Error("read failed"));
          reader.readAsDataURL(blob);
        });
      },
      args: [message.url]
    });
    const dataUrl = results?.[0]?.result;
    if (!dataUrl) throw new Error("No result from page world");
    return { dataUrl };
  },

  // Fetch the image from the extension (bypasses page CORS thanks to host permissions).
  // Many image hosts block "hotlinking": they return 403 unless the request carries the
  // page's Referer. fetch() can't set Referer itself, so a short-lived rule adds it.
  async "fetch-image"(message) {
    const ruleId = await addRefererRule(message.url, message.referer);
    try {
      const response = await fetch(message.url, { credentials: "omit", signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`Image fetch failed (${response.status})`);
      const contentType = (response.headers.get("content-type") || "image/png").split(";")[0];
      const base64 = arrayBufferToBase64(await response.arrayBuffer());
      return { dataUrl: `data:${contentType};base64,${base64}` };
    } finally {
      if (ruleId) await removeRule(ruleId);
    }
  },

  async "capture-tab"(_message, sender) {
    const dataUrl = await new Promise((resolve, reject) => {
      chrome.tabs.captureVisibleTab(sender.tab?.windowId, { format: "png" }, (url) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(url);
      });
    });
    return { dataUrl };
  },

  async "inject"(message) {
    const files = message.mode === "click" ? ["content/common.js", "content/clicker.js"] : ["content/common.js", "content/scanner.js"];
    await chrome.scripting.executeScript({ target: { tabId: message.tabId }, files });
    return {};
  }
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = message && handlers[message.type];
  if (!handler) return false;
  handler(message, sender)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
  return true; // keep the channel open for the async response
});
