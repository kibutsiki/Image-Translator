(() => {
  if (window.__imageTranslatorOverlayLoaded) {
    return;
  }
  window.__imageTranslatorOverlayLoaded = true;

  console.log("[OCR Setup] Initializing Image Translator overlay");

const OCR_LANGUAGE = "eng+kor+jpn";
const OVERLAY_ID = "img-translator-overlay-root";

const IMAGE_LOAD_TIMEOUT_MS = 3000;
const MIN_NATURAL_WIDTH = 400;
const MIN_NATURAL_HEIGHT = 200;
const MIN_NATURAL_AREA = 80000;
const MIN_RENDER_SIZE = 20;
const MIN_LINE_SIZE = 5;
const MIN_OCR_WIDTH = 600;
const MAX_OCR_WIDTH = 2000;
const BLOCKED_DOMAINS = [
  "addthis.com",
  "eyeota.net"
];
const SELECTION_MIN_SIZE = 60;

const getOverlayRoot = () => {
  let root = document.getElementById(OVERLAY_ID);
  if (root) {
    return root;
  }

  root = document.createElement("div");
  root.id = OVERLAY_ID;
  root.style.position = "absolute";
  root.style.left = "0";
  root.style.top = "0";
  root.style.width = "100%";
  root.style.height = "100%";
  root.style.pointerEvents = "none";
  root.style.zIndex = "2147483647";
  document.body.appendChild(root);
  return root;
};

const waitForImage = (img) => {
  if (img.complete && img.naturalWidth > 0) {
    return Promise.resolve(true);
  }
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      cleanup();
      resolve(false);
    }, IMAGE_LOAD_TIMEOUT_MS);

    const onLoad = () => {
      cleanup();
      resolve(true);
    };
    const onError = () => {
      cleanup();
      reject(new Error("Image failed to load"));
    };
    const cleanup = () => {
      clearTimeout(timeoutId);
      img.removeEventListener("load", onLoad);
      img.removeEventListener("error", onError);
    };
    img.addEventListener("load", onLoad);
    img.addEventListener("error", onError);
  });
};

const buildOverlayBox = (root, rect, text) => {
  const box = document.createElement("div");
  box.textContent = text;
  box.style.position = "absolute";
  box.style.left = `${rect.left}px`;
  box.style.top = `${rect.top}px`;
  box.style.width = `${rect.width}px`;
  box.style.height = `${rect.height}px`;
  box.style.background = "rgba(255, 255, 255, 0.88)";
  box.style.color = "#111827";
  box.style.fontFamily = "Arial, sans-serif";
  box.style.fontSize = `${Math.max(10, rect.height * 0.8)}px`;
  box.style.lineHeight = `${Math.max(10, rect.height * 0.9)}px`;
  box.style.padding = "1px 2px";
  box.style.boxSizing = "border-box";
  box.style.overflow = "hidden";
  box.style.borderRadius = "2px";
  root.appendChild(box);
};

const createSelectionLayer = () => {
  const layer = document.createElement("div");
  layer.style.position = "fixed";
  layer.style.left = "0";
  layer.style.top = "0";
  layer.style.width = "100%";
  layer.style.height = "100%";
  layer.style.zIndex = "2147483647";
  layer.style.cursor = "crosshair";
  layer.style.background = "rgba(15, 23, 42, 0.15)";
  layer.style.userSelect = "none";
  layer.style.pointerEvents = "auto";
  return layer;
};

const selectRegion = () => new Promise((resolve, reject) => {
  const layer = createSelectionLayer();
  const box = document.createElement("div");
  box.style.position = "absolute";
  box.style.border = "2px solid #38bdf8";
  box.style.background = "rgba(56, 189, 248, 0.15)";
  box.style.pointerEvents = "none";
  layer.appendChild(box);
  document.body.appendChild(layer);

  let startX = 0;
  let startY = 0;
  let dragging = false;

  const cleanup = () => {
    document.removeEventListener("keydown", onKeyDown);
    layer.removeEventListener("mousedown", onMouseDown);
    layer.removeEventListener("mousemove", onMouseMove);
    layer.removeEventListener("mouseup", onMouseUp);
    layer.remove();
  };

  const onKeyDown = (event) => {
    if (event.key === "Escape") {
      cleanup();
      reject(new Error("Selection canceled."));
    }
  };

  const onMouseDown = (event) => {
    dragging = true;
    startX = event.clientX;
    startY = event.clientY;
    box.style.left = `${startX}px`;
    box.style.top = `${startY}px`;
    box.style.width = "0px";
    box.style.height = "0px";
  };

  const onMouseMove = (event) => {
    if (!dragging) {
      return;
    }
    const currentX = event.clientX;
    const currentY = event.clientY;
    const left = Math.min(startX, currentX);
    const top = Math.min(startY, currentY);
    const width = Math.abs(currentX - startX);
    const height = Math.abs(currentY - startY);
    box.style.left = `${left}px`;
    box.style.top = `${top}px`;
    box.style.width = `${width}px`;
    box.style.height = `${height}px`;
  };

  const onMouseUp = (event) => {
    dragging = false;
    const endX = event.clientX;
    const endY = event.clientY;
    const left = Math.min(startX, endX);
    const top = Math.min(startY, endY);
    const width = Math.abs(endX - startX);
    const height = Math.abs(endY - startY);
    cleanup();

    if (width < SELECTION_MIN_SIZE || height < SELECTION_MIN_SIZE) {
      reject(new Error("Selection too small."));
      return;
    }

    resolve({ left, top, width, height });
  };

  document.addEventListener("keydown", onKeyDown);
  layer.addEventListener("mousedown", onMouseDown);
  layer.addEventListener("mousemove", onMouseMove);
  layer.addEventListener("mouseup", onMouseUp);
});

const isGifImage = (img) => {
  const src = (img.currentSrc || img.src || "").toLowerCase();
  return /(^data:image\/gif)|((\.|\/)gif($|[?#]))/.test(src);
};

const isSvgImage = (img) => {
  const src = (img.currentSrc || img.src || "").toLowerCase();
  return /(^data:image\/svg)|((\.|\/)svg($|[?#]))/.test(src);
};

const isBlockedDomain = (src) => {
  try {
    const url = new URL(src, window.location.href);
    return BLOCKED_DOMAINS.some((domain) => url.hostname.endsWith(domain));
  } catch (error) {
    return false;
  }
};

const isCrossOriginImage = (img) => {
  try {
    const src = img.currentSrc || img.src || "";
    if (!src) {
      return false;
    }
    const url = new URL(src, window.location.href);
    return url.origin !== window.location.origin;
  } catch (error) {
    return false;
  }
};

const fetchImageDataUrl = (url) => new Promise((resolve, reject) => {
  chrome.runtime.sendMessage({ type: "fetch-image", url }, (response) => {
    if (chrome.runtime.lastError) {
      reject(new Error(chrome.runtime.lastError.message));
      return;
    }
    if (!response || !response.ok) {
      reject(new Error((response && response.error) || "Failed to fetch image"));
      return;
    }
    resolve(response.dataUrl);
  });
});

const loadImageFromDataUrl = (dataUrl) => new Promise((resolve, reject) => {
  const image = new Image();
  image.onload = () => resolve(image);
  image.onerror = () => reject(new Error("Failed to load fetched image"));
  image.src = dataUrl;
});

const captureVisibleTab = () => new Promise((resolve, reject) => {
  const timeoutId = setTimeout(() => {
    reject(new Error("Capture timed out."));
  }, 15000);

  chrome.runtime.sendMessage({ type: "capture-tab" }, (response) => {
    clearTimeout(timeoutId);
    if (chrome.runtime.lastError) {
      reject(new Error(chrome.runtime.lastError.message));
      return;
    }
    if (!response || !response.ok) {
      reject(new Error((response && response.error) || "Capture failed"));
      return;
    }
    resolve(response.dataUrl);
  });
});

const ensureTesseractLoaded = () => new Promise((resolve, reject) => {
  if (typeof Tesseract !== "undefined") {
    console.log("[OCR] Tesseract already loaded");
    resolve();
    return;
  }

  console.log("[OCR] Dynamically loading Tesseract...");
  const script = document.createElement("script");
  script.src = chrome.runtime.getURL("popup/vendor/tesseract/tesseract.min.js");
  script.onload = () => {
    console.log("[OCR] Tesseract loaded successfully");
    resolve();
  };
  script.onerror = () => {
    reject(new Error("Failed to load Tesseract.js"));
  };
  document.head.appendChild(script);
});

const cropCapture = async (rect, screenshotDataUrl) => {
  const dataUrl = screenshotDataUrl || await captureVisibleTab();
  const image = await loadImageFromDataUrl(dataUrl);
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const scaleX = image.width / viewportWidth;
  const scaleY = image.height / viewportHeight;

  const sx = Math.max(0, Math.round(rect.left * scaleX));
  const sy = Math.max(0, Math.round(rect.top * scaleY));
  const sw = Math.min(image.width - sx, Math.round(rect.width * scaleX));
  const sh = Math.min(image.height - sy, Math.round(rect.height * scaleY));

  if (sw <= 0 || sh <= 0) {
    throw new Error("Selection is out of bounds.");
  }

  const canvas = document.createElement("canvas");
  canvas.width = sw;
  canvas.height = sh;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(image, sx, sy, sw, sh, 0, 0, sw, sh);
  return { canvas, scaleX, scaleY };
};


const getSourceSize = (source) => {
  const width = source.naturalWidth || source.width || 0;
  const height = source.naturalHeight || source.height || 0;
  return { width, height };
};

const createOcrSource = (img) => {
  const { width: naturalWidth, height: naturalHeight } = getSourceSize(img);
  let scale = 1;

  if (naturalWidth < MIN_OCR_WIDTH) {
    scale = MIN_OCR_WIDTH / naturalWidth;
  } else if (naturalWidth > MAX_OCR_WIDTH) {
    scale = MAX_OCR_WIDTH / naturalWidth;
  }

  if (scale === 1 || naturalWidth === 0 || naturalHeight === 0) {
    return { source: img, width: naturalWidth, height: naturalHeight };
  }

  const canvas = document.createElement("canvas");
  canvas.width = Math.round(naturalWidth * scale);
  canvas.height = Math.round(naturalHeight * scale);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  try {
    ctx.getImageData(0, 0, 1, 1);
  } catch (error) {
    return { source: img, width: naturalWidth, height: naturalHeight };
  }

  return { source: canvas, width: canvas.width, height: canvas.height };
};

const cleanOCRText = (text) => {
  if (!text) return "";
  
  // Split into lines and clean each
  const lines = text.split("\n");
  const cleaned = lines
    .map(line => {
      // Remove lines that are mostly gibberish (non-ASCII characters)
      const asciiChars = (line.match(/[\x20-\x7E]/g) || []).length;
      const totalChars = line.trim().length;
      
      // If less than 30% ASCII, likely gibberish
      if (totalChars > 0 && asciiChars / totalChars < 0.3) {
        console.log("[OCR] Filtered gibberish line:", line);
        return null;
      }
      
      // Keep the line but remove excessive non-ASCII
      return line.replace(/[^\x20-\x7E\n]/g, "").trim();
    })
    .filter(line => line && line.length > 1)
    .join("\n");
  
  return cleaned;
};

const runSelectionOcr = async (screenshotDataUrl) => {

  let rect;
  try {
    rect = await selectRegion();
    console.log("[OCR] Region selected:", rect);
  } catch (error) {
    throw new Error(`Region selection failed: ${error.message || error}`);
  }

  await new Promise((resolve) => setTimeout(resolve, 100));

  let capture;
  try {
    capture = await cropCapture(rect, screenshotDataUrl);
    console.log("[OCR] Capture cropped:", { width: capture.canvas.width, height: capture.canvas.height });
  } catch (error) {
    throw new Error(`Capture cropping failed: ${error.message || error}`);
  }

  const ocrSource = createOcrSource(capture.canvas);
  console.log("[OCR] Source prepared:", { width: ocrSource.width, height: ocrSource.height });

  // Ensure Tesseract is loaded
  await ensureTesseractLoaded();

  let ocrResult;
  try {
    if (typeof Tesseract === "undefined") {
      throw new Error("Tesseract failed to load. Please reload the page and try again.");
    }

    const workerPath = chrome.runtime.getURL("popup/vendor/tesseract/worker.min.js");
    const corePath = chrome.runtime.getURL("popup/vendor/tesseract-core/tesseract-core.wasm.js");
    const langPath = chrome.runtime.getURL("popup/vendor/tesseract-lang");

    console.log("[OCR] Tesseract paths resolved:", { workerPath, corePath, langPath });

    if (!workerPath || !corePath || !langPath) {
      throw new Error("Tesseract paths not found. Check extension installation.");
    }

    console.log("[OCR] Starting Tesseract recognition with languages:", OCR_LANGUAGE);
    ocrResult = await Tesseract.recognize(ocrSource.source, OCR_LANGUAGE, {
      workerPath: workerPath,
      corePath: corePath,
      langPath: langPath,
      logger: (m) => {
        // Only log significant progress milestones
        if (m.status === "recognizing text") {
          const progress = Math.round(m.progress * 100);
          if (progress % 25 === 0 || progress === 100) {
            console.log(`[Tesseract] ${m.status}: ${progress}%`);
          }
        } else {
          console.log("[Tesseract]", m.status);
        }
      }
    });
    console.log("[OCR] Tesseract recognition completed");
  } catch (error) {
    console.error("[OCR] Tesseract error:", error);
    throw new Error(`OCR failed: ${error.message || error}. Make sure Tesseract files are loaded.`);
  }

  if (!ocrResult || !ocrResult.data) {
    throw new Error("OCR returned no data.");
  }

  console.log("[OCR] Full OCR result confidence:", ocrResult.data.confidence);
  console.log("[OCR] Full result structure:", { 
    lines: ocrResult.data.lines?.length || 0,
    paragraphs: ocrResult.data.paragraphs?.length || 0,
    words: ocrResult.data.words?.length || 0,
    text: ocrResult.data.text?.substring(0, 100) || "N/A"
  });

  // Try to extract text from multiple sources
  let extractedText = "";
  let lineCount = 0;

  // First, try to get text from lines (most reliable)
  const lines = (ocrResult.data.lines || []).filter((line) => line.text && line.text.trim());
  console.log("[OCR] Raw lines detected:", lines.length);
  
  if (lines.length > 0) {
    console.log("[OCR] Sample lines:", lines.slice(0, 3).map(l => ({ text: l.text, confidence: l.confidence })));
    
    const filteredLines = [];
    for (const line of lines) {
      const lineWidth = line.bbox.x1 - line.bbox.x0;
      const lineHeight = line.bbox.y1 - line.bbox.y0;
      if (lineWidth < MIN_LINE_SIZE || lineHeight < MIN_LINE_SIZE) {
        continue;
      }
      filteredLines.push(line.text.trim());
    }
    
    if (filteredLines.length > 0) {
      extractedText = filteredLines.join("\n");
      lineCount = filteredLines.length;
      console.log("[OCR] Extracted from lines:", { lines: lineCount, text: extractedText });
    }
  }

  // If no lines found but Tesseract has confidence, try words
  if (extractedText === "" && ocrResult.data.confidence > 20) {
    console.log("[OCR] No lines found, trying word extraction...");
    const words = (ocrResult.data.words || []).filter((word) => word.text && word.text.trim());
    console.log("[OCR] Words detected:", words.length);
    
    if (words.length > 0) {
      console.log("[OCR] Sample words:", words.slice(0, 10).map(w => w.text));
      const wordText = words.map(w => w.text.trim()).filter(t => t.length > 1).join(" ");
      if (wordText) {
        extractedText = wordText;
        lineCount = words.length;
        console.log("[OCR] Extracted from words:", { wordCount: lineCount });
      }
    }
  }

  // Fallback: use full text if available
  if (extractedText === "" && ocrResult.data.text) {
    console.log("[OCR] Using full OCR text as fallback...");
    extractedText = ocrResult.data.text.trim();
    
    // Clean the text to remove gibberish
    extractedText = cleanOCRText(extractedText);
    console.log("[OCR] Text after cleaning:", extractedText);
    
    lineCount = extractedText.split("\n").filter(l => l.trim()).length;
    console.log("[OCR] Extracted from full text:", { lines: lineCount });
  }

  console.log("[OCR] Final extracted text:", { lines: lineCount, preview: extractedText.substring(0, 100) });

  return {
    lines: lineCount,
    text: extractedText
  };
};

const runDataUrlOcr = async (dataUrl) => {
  console.log("[OCR] Starting data URL OCR");
  
  if (!dataUrl) {
    throw new Error("No image data provided.");
  }

  // Ensure Tesseract is loaded
  await ensureTesseractLoaded();

  if (typeof Tesseract === "undefined") {
    throw new Error("Tesseract failed to load. Please reload the page and try again.");
  }

  const workerPath = chrome.runtime.getURL("popup/vendor/tesseract/worker.min.js");
  const corePath = chrome.runtime.getURL("popup/vendor/tesseract-core/tesseract-core.wasm.js");
  const langPath = chrome.runtime.getURL("popup/vendor/tesseract-lang");

  console.log("[OCR] Tesseract paths resolved:", { workerPath, corePath, langPath });
  console.log("[OCR] Starting Tesseract recognition with languages:", OCR_LANGUAGE);

  const ocrResult = await Tesseract.recognize(dataUrl, OCR_LANGUAGE, {
    workerPath: workerPath,
    corePath: corePath,
    langPath: langPath,
    logger: (m) => {
      // Only log significant progress milestones
      if (m.status === "recognizing text") {
        const progress = Math.round(m.progress * 100);
        if (progress % 25 === 0 || progress === 100) {
          console.log(`[Tesseract] ${m.status}: ${progress}%`);
        }
      } else {
        console.log("[Tesseract]", m.status);
      }
    }
  });

  console.log("[OCR] Tesseract recognition completed");

  if (!ocrResult || !ocrResult.data) {
    throw new Error("OCR returned no data.");
  }

  console.log("[OCR] Full OCR result confidence:", ocrResult.data.confidence);
  console.log("[OCR] Full result structure:", { 
    lines: ocrResult.data.lines?.length || 0,
    paragraphs: ocrResult.data.paragraphs?.length || 0,
    words: ocrResult.data.words?.length || 0,
    text: ocrResult.data.text?.substring(0, 100) || "N/A"
  });

  // Try to extract text from multiple sources
  let extractedText = "";
  let lineCount = 0;

  // First, try to get text from lines (most reliable)
  const lines = (ocrResult.data.lines || []).filter((line) => line.text && line.text.trim());
  console.log("[OCR] Raw lines detected:", lines.length);
  
  if (lines.length > 0) {
    console.log("[OCR] Sample lines:", lines.slice(0, 3).map(l => ({ text: l.text, confidence: l.confidence })));
    
    const filteredLines = [];
    for (const line of lines) {
      const lineWidth = line.bbox.x1 - line.bbox.x0;
      const lineHeight = line.bbox.y1 - line.bbox.y0;
      if (lineWidth < MIN_LINE_SIZE || lineHeight < MIN_LINE_SIZE) {
        continue;
      }
      filteredLines.push(line.text.trim());
    }
    
    if (filteredLines.length > 0) {
      extractedText = filteredLines.join("\n");
      lineCount = filteredLines.length;
      console.log("[OCR] Extracted from lines:", { lines: lineCount, text: extractedText });
    }
  }

  // If no lines found but Tesseract has confidence, try words
  if (extractedText === "" && ocrResult.data.confidence > 20) {
    console.log("[OCR] No lines found, trying word extraction...");
    const words = (ocrResult.data.words || []).filter((word) => word.text && word.text.trim());
    console.log("[OCR] Words detected:", words.length);
    
    if (words.length > 0) {
      console.log("[OCR] Sample words:", words.slice(0, 10).map(w => w.text));
      const wordText = words.map(w => w.text.trim()).filter(t => t.length > 1).join(" ");
      if (wordText) {
        extractedText = wordText;
        lineCount = words.length;
        console.log("[OCR] Extracted from words:", { wordCount: lineCount });
      }
    }
  }

  // Fallback: use full text if available
  if (extractedText === "" && ocrResult.data.text) {
    console.log("[OCR] Using full OCR text as fallback...");
    extractedText = ocrResult.data.text.trim();
    
    // Clean the text to remove gibberish
    extractedText = cleanOCRText(extractedText);
    console.log("[OCR] Text after cleaning:", extractedText);
    
    lineCount = extractedText.split("\n").filter(l => l.trim()).length;
    console.log("[OCR] Extracted from full text:", { lines: lineCount });
  }

  console.log("[OCR] Final extracted text:", { lines: lineCount, preview: extractedText.substring(0, 100) });

  return {
    lines: lineCount,
    text: extractedText
  };
};

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message && message.type === "ping") {
      sendResponse({ ok: true });
      return false;
    }
    if (message && message.type === "select-region") {
      console.log("[Message] Received select-region request");
      runSelectionOcr(message.screenshotDataUrl)
        .then((result) => {
          console.log("[Message] select-region completed successfully:", result);
          sendResponse({ ok: true, ...result });
        })
        .catch((error) => {
          console.error("[Message] select-region failed:", error);
          sendResponse({ ok: false, error: error.message || String(error) });
        });
      return true;
    }
    if (message && message.type === "ocr-data-url") {
      console.log("[Message] Received ocr-data-url request");
      runDataUrlOcr(message.dataUrl)
        .then((result) => {
          console.log("[Message] ocr-data-url completed successfully:", result);
          sendResponse({ ok: true, ...result });
        })
        .catch((error) => {
          console.error("[Message] ocr-data-url failed:", error);
          sendResponse({ ok: false, error: error.message || String(error) });
        });
      return true;
    }
    return false;
  });
})();
