/**
 * Quick local test for the OCR server.
 * 1. Run the server: npm start
 * 2. In another terminal: node test-local.js
 */

const BASE = "http://localhost:3000";

// Minimal valid 1x1 PNG (transparent pixel) - OCR will return empty/minimal text
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

async function test() {
  console.log("1. Testing GET / (health check)...");
  const health = await fetch(BASE);
  const healthData = await health.json();
  console.log("   Response:", healthData);
  if (!health.ok) {
    console.error("   Server not OK. Is it running? (npm start)");
    process.exit(1);
  }

  console.log("\n2. Testing POST /ocr (minimal image)...");
  const ocrRes = await fetch(`${BASE}/ocr`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      imageBase64: `data:image/png;base64,${TINY_PNG_BASE64}`,
      languages: "eng",
    }),
  });
  const ocrData = await ocrRes.json();
  console.log("   Status:", ocrRes.status);
  console.log("   Response:", ocrData);

  if (ocrRes.ok && ocrData.success) {
    console.log("\n   OK – Server is ready. You can use the extension with OCR Server URL: http://localhost:3000");
  } else {
    console.error("\n   OCR request failed. Check that Tesseract is installed (e.g. tesseract --version).");
    process.exit(1);
  }
}

test().catch((err) => {
  console.error("Request failed:", err.message);
  console.error("Make sure the server is running: npm start");
  process.exit(1);
});
