(() => {
  if (document.body.dataset.itClicker) return;
  document.body.dataset.itClicker = "1";

  const MIN_SIZE = 50;
  const HIGHLIGHT = "3px dashed #38bdf8";
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
      return c.toDataURL("image/jpeg", 0.85);
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
        resolve(c.toDataURL("image/jpeg", 0.85));
      };
      shot.onerror = () => resolve(null);
      shot.src = screenshotDataUrl;
    });
  }

  async function captureVisiblePortion(img) {
    const canvasUrl = imgToDataUrl(img);
    if (canvasUrl) {
      console.log("[IT] canvas capture (full image)");
      return canvasUrl;
    }

    const imgRect = img.getBoundingClientRect();
    const visLeft = Math.max(0, imgRect.left);
    const visTop = Math.max(0, imgRect.top);
    const visRight = Math.min(window.innerWidth, imgRect.right);
    const visBottom = Math.min(window.innerHeight, imgRect.bottom);

    if (visRight <= visLeft || visBottom <= visTop) throw new Error("Image not visible");

    const dpr = window.devicePixelRatio || 1;
    const captureResp = await sendMessage({ type: "capture-tab" });
    if (!captureResp?.ok) throw new Error("Tab capture failed");

    const cropped = await cropFromScreenshot(
      captureResp.dataUrl,
      { left: visLeft, top: visTop, width: visRight - visLeft, height: visBottom - visTop },
      dpr
    );
    if (!cropped) throw new Error("Screenshot crop empty");

    console.log("[IT] screenshot capture OK");
    return cropped;
  }

  // --- Overlay: numbered list panel ---

  const AUTO_DISMISS_MS = 8000;
  let activePanel = null;
  let dismissTimer = null;

  function removeActivePanel() {
    clearTimeout(dismissTimer);
    if (activePanel) { activePanel.remove(); activePanel = null; }
  }

  function scheduleDismiss(panel) {
    clearTimeout(dismissTimer);
    dismissTimer = setTimeout(() => {
      if (activePanel === panel) { panel.remove(); activePanel = null; }
    }, AUTO_DISMISS_MS);
  }

  function createPanel(img, bubbles) {
    removeActivePanel();

    const panel = document.createElement("div");
    panel.className = OVERLAY_CLASS + "-panel";
    Object.assign(panel.style, {
      position: "fixed",
      top: "10px",
      right: "10px",
      maxWidth: "380px",
      maxHeight: "80vh",
      overflowY: "auto",
      background: "rgba(15, 23, 42, 0.93)",
      color: "#f1f5f9",
      fontFamily: "system-ui, -apple-system, sans-serif",
      fontSize: "14px",
      lineHeight: "1.5",
      padding: "14px 16px",
      borderRadius: "12px",
      boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
      zIndex: "2147483647",
      pointerEvents: "auto",
      transition: "opacity 0.3s ease"
    });

    panel.addEventListener("mouseenter", () => clearTimeout(dismissTimer));
    panel.addEventListener("mouseleave", () => scheduleDismiss(panel));

    const header = document.createElement("div");
    Object.assign(header.style, {
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      marginBottom: "10px",
      paddingBottom: "8px",
      borderBottom: "1px solid rgba(255,255,255,0.15)"
    });

    const title = document.createElement("span");
    title.textContent = `Translation (${bubbles.length} bubble${bubbles.length > 1 ? "s" : ""})`;
    Object.assign(title.style, { fontWeight: "700", fontSize: "13px", color: "#94a3b8" });

    const closeBtn = document.createElement("button");
    closeBtn.textContent = "X";
    Object.assign(closeBtn.style, {
      background: "rgba(255,255,255,0.1)",
      border: "none",
      color: "#f1f5f9",
      cursor: "pointer",
      borderRadius: "6px",
      padding: "2px 8px",
      fontSize: "13px",
      fontWeight: "700"
    });
    closeBtn.addEventListener("click", () => removeActivePanel());

    header.appendChild(title);
    header.appendChild(closeBtn);
    panel.appendChild(header);

    for (let i = 0; i < bubbles.length; i++) {
      const b = bubbles[i];
      const row = document.createElement("div");
      Object.assign(row.style, {
        marginBottom: i < bubbles.length - 1 ? "10px" : "0",
        paddingBottom: i < bubbles.length - 1 ? "10px" : "0",
        borderBottom: i < bubbles.length - 1 ? "1px solid rgba(255,255,255,0.08)" : "none"
      });

      const num = document.createElement("span");
      num.textContent = `${i + 1}. `;
      Object.assign(num.style, { fontWeight: "700", color: "#38bdf8" });

      const text = document.createElement("span");
      text.textContent = b.text;

      row.appendChild(num);
      row.appendChild(text);

      if (b.original) {
        const orig = document.createElement("div");
        orig.textContent = b.original;
        Object.assign(orig.style, {
          fontSize: "11px",
          color: "#64748b",
          marginTop: "3px",
          fontStyle: "italic"
        });
        row.appendChild(orig);
      }

      panel.appendChild(row);
    }

    document.body.appendChild(panel);
    activePanel = panel;
    scheduleDismiss(panel);
    return panel;
  }

  function showLoading(img) {
    const dot = document.createElement("div");
    dot.className = OVERLAY_CLASS + "-loading";
    Object.assign(dot.style, {
      position: "fixed",
      top: "10px",
      right: "10px",
      background: "rgba(15,23,42,0.9)",
      color: "#38bdf8",
      fontFamily: "system-ui, sans-serif",
      fontSize: "13px",
      fontWeight: "700",
      padding: "8px 16px",
      borderRadius: "10px",
      zIndex: "2147483647",
      pointerEvents: "none",
      boxShadow: "0 4px 16px rgba(0,0,0,0.3)"
    });
    dot.textContent = "Translating…";
    document.body.appendChild(dot);
    return dot;
  }

  // --- Main translation flow ---

  async function translateImage(img, serverUrl, targetLang) {
    const loader = showLoading(img);
    try {
      const dataUrl = await captureVisiblePortion(img);

      const resp = await sendMessage({
        type: "vision-translate-bubbles",
        serverUrl,
        imageBase64: dataUrl,
        target_lang: targetLang
      });

      if (resp?.ok && Array.isArray(resp.data?.bubbles) && resp.data.bubbles.length > 0) {
        createPanel(img, resp.data.bubbles);
        console.log(`[IT] translated ${resp.data.bubbles.length} bubbles`);
        return;
      }

      if (resp?.ok && resp.data?.raw_text) {
        createPanel(img, [{ text: resp.data.raw_text, original: "" }]);
        return;
      }

      console.warn("[IT] no data, trying fallback endpoint");
      const fallback = await sendMessage({
        type: "vision-translate",
        serverUrl,
        imageBase64: dataUrl,
        target_lang: targetLang
      });
      if (!fallback?.ok) throw new Error(fallback?.error || "Translate failed");
      const text = fallback.data?.translated_text || fallback.data?.extracted_text || "";
      if (text) createPanel(img, [{ text, original: fallback.data?.extracted_text || "" }]);
    } catch (err) {
      console.error("[IT] translate failed", img.src?.slice(0, 80), err.message);
    } finally {
      loader?.remove();
    }
  }

  // --- Init ---

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

    console.log(`[IT] Click mode: ${imgs.length} images highlighted.`);

    for (const img of imgs) {
      img.style.outline = HIGHLIGHT;
      img.style.cursor = "pointer";
      img.dataset.itClickable = "1";

      let busy = false;
      const handler = async (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (busy) return;
        busy = true;
        await translateImage(img, serverUrl, targetLang);
        busy = false;
      };

      img.addEventListener("click", handler, true);
    }
  }

  run();
})();
