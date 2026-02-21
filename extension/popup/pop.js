const WORKER_BASE_URL = "https://image-translator-worker.hiep-qqnguyen.workers.dev";
const OCR_LANGUAGE = "eng+kor+jpn";

const translateButton = document.getElementById("Translate-Id");
const languageSelect = document.getElementById("language-Id");
const statusEl = document.getElementById("status-Id");
const ocrChip = document.getElementById("ocr-Id");
const previewEl = document.getElementById("preview-Id");
const ocrTextEl = document.getElementById("ocrText-Id");
const translatedTextEl = document.getElementById("translatedText-Id");

const sessionId = (crypto.randomUUID && crypto.randomUUID()) || String(Date.now());

const setStatus = (text) => {
  statusEl.textContent = text;
};

const setOcrChip = (text) => {
  ocrChip.textContent = text;
};

const setPreviewImage = (dataUrl) => {
  previewEl.innerHTML = "";
  const img = document.createElement("img");
  img.alt = "Captured screenshot";
  img.src = dataUrl;
  previewEl.appendChild(img);
};

const validateWorkerUrl = () => {
  if (!WORKER_BASE_URL || WORKER_BASE_URL.includes("your-worker-name")) {
    throw new Error("Update WORKER_BASE_URL in pop.js with your Cloudflare Worker URL.");
  }
};

translateButton.addEventListener("click", async () => {
  translateButton.disabled = true;
  setStatus("Capturing the current tab...");
  setOcrChip("OCR idle");
  ocrTextEl.value = "";
  translatedTextEl.value = "";

  try {
    validateWorkerUrl();

    const dataUrl = await chrome.tabs.captureVisibleTab({ format: "png" });
    if (!dataUrl) {
      throw new Error("Capture failed. Try again.");
    }
    setPreviewImage(dataUrl);

    setStatus("Running OCR locally...");
    const ocrResult = await Tesseract.recognize(dataUrl, OCR_LANGUAGE, {
      workerPath: chrome.runtime.getURL("popup/vendor/tesseract/worker.min.js"),
      corePath: chrome.runtime.getURL("popup/vendor/tesseract-core/tesseract-core.wasm.js"),
      langPath: chrome.runtime.getURL("popup/vendor/tesseract-lang"),
      logger: (message) => {
        if (message.status === "recognizing text") {
          const pct = Math.round((message.progress || 0) * 100);
          setOcrChip(`OCR ${pct}%`);
        }
      }
    });

    const extractedText = (ocrResult.data.text || "").trim();
    setOcrChip(extractedText ? "OCR done" : "OCR empty");
    ocrTextEl.value = extractedText || "No text detected.";

    if (!extractedText) {
      setStatus("No text found in the capture.");
      return;
    }

    setStatus("Sending text to the translator...");
    const response = await fetch(`${WORKER_BASE_URL}/translate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        text: extractedText,
        targetLang: languageSelect.value,
        sessionId
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Translation failed (${response.status}): ${errText}`);
    }

    const data = await response.json();
    translatedTextEl.value = data.translatedText || "No translation returned.";
    setStatus("Translation complete.");
  } catch (error) {
    console.error(error);
    setStatus(error.message || "Something went wrong.");
  } finally {
    translateButton.disabled = false;
  }
});