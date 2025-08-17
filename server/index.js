require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { pool } = require('./database');
const tesseract = require('node-tesseract-ocr');

process.on('uncaughtException', err => {
  console.error('Uncaught Exception:', err);
});
process.on('unhandledRejection', err => {
  console.error('Unhandled Rejection:', err);
});


//functions
function buildTesseractConfig(lang) {
  const config = { lang, oem: 1, psm: 3 };
  return config;
}





//express handlers
const app = express();

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'] }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {files: 10, fileSize: 10 * 1024 * 1024}
});

app.get('/healthz', (req,res) => res.json({ ok: true }));

app.get('/db/health', async (req,res)=>{
  try {
    const { rows } = await pool.query('SELECT 1 AS ok');
    res.json({ db:'ok', result: rows[0] });
  } catch(e){
    console.error('DB health error:', e.message);
    res.status(500).json({ db:'error', error: e.message });
  }
});

app.post('/translate', upload.array('images',10), (req,res) => {
  const language = req.body.language || 'english';
  const files = req.files || [];

  res.json({
    ok: true,
    language,
    count: files.length,
    filenames: files.map(f => f.originalname),
    note: 'Forward to Python later'
  });
});

app.post('/ocr', upload.array('images', 10), async (req,res) => {
  const lang = (req.query.lang || 'eng').toLowerCase();
  const allowed = ['eng','jpn'];
  if(!allowed.includes(lang)){
    return res.status(400).json({ 
      error: 'Unsupported Language please try Again'
    });
  }

  if(!req.files || req.files.length === 0){
    return res.status(400).json({
      error: 'No images uploaded'
    });
  }
  const results = [];
  for(const f of req.files){
    try{
      const config = buildTesseractConfig(lang);
      const text = await tesseract.recognize(f.buffer, config);
      console.log('Tesseract finished for', f.originalname);
      results.push({filename: f.originalname, ocrText: text.trim() });
    }catch(e){
      console.error('OCR error for', f.originalname, e);
      results.push({ filename: f.originalname, error: e.message});
    }
  }

  res.json({  lang, count: results.length, results});
})


app.post('/ocr-test', upload.array('images', 10), (req,res)=>{
  res.json({ received: (req.files||[]).map(f=>f.originalname) });
});

const PORT = Number(process.env.PORT ||3000);
app.listen(PORT, () => console.log('Listening on http://localhost:' + PORT));