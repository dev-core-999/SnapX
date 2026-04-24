/**
 * ============================================
 * MediaSnap API Server — server.js
 * ============================================
 * Developer : Md. Mainul Islam
 * Owner     : MAINUL - X
 * Telegram  : https://t.me/mdmainulislaminfo
 * GitHub    : https://github.com/M41NUL
 * WhatsApp  : +8801308850528
 * Channel   : https://t.me/mainul_x_official
 * Group     : https://t.me/mainul_x_official_gc
 * Email     : devmainulislam@gmail.com
 * YouTube   : https://youtube.com/@mdmainulislaminfo
 * License   : MIT License
 * ============================================
 */

'use strict';

const { ensureDependencies } = require('./install');
ensureDependencies().catch(e => console.warn('[MediaSnap] Dependency install warning:', e.message));

const express      = require('express');
const cors         = require('cors');
const helmet       = require('helmet');
const rateLimit    = require('express-rate-limit');
const path         = require('path');
const fs           = require('fs');
const { execFile } = require('child_process');

const statusRouter   = require('./routes/status');
const infoRouter     = require('./routes/info');
const downloadRouter = require('./routes/download');
const previewRouter  = require('./routes/preview');

const app  = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

app.locals.metrics = {
  startedAt           : new Date().toISOString(),
  requests            : { total: 0, success: 0, failed: 0 },
  concurrentDownloads : 0,
  maxConcurrent       : parseInt(process.env.MAX_CONCURRENT || '5', 10),
  nodeVersion         : process.version,
  ytdlpVersion        : 'Checking...',
  ytdlpStatus         : 'unknown',
  ffmpegStatus        : 'unknown',
};

// ══════════════════════════════════════════════════════════════════════════════
// GLOBAL INFO + FILE CACHE
// /api/info তে metadata + downloaded file path ক্যাশ হয়।
// /api/download এ cache hit হলে আর yt-dlp চালাতে হয় না — instant download।
// TTL: 10 মিনিট। এরপর temp file auto delete হয়।
// ══════════════════════════════════════════════════════════════════════════════
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

app.locals.infoCache = {
  _store: new Map(),

  set(url, data) {
    // আগের entry থাকলে পুরনো file delete করো
    const existing = this._store.get(url);
    if (existing?.filePath) {
      try { fs.unlinkSync(existing.filePath); } catch (_) {}
    }
    // ✅ FIX: data কে flat store করো, nested 'data' key নয়
    this._store.set(url, { ...data, expires: Date.now() + CACHE_TTL });
    console.log(`[InfoCache] SET → ${url.slice(0, 60)}...`);
  },

  get(url) {
    const entry = this._store.get(url);
    if (!entry) return null;
    if (Date.now() > entry.expires) {
      // Expired — temp file delete করো
      if (entry.filePath) {
        try { fs.unlinkSync(entry.filePath); } catch (_) {}
      }
      this._store.delete(url);
      console.log(`[InfoCache] EXPIRED → ${url.slice(0, 60)}...`);
      return null;
    }
    console.log(`[InfoCache] HIT → ${url.slice(0, 60)}...`);
    // expires key বাদ দিয়ে return করো
    const { expires: _e, ...rest } = entry;
    return rest;
  },

  // Download হয়ে গেলে filePath null করো (file already streamed/deleted)
  clearFile(url) {
    const entry = this._store.get(url);
    if (entry) {
      entry.filePath = null;
    }
  },

  delete(url) {
    const entry = this._store.get(url);
    if (entry?.filePath) {
      try { fs.unlinkSync(entry.filePath); } catch (_) {}
    }
    this._store.delete(url);
  },

  // প্রতি 5 মিনিটে expired entries + files clean করে
  startCleanup() {
    setInterval(() => {
      const now = Date.now();
      let cleaned = 0;
      for (const [key, entry] of this._store.entries()) {
        if (now > entry.expires) {
          if (entry.filePath) {
            try { fs.unlinkSync(entry.filePath); } catch (_) {}
          }
          this._store.delete(key);
          cleaned++;
        }
      }
      if (cleaned > 0) console.log(`[InfoCache] Cleaned ${cleaned} expired entries`);
    }, 5 * 60 * 1000);
  },
};

app.locals.infoCache.startCleanup();

// ── Startup checks ────────────────────────────────────────────────────────────
function checkTool(cmd, args, cb) {
  execFile(cmd, args, { timeout: 10000 }, (err, stdout) => {
    cb(err ? null : (stdout.trim().split('\n')[0] || 'found'));
  });
}

checkTool('yt-dlp', ['--version'], (ver) => {
  if (ver) {
    app.locals.metrics.ytdlpVersion = ver;
    app.locals.metrics.ytdlpStatus  = 'found';
    console.log(`[MediaSnap] yt-dlp  ✓  ${ver}`);
  } else {
    app.locals.metrics.ytdlpStatus = 'not found';
    console.warn('[MediaSnap] yt-dlp  ✗  NOT FOUND — downloads will fail!');
  }
});

checkTool('ffmpeg', ['-version'], (ver) => {
  if (ver) {
    app.locals.metrics.ffmpegStatus = 'found';
    console.log(`[MediaSnap] ffmpeg  ✓`);
  } else {
    app.locals.metrics.ffmpegStatus = 'not found';
    console.warn('[MediaSnap] ffmpeg  ✗  NOT FOUND — merging may fail!');
  }
});

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy     : false,
  crossOriginEmbedderPolicy : false,
  crossOriginResourcePolicy : false,
  crossOriginOpenerPolicy   : false,
}));

const ALLOWED_ORIGINS = [
  'https://mediasnap-app.netlify.app',
  'https://mediasnap.onrender.com',
  '',
];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    callback(new Error('CORS: Origin not allowed — ' + origin));
  },
  methods      : ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials  : false,
}));

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

const apiLimiter = rateLimit({
  windowMs       : 60 * 1000,
  max            : 60,
  standardHeaders: true,
  legacyHeaders  : false,
  message        : { error: 'Too many requests. Please slow down.' },
  skip           : (req) => req.path === '/health',
});
app.use('/api', apiLimiter);

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Routes ────────────────────────────────────────────────────────────────────
app.use(statusRouter);
app.use(infoRouter);
app.use(downloadRouter);
app.use(previewRouter);

app.use((req, res) => {
  res.status(404).json({ error: 'Route not found.' });
});

app.use((err, req, res, _next) => {
  console.error('[MediaSnap] Unhandled error:', err.message);
  res.status(500).json({ error: 'Internal server error.' });
});

// ── Start ─────────────────────────────────────────────────────────────────────
const server = app.listen(PORT, () => {
  console.log(`\n╔══════════════════════════════════════════╗`);
  console.log(`║      MediaSnap API Server v1.0.0         ║`);
  console.log(`╚══════════════════════════════════════════╝`);
  console.log(`[MediaSnap] Running  →  https://mediasnap.onrender.com`);
  console.log(`[MediaSnap] Max concurrent downloads: ${app.locals.metrics.maxConcurrent}`);
  console.log(`[MediaSnap] Node.js: ${process.version}\n`);
});

function shutdown(signal) {
  console.log(`\n[MediaSnap] ${signal} — shutting down gracefully...`);
  server.close(() => {
    console.log('[MediaSnap] Server closed. Bye!');
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

module.exports = app;
