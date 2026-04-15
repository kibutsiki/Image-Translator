(() => {
  if (document.body.dataset.itScanned) return;
  document.body.dataset.itScanned = "1";

  const MIN_SIZE = 50;
  const OVERLAY_CLASS = "it-overlay";

  const AD_URL_PATTERNS = /ads?[\-._\/]|doubleclick|googlesyndication|adservice|banner|sponsor|tracking|analytics|pixel|beacon/i;
  const SKIP_EXTENSIONS = /\.(gif|svg|ico|webp)(\?|$)/i;
  const AD_SELECTORS = ["ins.adsbygoogle", "[id*='ad']", "[class*='ad-']", "[class*='banner']", "[class*='sponsor']", "iframe"];

  function isInsideAd(el) {
    for (const sel of AD_SELECTORS) {
      if (el.closest(sel)) return true;
    }
    return false;
  }

  function isAdOrJunk(img) {
    const src = img.src || "";
    if (SKIP_EXTENSIONS.test(src)) return true;
    if (AD_URL_PATTERNS.test(src)) return true;
    if (isInsideAd(img)) return true;
    return false;
  }

  function sendMessage(msg) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(msg, (resp) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        resolve(resp);
      });
    });
  }

  function isVisible(el) {
    if (!el.offsetParent && getComputedStyle(el).position !== "fixed") return false;
    const r = el.getBoundingClientRect();
    return r.width >= MIN_SIZE && r.height >= MIN_SIZE;
  }

  // --- Image capture ---

  function imgToDataUrl(img) {
    try {
      const c = document.createElement("canvas");
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      c.getContext("2d").drawImage(img, 0, 0);
      return c.toDataURL("image/png");
    } catch {
      return null;
    }
  }

  function cropFromScreenshot(screenshotDataUrl, rect, dpr) {
    return new Promise((resolve) => {
      const shot = new Image();
      shot.onload = () => {
        const sx = Math.max(0, Math.round(rect.left * dpr));
        const sy = Math.max(0, Math.round(rect.top * dpr));
        const sw = Math.min(Math.round(rect.width * dpr), shot.width - sx);
        const sh = Math.min(Math.round(rect.height * dpr), shot.height - sy);
        if (sw <= 0 || sh <= 0) { resolve(null); return; }
        const c = document.createElement("canvas");
        c.width = sw;
        c.height = sh;
        c.getContext("2d").drawImage(shot, sx, sy, sw, sh, 0, 0, sw, sh);
        resolve(c.toDataURL("image/png"));
      };
      shot.onerror = () => resolve(null);
      shot.src = screenshotDataUrl;
    });
  }

  async function getImageDataUrl(img) {
    const canvasUrl = imgToDataUrl(img);
    if (canvasUrl) return canvasUrl;

    try {
      const rect = img.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        const dpr = window.devicePixelRatio || 1;
        const captureResp = await sendMessage({ type: "capture-tab" });
        if (captureResp?.ok) {
          const cropped = await cropFromScreenshot(captureResp.dataUrl, rect, dpr);
          if (cropped) return cropped;
        }
      }
    } catch { /* fall through */ }

    const pageResp = await sendMessage({ type: "fetch-image-page", url: img.src });
    if (pageResp?.ok) return pageResp.dataUrl;

    const fetchResp = await sendMessage({
      type: "fetch-image",
      url: img.src,
      referer: location.href
    });
    if (!fetchResp?.ok) throw new Error(fetchResp?.error || "Image fetch failed");
    return fetchResp.dataUrl;
  }

  // --- Overlay: inline panel per image ---

  const AUTO_DISMISS_MS = 8000;

  function createPanel(img, bubbles) {
    const existing = img.parentElement?.querySelector(`.${OVERLAY_CLASS}-panel`);
    if (existing) existing.remove();

    const wrapper = img.parentElement;
    if (wrapper && getComputedStyle(wrapper).position === "static") {
      wrapper.style.position = "relative";
    }

    const panel = document.createElement("div");
    panel.className = OVERLAY_CLASS + "-panel";
    Object.assign(panel.style, {
      position: "absolute",
      top: (img.offsetTop || 0) + "px",
      left: (img.offsetLeft || 0) + "px",
      maxWidth: Math.min(img.offsetWidth || 360, 380) + "px",
      maxHeight: "300px",
      overflowY: "auto",
      background: "rgba(15, 23, 42, 0.93)",
      color: "#f1f5f9",
      fontFamily: "system-ui, -apple-system, sans-serif",
      fontSize: "13px",
      lineHeight: "1.4",
      padding: "10px 12px",
      borderRadius: "10px",
      boxShadow: "0 4px 20px rgba(0,0,0,0.35)",
      zIndex: "2147483646",
      pointerEvents: "auto",
      transition: "opacity 0.3s ease"
    });

    let timer = setTimeout(() => panel.remove(), AUTO_DISMISS_MS);
    panel.addEventListener("mouseenter", () => clearTimeout(timer));
    panel.addEventListener("mouseleave", () => {
      timer = setTimeout(() => panel.remove(), AUTO_DISMISS_MS);
    });

    const header = document.createElement("div");
    Object.assign(header.style, {
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      marginBottom: "8px",
      paddingBottom: "6px",
      borderBottom: "1px solid rgba(255,255,255,0.15)"
    });

    const title = document.createElement("span");
    title.textContent = `${bubbles.length} bubble${bubbles.length > 1 ? "s" : ""}`;
    Object.assign(title.style, { fontWeight: "700", fontSize: "12px", color: "#94a3b8" });

    const closeBtn = document.createElement("button");
    closeBtn.textContent = "X";
    Object.assign(closeBtn.style, {
      background: "rgba(255,255,255,0.1)",
      border: "none",
      color: "#f1f5f9",
      cursor: "pointer",
      borderRadius: "4px",
      padding: "1px 6px",
      fontSize: "12px",
      fontWeight: "700"
    });
    closeBtn.addEventListener("click", () => { clearTimeout(timer); panel.remove(); });

    header.appendChild(title);
    header.appendChild(closeBtn);
    panel.appendChild(header);

    for (let i = 0; i < bubbles.length; i++) {
      const b = bubbles[i];
      const row = document.createElement("div");
      Object.assign(row.style, {
        marginBottom: i < bubbles.length - 1 ? "8px" : "0",
        paddingBottom: i < bubbles.length - 1 ? "8px" : "0",
        borderBottom: i < bubbles.length - 1 ? "1px solid rgba(255,255,255,0.08)" : "none"
      });

      const num = document.createElement("span");
      num.textContent = `${i + 1}. `;
      Object.assign(num.style, { fontWeight: "700", color: "#38bdf8" });

      const text = document.createElement("span");
      text.textContent = b.text;

      row.appendChild(num);
      row.appendChild(text);
      panel.appendChild(row);
    }

    if (wrapper) {
      wrapper.appendChild(panel);
    } else {
      document.body.appendChild(panel);
    }
  }

  function showLoading(img) {
    const dot = document.createElement("div");
    dot.className = OVERLAY_CLASS + "-loading";
    Object.assign(dot.style, {
      position: "absolute",
      top: (img.offsetTop || 0) + 6 + "px",
      left: (img.offsetLeft || 0) + 6 + "px",
      background: "rgba(15, 23, 42, 0.85)",
      color: "#38bdf8",
      fontFamily: "system-ui, sans-serif",
      fontSize: "12px",
      fontWeight: "700",
      padding: "4px 10px",
      borderRadius: "8px",
      zIndex: "2147483647",
      pointerEvents: "none"
    });
    dot.textContent = "Translating…";

    const wrapper = img.parentElement;
    if (wrapper && getComputedStyle(wrapper).position === "static") {
      wrapper.style.position = "relative";
    }
    if (wrapper) wrapper.appendChild(dot);
    return dot;
  }

  // --- Main flow ---

  async function processImage(img, serverUrl, targetLang) {
    const loader = showLoading(img);
    try {
      const imageBase64 = await getImageDataUrl(img);

      const resp = await sendMessage({
        type: "vision-translate-bubbles",
        serverUrl,
        imageBase64,
        target_lang: targetLang
      });

      if (resp?.ok && Array.isArray(resp.data?.bubbles) && resp.data.bubbles.length > 0) {
        createPanel(img, resp.data.bubbles);
        return;
      }

      const fallback = await sendMessage({
        type: "vision-translate",
        serverUrl,
        imageBase64,
        target_lang: targetLang
      });
      if (!fallback?.ok) throw new Error(fallback?.error || "Translate failed");
      const text = fallback.data?.translated_text || fallback.data?.extracted_text || "";
      if (text) createPanel(img, [{ text, original: "" }]);
    } catch (err) {
      console.warn("[IT] skip", img.src?.slice(0, 80), err.message);
    } finally {
      loader?.remove();
    }
  }

  async function run() {
    const config = await chrome.storage.local.get(["scanServerUrl", "scanTargetLang"]);
    const serverUrl = config.scanServerUrl || "http://localhost:3000";
    const targetLang = config.scanTargetLang || "en";

    const imgs = [...document.querySelectorAll("img")].filter((img) => {
      if (!img.src || img.src.startsWith("data:")) return false;
      if (img.naturalWidth < MIN_SIZE || img.naturalHeight < MIN_SIZE) return false;
      if (!isVisible(img)) return false;
      if (isAdOrJunk(img)) return false;
      return true;
    });

    if (imgs.length === 0) {
      console.log("[IT] No qualifying images found.");
      return;
    }

    console.log(`[IT] Scanning ${imgs.length} images…`);

    const CONCURRENCY = 3;
    let idx = 0;
    async function next() {
      while (idx < imgs.length) {
        const img = imgs[idx++];
        await processImage(img, serverUrl, targetLang);
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, imgs.length) }, () => next()));
    console.log("[IT] Scan complete.");
  }

  run();
})();
