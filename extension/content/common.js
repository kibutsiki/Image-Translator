// Shared helpers for scanner.js and clicker.js. Injected first; exposes window.__IT.
(() => {
  if (window.__IT) return;

  const MIN_SIZE = 50;           // ignore images smaller than this (icons, avatars)
  const MAX_TILE_WIDTH = 1600;   // downscale wide images before upload
  const MAX_TILES = 6;           // cap requests per image
  const JPEG_QUALITY = 0.85;

  // ── ad / junk filtering ──
  // Matches whole path/word tokens only, so ".../uploads/page1.jpg" is NOT mistaken for an ad.
  const AD_URL = /(^|[/._-])(ads?|adserver|doubleclick|googlesyndication|adservice|sponsors?|tracking|analytics|pixel|beacon)([/._?=&#-]|$)/i;
  const SKIP_EXT = /\.(gif|svg|ico)(\?|#|$)/i;
  const AD_SELECTORS = [
    "ins.adsbygoogle", "[id^='ad-']", "[id^='ads-']", "[id$='-ad']", "[id$='-ads']",
    "[class~='ad']", "[class~='ads']", "[class*='adsbygoogle']", "[class*='sponsor']"
  ].join(",");

  function isAdOrJunk(img) {
    const src = img.currentSrc || img.src || "";
    if (SKIP_EXT.test(src)) return true;
    if (AD_URL.test(src)) return true;
    return Boolean(img.closest(AD_SELECTORS));
  }

  function isVisible(el) {
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const r = el.getBoundingClientRect();
    return r.width >= MIN_SIZE && r.height >= MIN_SIZE;
  }

  /** Images worth translating: loaded, big enough, visible, not ads, not already done. */
  function candidateImages() {
    return [...document.images].filter(
      (img) =>
        !img.dataset.itDone &&
        img.complete &&
        (img.currentSrc || img.src) &&
        img.naturalWidth >= MIN_SIZE &&
        img.naturalHeight >= MIN_SIZE &&
        isVisible(img) &&
        !isAdOrJunk(img)
    );
  }

  function send(msg) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(msg, (resp) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        resolve(resp);
      });
    });
  }

  // ── image capture ──

  /**
   * Cuts a drawable source (img/canvas) into JPEG data URLs. Tall webtoon strips are sliced
   * into several tiles so the text stays readable instead of being shrunk to fit one request.
   * Throws a SecurityError if the source is cross-origin and taints the canvas.
   */
  function tilesFrom(source, width, height) {
    const sliceHeight = Math.max(1200, Math.round(width * 1.6));
    const count = Math.min(MAX_TILES, Math.max(1, Math.ceil(height / sliceHeight)));
    const tileHeight = Math.ceil(height / count);
    const scale = Math.min(1, MAX_TILE_WIDTH / width);
    const tiles = [];
    for (let i = 0; i < count; i++) {
      const sy = i * tileHeight;
      const sh = Math.min(tileHeight, height - sy);
      if (sh <= 0) break;
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(sh * scale));
      canvas.getContext("2d").drawImage(source, 0, sy, width, sh, 0, 0, canvas.width, canvas.height);
      tiles.push(canvas.toDataURL("image/jpeg", JPEG_QUALITY));
    }
    return tiles;
  }

  function loadImage(dataUrl) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("Could not decode the fetched image"));
      image.src = dataUrl;
    });
  }

  async function tilesFromDataUrl(dataUrl) {
    const image = await loadImage(dataUrl);
    return tilesFrom(image, image.naturalWidth, image.naturalHeight);
  }

  /** Visible-area screenshot crop. Last resort: only captures what is on screen. */
  async function tilesFromScreenshot(img) {
    const rect = img.getBoundingClientRect();
    const left = Math.max(0, rect.left);
    const top = Math.max(0, rect.top);
    const right = Math.min(window.innerWidth, rect.right);
    const bottom = Math.min(window.innerHeight, rect.bottom);
    if (right <= left || bottom <= top) throw new Error("Image is not visible on screen");
    const shot = await send({ type: "capture-tab" });
    if (!shot?.ok) throw new Error(shot?.error || "Screenshot failed");
    const image = await loadImage(shot.dataUrl);
    const dpr = window.devicePixelRatio || 1;
    const sx = Math.round(left * dpr);
    const sy = Math.round(top * dpr);
    const sw = Math.min(Math.round((right - left) * dpr), image.width - sx);
    const sh = Math.min(Math.round((bottom - top) * dpr), image.height - sy);
    if (sw <= 0 || sh <= 0) throw new Error("Screenshot crop was empty");
    const canvas = document.createElement("canvas");
    canvas.width = sw;
    canvas.height = sh;
    canvas.getContext("2d").drawImage(image, sx, sy, sw, sh, 0, 0, sw, sh);
    return [canvas.toDataURL("image/jpeg", JPEG_QUALITY)];
  }

  /** Tries each way of getting the pixels, from cheapest to most intrusive. */
  async function getImageTiles(img) {
    try {
      return tilesFrom(img, img.naturalWidth, img.naturalHeight); // works for same-origin / CORS-enabled images
    } catch { /* tainted canvas: fall through */ }

    const url = img.currentSrc || img.src;
    const failures = [];
    for (const type of ["fetch-image-page", "fetch-image"]) {
      try {
        const resp = await send({ type, url, referer: location.href });
        if (resp?.ok) return await tilesFromDataUrl(resp.dataUrl);
        failures.push(resp?.error || `${type} failed`);
      } catch (err) {
        failures.push(err.message);
      }
    }
    try {
      return await tilesFromScreenshot(img);
    } catch (err) {
      // Report why the image couldn't be downloaded, not just that the screenshot fallback failed.
      const reason = failures[failures.length - 1] || err.message;
      throw new Error(`Couldn't read this image (${reason}).`);
    }
  }

  /** Translates one image. Returns bubbles ([{original, text}]); throws if every tile failed. */
  async function translateImage(img) {
    const tiles = await getImageTiles(img);
    const bubbles = [];
    let firstError = null;
    let succeeded = 0;
    for (const imageBase64 of tiles) {
      const resp = await send({ type: "translate-image", imageBase64 });
      if (resp?.ok) {
        succeeded++;
        bubbles.push(...resp.bubbles);
      } else if (!firstError) {
        firstError = new Error(resp?.error || "Translation failed");
      }
    }
    if (succeeded === 0 && firstError) throw firstError;
    return bubbles;
  }

  // ── UI ──

  const AUTO_DISMISS_MS = 30_000;
  const FONT = "system-ui, -apple-system, 'Segoe UI', sans-serif";

  function style(el, css) {
    Object.assign(el.style, css);
    return el;
  }

  let toastEl = null;
  let toastTimer = null;
  /** One small message in the corner of the page. kind: "info" | "error" | "ok". */
  function toast(message, kind = "info") {
    toastEl?.remove();
    clearTimeout(toastTimer);
    const colors = { info: "#38bdf8", ok: "#4ade80", error: "#f87171" };
    toastEl = style(document.createElement("div"), {
      position: "fixed", bottom: "16px", right: "16px", maxWidth: "340px", zIndex: "2147483647",
      background: "rgba(15,23,42,0.96)", color: "#f1f5f9", fontFamily: FONT, fontSize: "13px",
      lineHeight: "1.4", padding: "10px 14px", borderRadius: "10px",
      borderLeft: `4px solid ${colors[kind] || colors.info}`, boxShadow: "0 6px 24px rgba(0,0,0,0.4)",
      cursor: "pointer"
    });
    toastEl.textContent = message;
    toastEl.addEventListener("click", () => toastEl?.remove());
    document.body.appendChild(toastEl);
    toastTimer = setTimeout(() => toastEl?.remove(), kind === "error" ? 12_000 : 6_000);
  }

  /**
   * Shows a numbered list of bubbles. placement "inline" pins it over the image;
   * "fixed" puts it in the top-right of the viewport. Text is set with textContent, never innerHTML.
   */
  function showPanel(img, bubbles, placement) {
    const inline = placement === "inline";
    const parent = img.parentElement;

    if (inline && parent) {
      parent.querySelector(":scope > .it-panel")?.remove();
      if (getComputedStyle(parent).position === "static") parent.style.position = "relative";
    } else {
      document.querySelectorAll("body > .it-panel").forEach((p) => p.remove());
    }

    const panel = style(document.createElement("div"), {
      position: inline ? "absolute" : "fixed",
      top: inline ? `${img.offsetTop || 0}px` : "10px",
      left: inline ? `${img.offsetLeft || 0}px` : "auto",
      right: inline ? "auto" : "10px",
      maxWidth: inline ? `${Math.min(img.offsetWidth || 360, 380)}px` : "380px",
      maxHeight: inline ? "300px" : "80vh",
      overflowY: "auto", background: "rgba(15,23,42,0.94)", color: "#f1f5f9", fontFamily: FONT,
      fontSize: inline ? "13px" : "14px", lineHeight: "1.5", padding: "12px 14px", borderRadius: "10px",
      boxShadow: "0 6px 24px rgba(0,0,0,0.4)", zIndex: "2147483646", boxSizing: "border-box"
    });
    panel.className = "it-panel";

    let timer = setTimeout(() => panel.remove(), AUTO_DISMISS_MS);
    panel.addEventListener("mouseenter", () => clearTimeout(timer));
    panel.addEventListener("mouseleave", () => { timer = setTimeout(() => panel.remove(), AUTO_DISMISS_MS); });

    const header = style(document.createElement("div"), {
      display: "flex", justifyContent: "space-between", alignItems: "center",
      marginBottom: "8px", paddingBottom: "6px", borderBottom: "1px solid rgba(255,255,255,0.15)"
    });
    const title = style(document.createElement("span"), { fontWeight: "700", fontSize: "12px", color: "#94a3b8" });
    title.textContent = `${bubbles.length} bubble${bubbles.length === 1 ? "" : "s"}`;
    const close = style(document.createElement("button"), {
      background: "rgba(255,255,255,0.1)", border: "none", color: "#f1f5f9", cursor: "pointer",
      borderRadius: "4px", padding: "1px 7px", fontSize: "12px", fontWeight: "700"
    });
    close.textContent = "×";
    close.setAttribute("aria-label", "Close translation");
    close.addEventListener("click", () => { clearTimeout(timer); panel.remove(); });
    header.append(title, close);
    panel.appendChild(header);

    bubbles.forEach((b, i) => {
      const last = i === bubbles.length - 1;
      const row = style(document.createElement("div"), {
        marginBottom: last ? "0" : "8px", paddingBottom: last ? "0" : "8px",
        borderBottom: last ? "none" : "1px solid rgba(255,255,255,0.08)"
      });
      const num = style(document.createElement("span"), { fontWeight: "700", color: "#38bdf8" });
      num.textContent = `${i + 1}. `;
      const text = document.createElement("span");
      text.textContent = b.text;
      row.append(num, text);
      if (b.original) {
        const orig = style(document.createElement("div"), {
          fontSize: "11px", color: "#64748b", marginTop: "2px", fontStyle: "italic"
        });
        orig.textContent = b.original;
        row.appendChild(orig);
      }
      panel.appendChild(row);
    });

    (inline && parent ? parent : document.body).appendChild(panel);
  }

  function showLoading(img, placement) {
    const inline = placement === "inline";
    const parent = img.parentElement;
    if (inline && parent && getComputedStyle(parent).position === "static") parent.style.position = "relative";
    const badge = style(document.createElement("div"), {
      position: inline ? "absolute" : "fixed",
      top: inline ? `${(img.offsetTop || 0) + 6}px` : "10px",
      left: inline ? `${(img.offsetLeft || 0) + 6}px` : "auto",
      right: inline ? "auto" : "10px",
      background: "rgba(15,23,42,0.9)", color: "#38bdf8", fontFamily: FONT, fontSize: "12px",
      fontWeight: "700", padding: "5px 11px", borderRadius: "8px", zIndex: "2147483647", pointerEvents: "none"
    });
    badge.className = "it-loading";
    badge.textContent = "Translating…";
    (inline && parent ? parent : document.body).appendChild(badge);
    return badge;
  }

  window.__IT = { candidateImages, translateImage, showPanel, showLoading, toast };
})();
