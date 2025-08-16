require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { pool } = require('./database');

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

const PORT = Number(process.env.PORT ||3000);
app.listen(PORT, () => console.log('Listening on http://localhost:' + PORT));