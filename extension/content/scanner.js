// "Scan all images": translates every qualifying image on the page, a couple at a time.
(async () => {
  const IT = window.__IT;
  if (!IT) return;
  if (document.documentElement.dataset.itScanning) {
    IT.toast("A scan is already running on this page.");
    return;
  }

  const CONCURRENCY = 2; // the server rate-limits per minute; stay gentle
  const images = IT.candidateImages();
  if (images.length === 0) {
    IT.toast("No translatable images found on this page. Scroll down so images load, then try again.");
    return;
  }

  document.documentElement.dataset.itScanning = "1";
  IT.toast(`Translating ${images.length} image${images.length === 1 ? "" : "s"}…`);

  const result = { translated: 0, noText: 0, failed: 0 };
  let firstError = "";
  let next = 0;

  async function worker() {
    while (next < images.length) {
      const img = images[next++];
      const loader = IT.showLoading(img, "inline");
      try {
        const bubbles = await IT.translateImage(img);
        img.dataset.itDone = "1"; // skip on later scans; failures stay eligible for retry
        if (bubbles.length > 0) {
          IT.showPanel(img, bubbles, "inline");
          result.translated++;
        } else {
          result.noText++;
        }
      } catch (err) {
        result.failed++;
        firstError ||= err.message;
        console.warn("[Image Translator] skipped", (img.currentSrc || img.src).slice(0, 80), err.message);
      } finally {
        loader.remove();
      }
    }
  }

  try {
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, images.length) }, worker));
  } finally {
    delete document.documentElement.dataset.itScanning;
  }

  const parts = [`${result.translated} translated`];
  if (result.noText) parts.push(`${result.noText} had no text`);
  if (result.failed) parts.push(`${result.failed} failed`);
  const summary = `Done: ${parts.join(", ")}.`;
  if (result.failed) IT.toast(`${summary} ${firstError}`, "error");
  else IT.toast(summary, "ok");
})();
