# Node 18 on Debian - for native Tesseract OCR
FROM node:18-bookworm-slim

# Install Tesseract OCR and language packs (eng, jpn, kor, chi_sim, chi_tra)
RUN apt-get update && apt-get install -y --no-install-recommends \
    tesseract-ocr \
    tesseract-ocr-eng \
    tesseract-ocr-jpn \
    tesseract-ocr-kor \
    tesseract-ocr-chi-sim \
    tesseract-ocr-chi-tra \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY server.js ./

ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
