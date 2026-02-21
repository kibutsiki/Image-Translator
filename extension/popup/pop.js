const translateButton = document.getElementById("Translate-Id");
const uploadInput = document.getElementById("upload-Id");
const uploadExtractButton = document.getElementById("Upload-Extract-Id");
const statusEl = document.getElementById("status-Id");
const ocrChip = document.getElementById("ocr-Id");
const previewEl = document.getElementById("preview-Id");
const ocrTextEl = document.getElementById("ocrText-Id");

// OCR Server Configuration
const OCR_SERVER_URL = localStorage.getItem("ocrServerUrl") || "http://localhost:3000";
console.log("[Config] OCR Server URL:", OCR_SERVER_URL);

// OCR Server API
const callOCRServer = async (imageBase64) => {
  try {
    console.log("[API] Calling OCR server...");
    const response = await fetch(`${OCR_SERVER_URL}/ocr`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        imageBase64,
        languages: "eng+kor+jpn"
      })
    });

    if (!response.ok) {
      throw new Error(`Server error: ${response.status}`);
    }

    const result = await response.json();
    console.log("[API] OCR result:", result);

    if (!result.success) {
      throw new Error(result.error || "OCR failed");
    }

    return {
      text: result.text,
      lines: result.text.split("\n").filter(l => l.trim()).length,
      confidence: result.confidence
    };
  } catch (error) {
    console.error("[API] Error:", error);
    throw new Error(`Server connection failed: ${error.message}. Make sure OCR server is running at ${OCR_SERVER_URL}`);
  }
};

// Storage functions
const saveOCRData = async (text, preview) => {
  try {
    const data = {
      ocrText: text,
      ocrTimestamp: Date.now()
    };
    
    // Only save preview if it exists
    if (preview) {
      data.ocrPreview = preview;
    }
    
    await chrome.storage.local.set(data);
    console.log("[Storage] OCR data saved successfully:", { textLength: text.length, hasPreview: !!preview });
  } catch (error) {
    console.error("[Storage] Failed to save:", error);
  }
};

const loadOCRData = async () => {
  try {
    const data = await chrome.storage.local.get(["ocrText", "ocrPreview"]);
    console.log("[Storage] Retrieved data:", { hasText: !!data.ocrText, hasPreview: !!data.ocrPreview, textLength: data.ocrText?.length || 0 });
    if (data.ocrText) {
      ocrTextEl.value = data.ocrText;
      if (data.ocrPreview) {
        renderPreview(data.ocrPreview);
      }
      console.log("[Storage] OCR data loaded successfully");
      return true;
    } else {
      console.log("[Storage] No saved OCR data found");
    }
  } catch (error) {
    console.error("[Storage] Failed to load:", error);
  }
  return false;
};

const clearOCRData = async () => {
  try {
    await chrome.storage.local.remove(["ocrText", "ocrPreview", "ocrTimestamp"]);
    console.log("[Storage] OCR data cleared");
  } catch (error) {
    console.error("[Storage] Failed to clear:", error);
  }
};

const setStatus = (text) => {
  statusEl.textContent = text;
};

const setOcrChip = (text) => {
  ocrChip.textContent = text;
};

const readFileAsDataUrl = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = () => reject(new Error("Failed to read the image file."));
  reader.readAsDataURL(file);
});

const renderPreview = (dataUrl) => {
  if (!previewEl) {
    return;
  }
  previewEl.innerHTML = "";
  const img = document.createElement("img");
  img.src = dataUrl;
  img.alt = "Preview";
  previewEl.appendChild(img);
};

const sendTabMessage = (tabId, payload) => new Promise((resolve, reject) => {
  chrome.tabs.sendMessage(tabId, payload, (response) => {
    if (chrome.runtime.lastError) {
      reject(new Error(chrome.runtime.lastError.message));
      return;
    }
    resolve(response);
  });
});

const ensureContentScript = async (tabId) => {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: [
        "popup/vendor/tesseract/tesseract.min.js",
        "content/overlay.js"
      ]
    });
  } catch (injectError) {
    throw new Error(`Cannot inject content script: ${injectError.message || injectError}`);
  }
};

const sendMessageWithRetry = async (tabId, payload) => {
  try {
    return await sendTabMessage(tabId, payload);
  } catch (error) {
    if (!String(error).includes("Receiving end does not exist")) {
      throw error;
    }
    await ensureContentScript(tabId);
    try {
      return await sendTabMessage(tabId, payload);
    } catch (retryError) {
      if (String(retryError).includes("Receiving end does not exist")) {
        throw new Error("Content script still missing. Reload extension and refresh the page.");
      }
      throw retryError;
    }
  }
};

translateButton.addEventListener("click", async () => {
  translateButton.disabled = true;
  uploadExtractButton.disabled = true;
  setStatus("Capturing the page...");
  setOcrChip("OCR idle");
  ocrTextEl.value = "";
  
  if (previewEl) {
    previewEl.innerHTML = "<span>Preparing capture...</span>";
  }

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) {
      throw new Error("No active tab found.");
    }
    if (tab.url && /^(chrome|edge|about|view-source|chrome-extension):/.test(tab.url)) {
      throw new Error("This page cannot be translated. Open a normal web page.");
    }

    const screenshotDataUrl = await Promise.race([
      chrome.tabs.captureVisibleTab({ format: "png" }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Capture timed out. Try again.")), 15000)
      )
    ]);
    if (!screenshotDataUrl) {
      throw new Error("Capture failed.");
    }

    // Display the screenshot in the preview
    if (previewEl) {
      previewEl.innerHTML = "";
      const img = document.createElement("img");
      img.src = screenshotDataUrl;
      img.alt = "Captured screenshot";
      previewEl.appendChild(img);
    }

    setStatus("Processing with OCR server...");
    setOcrChip("OCR running...");

    // Call OCR server
    const result = await callOCRServer(screenshotDataUrl);

    setOcrChip("OCR done");
    ocrTextEl.value = result.text || "No text detected.";
    setStatus(`Done. Lines detected: ${result.lines || 0} (Confidence: ${result.confidence}%)`);
    console.log("[Popup] Text extraction completed:", { lines: result.lines, confidence: result.confidence });
    
    // Save to storage
    await saveOCRData(result.text || "No text detected.", screenshotDataUrl);
  } catch (error) {
    console.error("[Popup] Capture & Extract error:", error);
    setOcrChip("OCR error");
    setStatus(error.message || "Something went wrong.");
    if (previewEl) {
      previewEl.innerHTML = "<span>Error occurred. Please try again.</span>";
    }
  } finally {
    translateButton.disabled = false;
    uploadExtractButton.disabled = false;
  }
});

uploadExtractButton.addEventListener("click", async () => {
  uploadExtractButton.disabled = true;
  translateButton.disabled = true;
  setStatus("Reading uploaded image...");
  setOcrChip("OCR idle");
  ocrTextEl.value = "";

  try {
    const file = uploadInput && uploadInput.files ? uploadInput.files[0] : null;
    if (!file) {
      throw new Error("Choose an image file first.");
    }

    const dataUrl = await readFileAsDataUrl(file);
    renderPreview(dataUrl);
    setStatus("Processing with OCR server...");
    setOcrChip("OCR running...");

    // Call OCR server
    const result = await callOCRServer(dataUrl);

    setOcrChip("OCR done");
    ocrTextEl.value = result.text || "No text detected.";
    setStatus(`Done. Lines detected: ${result.lines || 0} (Confidence: ${result.confidence}%)`);
    console.log("[Popup] Text extraction from upload completed:", { lines: result.lines, confidence: result.confidence });
    
    // Save to storage
    await saveOCRData(result.text || "No text detected.", dataUrl);
  } catch (error) {
    console.error("[Popup] Extract from upload error:", error);
    setOcrChip("OCR error");
    setStatus(error.message || "Something went wrong.");
  } finally {
    uploadExtractButton.disabled = false;
    translateButton.disabled = false;
  }
});

// Load saved OCR data when popup opens
document.addEventListener("DOMContentLoaded", async () => {
  console.log("[Popup] Loading saved OCR data...");
  const hasData = await loadOCRData();
  if (!hasData) {
    setStatus("Ready.");
  }

  // Load and display current server URL
  const serverUrlInput = document.getElementById("serverUrl-Id");
  if (serverUrlInput) {
    serverUrlInput.value = OCR_SERVER_URL;
  }

  // Handle server URL save
  const saveButton = document.getElementById("saveServerUrl-Id");
  if (saveButton) {
    saveButton.addEventListener("click", () => {
      const newUrl = serverUrlInput.value.trim();
      if (!newUrl) {
        alert("Please enter a valid server URL");
        return;
      }
      localStorage.setItem("ocrServerUrl", newUrl);
      console.log("[Config] Server URL saved:", newUrl);
      alert("Server URL saved! Changes take effect on next use.");
    });
  }
});