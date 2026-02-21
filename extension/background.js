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

  if (message.type === "fetch-image") {
    (async () => {
      try {
        const response = await fetch(message.url, { credentials: "omit" });
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
