# Image Translator - Deployment Guide

## Quick Start

### 1. Start OCR Server Locally (Testing)

```powershell
cd ocr-server
npm install
npm start
```

Server runs on `http://localhost:3000`

### 2. Configure Extension

1. Open extension popup
2. Scroll to **Settings** section
3. Enter `http://localhost:3000` in OCR Server URL
4. Click **Save URL**

### 3. Test

- Click **Capture & Extract** on any webpage with text
- Or click **Extract from Upload** and choose an image
- Should see extracted text!

---

## Deploy to Production

### Option A: Railway (Recommended - Free)

**Fastest setup, free tier generous.**

Steps:
1. Push your code to GitHub
2. Go to [railway.app](https://railway.app)
3. Sign in with GitHub
4. Create new project → Deploy from GitHub repo
5. Select the `Image-Translator` repo
6. Railway auto-detects `railway.json` in `ocr-server` folder
7. Sets environment, deploys automatically
8. Get your public URL (like `https://ocr-xxxxx.railway.app`)
9. Update extension settings with this URL

**That's it!** No credit card needed for free tier.

### Option B: Render (Free Alternative)

Steps:
1. Push code to GitHub
2. Go to [render.com](https://render.com)
3. Sign in with GitHub
4. New → Web Service
5. Point to your repo
6. Build command: `cd ocr-server && npm install`
7. Start command: `cd ocr-server && npm start`
8. Deploy
9. Get public URL, update extension

### Option C: Your Own Server (VPS)

**For maximum control.**

On your server:
```bash
git clone <your-repo>
cd Image-Translator/ocr-server
npm install
npm start  # or use PM2/systemd for auto-restart
```

Update firewall to allow port 3000 (or reverse proxy with nginx).

---

## Environment Variables

For production security:

```bash
PORT=3000              # Default, change if needed
NODE_ENV=production    # Set for Railway/Render
```

---

## Monitoring

### Check if server is running:

```bash
curl https://your-server-url
```

Should return:
```json
{"status":"OCR Server is running","version":"1.0.0"}
```

### View logs:

**Railway:** Console in web dashboard
**Render:** Logs tab in dashboard
**Local:** Terminal output

---

## Troubleshooting

**"Server connection failed"**
- Check server is running: `curl http://localhost:3000`
- Check URL in extension settings (Settings section in popup)
- No `http://` prefix? Add it!

**"Image too large"**
- Max 50MB upload
- Sharp automatically compresses large images

**"Timeout after 30 seconds"**
- Server might be cold-starting (takes 5-10s first time)
- Wait and retry
- Or upgrade to paid plan for always-on instances

**Port already in use**
```bash
PORT=3001 npm start
```

---

## Performance Expectations

| Metric | Local | Railway Free | Railway Paid |
|--------|-------|--------------|-------------|
| First request | 2-3s | 10-15s (cold) | 2-3s |
| Subsequent | 1-2s | 2-3s | 1-2s |
| Accuracy | 85-95% | Same | Same |
| Cost | Free | Free (500hrs/mo) | ~$5/mo |

---

## Scaling

If you get rate-limited or need faster OCR:

1. **Upgrade Railway plan** → $7/mo for more resources
2. **Add load balancing** → Multiple server instances behind nginx
3. **Use GPU server** → AWS EC2 with GPU (better OCR speed)

---

## Security

Currently server accepts images from anywhere (CORS enabled).

For production, add authentication:

```javascript
// In server.js
app.use((req, res, next) => {
  const apiKey = req.headers['x-api-key'];
  if (apiKey !== process.env.API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});
```

---

## Support

Check:
1. `ocr-server/README.md` - Server documentation
2. Extension console (DevTools) - Error messages
3. Server logs - Processing details
