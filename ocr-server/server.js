import express from "express";
import cors from "cors";
import Tesseract from "tesseract.js";
import sharp from "sharp";

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use((req, res, next) => {
  res.setHeader("Content-Encoding", "gzip"); // Manual gzip instruction
  req.setTimeout(30000); // 30 second timeout
  next();
});
app.use(express.json({ limit: "10mb" })); // Reduced from 50mb
app.use(express.urlencoded({ limit: "10mb" })); // Reduced from 50mb

// Health check endpoint
app.get("/", (req, res) => {
  res.json({ status: "OCR Server is running", version: "1.0.0" });
});

// OCR endpoint
app.post("/ocr", async (req, res) => {
  let worker = null;
  try {
    const { imageBase64, languages = "eng" } = req.body; // Default to eng only

    if (!imageBase64) {
      return res.status(400).json({ error: "imageBase64 is required" });
    }

    console.log(`[OCR] Processing image, languages: ${languages}`);

    // Convert base64 to buffer
    const imageBuffer = Buffer.from(
      imageBase64.replace(/^data:image\/\w+;base64,/, ""),
      "base64"
    );

    console.log(`[OCR] Image buffer size: ${imageBuffer.length / 1024}KB`);

    // Aggressive image optimization for memory
    let processedBuffer = await sharp(imageBuffer)
      .resize(1500, 1500, { // Max 1500px - drastically reduces memory
        fit: "inside",
        withoutEnlargement: true
      })
      .grayscale()
      .normalize()
      .toBuffer();

    console.log(`[OCR] Processed image size: ${processedBuffer.length / 1024}KB`);

    // Create fresh Tesseract worker for this request
    console.log("[Tesseract] Creating worker...");
    worker = await Tesseract.createWorker("eng");

    console.log("[Tesseract] Starting recognition...");
    const result = await worker.recognize(processedBuffer, languages);
    console.log("[Tesseract] Recognition complete");

    const { text, confidence, words } = result.data;

    console.log(
      `[OCR] Completed - Confidence: ${confidence}, Words: ${words.length}`
    );

    // Clean text
    const cleanedText = cleanOCRText(text);

    // Force garbage collection if available
    if (global.gc) {
      global.gc();
      console.log("[Memory] Garbage collection triggered");
    }

    // Clear buffers
    processedBuffer = null;

    res.json({
      success: true,
      text: cleanedText,
      confidence: Math.round(confidence),
      wordCount: words.length
    });
  } catch (error) {
    console.error("[OCR] Error:", error.message);

    // Force cleanup on error
    if (global.gc) {
      global.gc();
    }

    res.status(500).json({
      success: false,
      error: error.message || "OCR processing failed"
    });
  } finally {
    // Always terminate worker to free memory
    if (worker) {
      try {
        console.log("[Tesseract] Terminating worker...");
        await worker.terminate();
      } catch (err) {
        console.error("[Tesseract] Error terminating worker:", err.message);
      }
    }
  }
});

// Text cleaning function
function cleanOCRText(text) {
  if (!text) return "";

  const lines = text.split("\n");
  const cleaned = lines
    .map((line) => {
      const asciiChars = (line.match(/[\x20-\x7E]/g) || []).length;
      const totalChars = line.trim().length;

      if (totalChars > 0 && asciiChars / totalChars < 0.3) {
        return null;
      }

      return line.replace(/[^\x20-\x7E\n]/g, "").trim();
    })
    .filter((line) => line && line.length > 1)
    .join("\n");

  return cleaned;
}

// Error handling
app.use((err, req, res, next) => {
  console.error("[Error]", err);
  res.status(500).json({ error: err.message || "Internal server error" });
});

const server = app.listen(PORT, () => {
  console.log(`[Server] OCR Server running on http://localhost:${PORT}`);
  console.log(`[Server] POST /ocr to process images`);
});

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("[Server] SIGTERM received, shutting down gracefully...");
  server.close(() => {
    console.log("[Server] Server closed");
    process.exit(0);
  });
});
