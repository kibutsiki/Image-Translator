const arrayBufferToBase64 = (buffer) => {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";

  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message) {
    return false;
  }

  // Proxy fetch to backend from extension context (avoids page CORS/mixed-content limits).
  if (message.type === "vision-translate") {
    (async () => {
      try {
        const { serverUrl, imageBase64, target_lang } = message;
        if (!serverUrl) throw new Error("Missing serverUrl");
        if (!imageBase64) throw new Error("Missing imageBase64");

        const resp = await fetch(`${serverUrl}/vision-translate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ imageBase64, target_lang })
        });

        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) {
          throw new Error(`Server error ${resp.status}: ${JSON.stringify(data)}`);
        }

        sendResponse({ ok: true, data });
      } catch (error) {
        sendResponse({ ok: false, error: error.message || String(error) });
      }
    })();

    return true;
  }

  if (message.type === "vision-translate-bubbles") {
    (async () => {
      try {
        const { serverUrl, imageBase64, target_lang } = message;
        if (!serverUrl) throw new Error("Missing serverUrl");
        if (!imageBase64) throw new Error("Missing imageBase64");

        const resp = await fetch(`${serverUrl}/vision-translate-bubbles`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ imageBase64, target_lang })
        });

        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) {
          throw new Error(`Server error ${resp.status}: ${JSON.stringify(data)}`);
        }

        sendResponse({ ok: true, data });
      } catch (error) {
        sendResponse({ ok: false, error: error.message || String(error) });
      }
    })();
    return true;
  }

  if (message.type === "fetch-image-page") {
    (async () => {
      try {
        const tabId = _sender.tab?.id;
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
        sendResponse({ ok: true, dataUrl });
      } catch (error) {
        sendResponse({ ok: false, error: error.message || String(error) });
      }
    })();
    return true;
  }

  if (message.type === "fetch-image") {
    (async () => {
      try {
        const headers = {};
        if (message.referer) headers["Referer"] = message.referer;

        const response = await fetch(message.url, { credentials: "omit", headers });
        if (!response.ok) {
          throw new Error(`Image fetch failed (${response.status})`);
        }

        const contentType = response.headers.get("content-type") || "image/png";
        const buffer = await response.arrayBuffer();
        const base64 = arrayBufferToBase64(buffer);
        const dataUrl = `data:${contentType};base64,${base64}`;

        sendResponse({ ok: true, dataUrl });
      } catch (error) {
        sendResponse({ ok: false, error: error.message || String(error) });
      }
    })();

    return true;
  }

  if (message.type === "inject-scanner") {
    const { tabId, serverUrl, target_lang } = message;
    (async () => {
      try {
        await chrome.storage.local.set({ scanServerUrl: serverUrl, scanTargetLang: target_lang });
        await chrome.scripting.executeScript({
          target: { tabId },
          files: ["content/scanner.js"]
        });
        sendResponse({ ok: true });
      } catch (error) {
        sendResponse({ ok: false, error: error.message || String(error) });
      }
    })();
    return true;
  }

  if (message.type === "inject-clicker") {
    const { tabId, serverUrl, target_lang } = message;
    (async () => {
      try {
        await chrome.storage.local.set({ scanServerUrl: serverUrl, scanTargetLang: target_lang });
        await chrome.scripting.executeScript({
          target: { tabId },
          files: ["content/clicker.js"]
        });
        sendResponse({ ok: true });
      } catch (error) {
        sendResponse({ ok: false, error: error.message || String(error) });
      }
    })();
    return true;
  }

  if (message.type === "capture-tab") {
    chrome.tabs.captureVisibleTab(
      _sender.tab ? _sender.tab.windowId : undefined,
      { format: "png" },
      (dataUrl) => {
        if (chrome.runtime.lastError) {
          sendResponse({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        sendResponse({ ok: true, dataUrl });
      }
    );  

    return true;
  }

  return false;
});
