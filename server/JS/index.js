require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { pool } = require('./database');
const tesseract = require('node-tesseract-ocr');
const TesseractJS = require('tesseract.js');
const axios = require('axios');
const { v4: uuidv4} = require('uuid');

const app = express();


process.on('uncaughtException', err => {
  console.error('Uncaught Exception:', err);
});
process.on('unhandledRejection', err => {
  console.error('Unhandled Rejection:', err);
});


const allowedOrigins = [
  'http://localhost:3000',
  'http://3.144.33.148'
]
//functions
function buildTesseractConfig(lang) {
  const config = { lang: lang, oem: 1, psm: 3 };
  if (process.platform === 'win32') {
    config.executablePath = process.env.TESSERACT_PATH;
  }
  return config;
}

function requireAuthentication(req,res,next){
  const token =  req.headers['authorization'];
  if(token !== process.env.API_TOKEN){
    return res.status(401).json({ error: 'Unauthorized'});
  }
  next();
}





app.use(cors({
  origin: function(origin, callback){
    if(!origin || allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else{
      callback(new Error('Not allowed by CORS'))
    }
  },
  methods: ['GET', 'POST', 'OPTIONS']
}));




//express handlers

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


app.post('/ocr', requireAuthentication , upload.array('images', 10), async (req,res) => {
  const lang = (req.body.lang || 'kor').toLowerCase();
  const allowed = ['eng','jpn', 'kor'];
  const session_id = req.body.session_id;
  const results = [];
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

  for(const f of req.files){
    try{
      const config = buildTesseractConfig(lang);
      const text = await tesseract.recognize(f.buffer, config);
      results.push({ filename: f.originalname, ocrText: text.trim(), session_id });
      await pool.query(
        'INSERT INTO ocr_results (filename, lang, ocr_text, session_id) VALUES ($1, $2, $3, $4)',
        [f.originalname, lang, text.trim(), session_id]
      );
    }catch(e){
      console.error('OCR error:', e);
      let errorMsg = 'Unknown error';
      if(e){
        errorMsg = e.message || e.toString();
      }
      results.push({ filename: f.originalname,session_id, error: errorMsg});
    }
  }

  res.json({  lang, count: results.length, results, session_id});
})


app.post('/ocr-test', upload.array('images', 10), (req,res)=>{
  res.json({ received: (req.files||[]).map(f=>f.originalname) });
});

app.post('/translate', requireAuthentication, upload.array('images', 10), async (req, res) => {
  const language = req.body.language || 'en';
  const files = req.files || [];
  const apiKey = process.env.GOOGLE_TRANSLATE_API_KEY;
  const session_id = req.body.session_id;
  const translatedResults = [];



  try{
    for(const f of files){
      const { rows } = await pool.query(
        'SELECT ocr_text FROM ocr_results WHERE filename = $1 AND session_id = $2',
        [f.originalname, session_id]
      );
      const ocrText = rows[0]?.ocr_text || '';
      const url = `https://translation.googleapis.com/language/translate/v2?key=${apiKey}`;
      const response = await axios.post(url, {
        q: ocrText,
        target: language
      });
      if(!ocrText){
        translatedResults.push({ filename: f.originalname,session_id, error: 'No OCR text found for this file and batch.'});
        continue;
      }
      const translated = response.data.data.translations[0].translatedText;

      await pool.query(
        'UPDATE ocr_results SET translated_text = $1 where filename = $2 AND session_id = $3',
        [translated, f.originalname, session_id]
      );

      translatedResults.push({ filename: f.originalname, translated, session_id });
    }
    res.json({
        ok: true,
        language,
        session_id,
        count: files.length,
        filenames: files.map(f => f.originalname),
        results: translatedResults
      });
  }catch(e){
    console.error('Translation error:', e.message ? e.response.data : e.message);
    res.status(500).json({ error: 'Translated failed', details: e.message });
  }
})

app.get('/results', requireAuthentication, async (req, res) =>{
  const session_id = req.query.session_id;
  try {
    const { rows } = await pool.query('SELECT * FROM ocr_results WHERE session_id = $1 ORDER BY created_at DESC',
       [session_id]);
    res.json({ results: rows});
  } catch(e){
    res.status(500).json({ error: e.message});
  }


});


app.delete('/results/session', requireAuthentication, async (req, res) => {
  const session_id = req.body.session_id;
  if(!session_id){
    return res.status(400).json({ error: 'Session ID is required'});
  }
  try {
    await pool.query('DELETE FROM ocr_results WHERE session_id = $1', [session_id]);
    res.json({ ok:true, deleted: session_id});
  }catch(e){
    res.status(500).json({ error: e.message});
  }

})




const PORT = Number(process.env.PORT ||3000);
app.listen(PORT, () => console.log('Listening on http://localhost:' + PORT));