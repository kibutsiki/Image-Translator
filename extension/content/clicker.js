// "Click to translate": outlines the page's images; clicking one translates just that image.
(() => {
  const IT = window.__IT;
  if (!IT) return;

  const HIGHLIGHT = "3px dashed #38bdf8";
  const images = IT.candidateImages().filter((img) => !img.dataset.itClickable);

  if (images.length === 0) {
    const already = document.querySelector("img[data-it-clickable]");
    IT.toast(
      already
        ? "Click mode is already on. Click an outlined image to translate it."
        : "No translatable images found on this page. Scroll down so images load, then try again."
    );
    return;
  }

  for (const img of images) {
    img.dataset.itClickable = "1";
    img.style.outline = HIGHLIGHT;
    img.style.cursor = "pointer";

    img.addEventListener(
      "click",
      async (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (img.dataset.itBusy) return;
        img.dataset.itBusy = "1";
        const loader = IT.showLoading(img, "fixed");
        try {
          const bubbles = await IT.translateImage(img);
          if (bubbles.length > 0) IT.showPanel(img, bubbles, "fixed");
          else IT.toast("No speech bubbles found in this image.");
        } catch (err) {
          console.warn("[Image Translator] translate failed", err.message);
          IT.toast(err.message, "error");
        } finally {
          loader.remove();
          delete img.dataset.itBusy;
        }
      },
      true
    );
  }

  IT.toast(`Click mode on: ${images.length} image${images.length === 1 ? "" : "s"} outlined. Click one to translate it.`);
})();
