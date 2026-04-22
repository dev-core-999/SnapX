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

// ── Install yt-dlp + ffmpeg before anything else ──────────────────────────────
const { ensureDependencies } = require('./install');
ensureDependencies().catch(e => console.warn('[MediaSnap] Dependency install warning:', e.message));

const express      = require('express');
const cors         = require('cors');
const helmet       = require('helmet');
const rateLimit    = require('express-rate-limit');
const path         = require('path');
const { execFile } = require('child_process');

// ── Route files ───────────────────────────────────────────────────────────────
const statusRouter   = require('./routes/status');
const infoRouter     = require('./routes/info');
const downloadRouter = require('./routes/download');
const previewRouter  = require('./routes/preview');

// ── App ───────────────────────────────────────────────────────────────────────
const app  = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

// ══════════════════════════════════════════════════════════════════════════════
// GLOBAL METRICS  (shared via app.locals — all routes read/write this)
// ══════════════════════════════════════════════════════════════════════════════
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
// GLOBAL INFO CACHE
// /api/info থেকে পাওয়া yt-dlp JSON result ক্যাশ করা হয়।
// /api/download এ একই URL এলে আর yt-dlp info রান করতে হয় না।
// TTL: 8 মিনিট (directUrl সাধারণত 10-15 মিনিট valid থাকে)
// ══════════════════════════════════════════════════════════════════════════════
const INFO_CACHE_TTL = 8 * 60 * 1000; // 8 minutes

app.locals.infoCache = {
  _store: new Map(),

  set(url, data) {
    this._store.set(url, { data, expires: Date.now() + INFO_CACHE_TTL });
    console.log(`[InfoCache] SET → ${url.slice(0, 60)}...`);
  },

  get(url) {
    const entry = this._store.get(url);
    if (!entry) return null;
    if (Date.now() > entry.expires) {
      this._store.delete(url);
      console.log(`[InfoCache] EXPIRED → ${url.slice(0, 60)}...`);
      return null;
    }
    console.log(`[InfoCache] HIT → ${url.slice(0, 60)}...`);
    return entry.data;
  },

  delete(url) {
    this._store.delete(url);
  },

  // প্রতি 5 মিনিটে expired entries clean করে
  startCleanup() {
    setInterval(() => {
      const now = Date.now();
      let cleaned = 0;
      for (const [key, entry] of this._store.entries()) {
        if (now > entry.expires) {
          this._store.delete(key);
          cleaned++;
        }
      }
      if (cleaned > 0) console.log(`[InfoCache] Cleaned ${cleaned} expired entries`);
    }, 5 * 60 * 1000);
  },
};

app.locals.infoCache.startCleanup();

// ══════════════════════════════════════════════════════════════════════════════
// STARTUP CHECKS  — yt-dlp + ffmpeg
// ══════════════════════════════════════════════════════════════════════════════
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
    app.locals.metrics.ytdlpStatus  = 'not found';
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

// ══════════════════════════════════════════════════════════════════════════════
// MIDDLEWARE
// ══════════════════════════════════════════════════════════════════════════════

app.use(helmet({
  contentSecurityPolicy      : false,
  crossOriginEmbedderPolicy  : false,
  crossOriginResourcePolicy  : false,
  crossOriginOpenerPolicy    : false,
}));

const ALLOWED_ORIGINS = [
  'https://mediasnap-app.netlify.app',
  'https://mediasnap.onrender.com',
  'http://localhost:5500',
];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    callback(new Error('CORS: Origin not allowed — ' + origin));
  },
  methods       : ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials   : false,
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

// ══════════════════════════════════════════════════════════════════════════════
// STATIC
// ══════════════════════════════════════════════════════════════════════════════
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ══════════════════════════════════════════════════════════════════════════════
// ROUTES
// ══════════════════════════════════════════════════════════════════════════════
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

// ══════════════════════════════════════════════════════════════════════════════
// START SERVER
// ══════════════════════════════════════════════════════════════════════════════
const server = app.listen(PORT, () => {
  console.log(`\n╔══════════════════════════════════════════╗`);
  console.log(`║      MediaSnap API Server v1.0.0         ║`);
  console.log(`╚══════════════════════════════════════════╝`);
  console.log(`[MediaSnap] Running  →  http://localhost:${PORT}`);
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
