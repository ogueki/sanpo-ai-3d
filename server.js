import express from 'express';
import cors from 'cors';
import https from 'https';
import fs from 'fs';
import unifiedHandler from './api/unified.js';
import sttHandler from './api/speech-to-text.js';
import resetHandler from './api/reset-session.js';
import ttsHandler from './api/tts.js';
import collectionHandler from './api/collection.js';
import generate3dHandler from './api/generate-3d.js';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config();

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' })); // 画像や音声データ用に制限を緩和

// APIルート
app.post('/api/unified', unifiedHandler);
app.post('/api/speech-to-text', sttHandler);
app.post('/api/reset-session', resetHandler);
app.post('/api/tts', ttsHandler);
app.get('/api/collection', collectionHandler);
app.post('/api/collection', collectionHandler);
app.post('/api/generate-3d', generate3dHandler);

// GLBプロキシ（Tripo CDNのCORS回避）
app.get('/api/proxy-glb', async (req, res) => {
  const url = req.query.url;
  if (!url || !url.startsWith('https://tripo-data.')) {
    return res.status(400).send('Invalid URL');
  }
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Fetch failed: ${response.status}`);
    res.set('Content-Type', 'model/gltf-binary');
    res.set('Access-Control-Allow-Origin', '*');
    const buffer = Buffer.from(await response.arrayBuffer());
    res.send(buffer);
  } catch (err) {
    console.error('❌ [GLB Proxy] Error:', err.message);
    res.status(502).send('Failed to fetch GLB');
  }
});

// ヘルスチェック
app.get('/health', (req, res) => {
  res.send('Sanpo AI Server is running 🚀');
});

// 静的ファイルサービング（index.html, camera.js など）
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.use(express.static(__dirname));

// HTTPS サーバー（カメラAPIにはHTTPSが必要）
const sslOptions = {
  key: fs.readFileSync(path.join(__dirname, 'key.pem')),
  cert: fs.readFileSync(path.join(__dirname, 'cert.pem'))
};

https.createServer(sslOptions, app).listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 Server running at https://0.0.0.0:${PORT}`);
  console.log(`📱 スマホからは https://<PCのIPアドレス>:${PORT} に接続してください`);
});
