import express from "express";
import cors from "cors";
import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use((req, res, next) => {
  req.setTimeout(30000); // 30 second timeout
  next();
});
app.use(express.json({ limit: "10mb" })); // Reduced from 50mb
app.use(express.urlencoded({ limit: "10mb" })); // Reduced from 50mb

// Health check endpoint
app.get("/", (req, res) => {
  res.json({ status: "OCR Server is running", version: "1.0.0" });
});

// Helper function to run Tesseract (psm 6 = uniform block of text, good for screenshots/crops)
function runTesseract(imagePath, languages = "eng", psm = "6") {
  return new Promise((resolve, reject) => {
    const outputPath = imagePath.replace(/\.[^.]+$/, "");

    console.log(`[Tesseract] Input file: ${imagePath}`);
    console.log(`[Tesseract] Output path: ${outputPath}`);
    console.log(`[Tesseract] Languages: ${languages}, PSM: ${psm}`);

    const args = [imagePath, outputPath, "-l", languages, "--psm", String(psm)];
    console.log(`[Tesseract] Full command: tesseract ${args.join(" ")}`);

    execFile("tesseract", args, (error, stdout, stderr) => {
      console.log(`[Tesseract] Command output:`, stdout || "(no stdout)");
      if (stderr) console.log(`[Tesseract] Command stderr:`, stderr);

      if (error && error.code !== 0) {
        console.error("[Tesseract] Error code:", error.code);
        reject(new Error("Tesseract processing failed: " + (stderr || error.message)));
        return;
      }

      // Read the output text file
      const textFile = outputPath + ".txt";
      console.log(`[Tesseract] Looking for output file: ${textFile}`);

      if (!fs.existsSync(textFile)) {
        console.error(`[Tesseract] Output file not found at ${textFile}`);
        reject(new Error("Tesseract did not generate output file"));
        return;
      }

      fs.readFile(textFile, "utf8", (err, data) => {
        if (err) {
          reject(new Error("Failed to read OCR output: " + err.message));
          return;
        }

        console.log(`[Tesseract] Output file size: ${data.length} bytes`);

        // Clean up only text file, keep image for debugging
        fs.unlink(textFile, () => {});
        // Don't delete image: fs.unlink(imagePath, () => {});

        resolve(data);
      });
    });
  });
}

// OCR endpoint
app.post("/ocr", async (req, res) => {
  let tempImagePath = null;

  try {
    let { imageBase64, languages } = req.body;

    if (!imageBase64) {
      return res.status(400).json({ error: "imageBase64 is required" });
    }

    // Validate and sanitize languages - only use what's installed (must match Tesseract tessdata on server)
    // Add "jpn", "chi_tra", "chi_sim" when you have those tessdata installed
    const validLangs = ["eng", "kor"];
    if (!languages) {
      languages = "eng"; // Default
    }
    
    // Split and filter to only valid languages
    const langArray = languages.split("+").filter(lang => validLangs.includes(lang.trim()));
    if (langArray.length === 0) {
      languages = "eng"; // Fallback if none valid
    } else {
      languages = langArray.join("+");
    }

    console.log(`[OCR] Processing image, languages: ${languages}`);

    // Convert base64 to buffer
    const imageBuffer = Buffer.from(
      imageBase64.replace(/^data:image\/\w+;base64,/, ""),
      "base64"
    );

    console.log(`[OCR] Image buffer size: ${imageBuffer.length / 1024}KB`);

    tempImagePath = path.join(__dirname, `temp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}.png`);
    fs.writeFileSync(tempImagePath, imageBuffer);

    console.log("[Tesseract] Starting recognition...");
    const rawText = await runTesseract(tempImagePath, languages, "6");
    console.log("[Tesseract] Recognition complete");
    console.log("[Tesseract] Detected text:", rawText.substring(0, 200)); // Show first 200 chars

    // Clean text
    const cleanedText = cleanOCRText(rawText);

    // Force garbage collection if available
    if (global.gc) {
      global.gc();
      console.log("[Memory] Garbage collection triggered");
    }

    res.json({
      success: true,
      text: cleanedText,
      wordCount: (cleanedText.match(/\S+/g) || []).length
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
    // Clean up temp file
    if (tempImagePath && fs.existsSync(tempImagePath)) {
      try {
        fs.unlinkSync(tempImagePath);
      } catch (err) {
        console.error("[OCR] Failed to cleanup temp file:", err.message);
      }
    }
  }
});

// Has Korean/CJK (so we can drop Latin-only noise lines)
const hasCJK = (s) => /[\uAC00-\uD7AF\u3130-\u318F\u4E00-\u9FFF]/.test(s);

// Text cleaning - keep everything except empty lines
function cleanOCRText(text) {
  if (!text) return "";

  let lines = text
    .split("\n")
    .map(line => {
      const hasNonLatin = /[^\x00-\x7F]/.test(line);
      if (hasNonLatin) {
        return line.replace(/\s+/g, ""); // Remove spaces between Korean/Chinese chars
      }
      return line;
    })
    .map(line => line.trim())
    .filter(line => line.length > 0);

  // If text has Korean/CJK, drop lines that are only Latin (removes UI noise like "Ve", "Lol", "NN")
  if (lines.some(hasCJK)) {
    lines = lines.filter(hasCJK);
  }

  return lines.join("\n");
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
