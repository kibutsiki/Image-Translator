import express from "express";
import cors from "cors";
import Tesseract from "tesseract.js";
import sharp from "sharp";

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb" }));

// Health check endpoint
app.get("/", (req, res) => {
  res.json({ status: "OCR Server is running", version: "1.0.0" });
});

// OCR endpoint
app.post("/ocr", async (req, res) => {
  try {
    const { imageBase64, languages = "eng+kor+jpn" } = req.body;

    if (!imageBase64) {
      return res.status(400).json({ error: "imageBase64 is required" });
    }

    console.log(`[OCR] Processing image, languages: ${languages}`);

    // Convert base64 to buffer
    const imageBuffer = Buffer.from(
      imageBase64.replace(/^data:image\/\w+;base64,/, ""),
      "base64"
    );

    // Preprocess image with sharp for better OCR
    const processedBuffer = await sharp(imageBuffer)
      .grayscale() // Convert to grayscale
      .normalize() // Enhance contrast
      .sharpen() // Sharpen for better text recognition
      .toBuffer();

    console.log("[OCR] Image preprocessed");

    // Run Tesseract
    const {
      data: { text, confidence, words },
    } = await Tesseract.recognize(processedBuffer, languages, {
      logger: (m) => {
        if (m.status === "recognizing text") {
          const progress = Math.round(m.progress * 100);
          if (progress % 25 === 0) {
            console.log(`[Tesseract] Progress: ${progress}%`);
          }
        }
      },
    });

    console.log(
      `[OCR] Completed - Confidence: ${confidence}, Words: ${words.length}`
    );

    // Clean text
    const cleanedText = cleanOCRText(text);

    res.json({
      success: true,
      text: cleanedText,
      confidence: Math.round(confidence),
      wordCount: words.length,
      rawText: text,
    });
  } catch (error) {
    console.error("[OCR] Error:", error.message);
    res.status(500).json({
      success: false,
      error: error.message || "OCR processing failed",
    });
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

app.listen(PORT, () => {
  console.log(`[Server] OCR Server running on http://localhost:${PORT}`);
  console.log(`[Server] POST /ocr to process images`);
});
