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

// Security headers — helmet disabled for status page compatibility
// Static HTML page uses inline scripts + external fonts/images
app.use(helmet({
  contentSecurityPolicy      : false,
  crossOriginEmbedderPolicy  : false,
  crossOriginResourcePolicy  : false,
  crossOriginOpenerPolicy    : false,
}));

// CORS — only allow specific domains
const ALLOWED_ORIGINS = [
  'https://mediasnap-app.netlify.app',
  'http://localhost:3000',
  'http://localhost:5500',
  // Add more allowed origins here if needed
];

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (same-server / curl / Postman)
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    callback(new Error('CORS: Origin not allowed — ' + origin));
  },
  methods : ['GET', 'POST', 'OPTIONS'],
  allowedHeaders : ['Content-Type', 'Authorization'],
  credentials : false,
}));

// Body parsing
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

// Rate limiter — 60 req/min per IP on API routes
const apiLimiter = rateLimit({
  windowMs        : 60 * 1000,
  max             : 60,
  standardHeaders : true,
  legacyHeaders   : false,
  message         : { error: 'Too many requests. Please slow down.' },
  skip            : (req) => req.path === '/health',
});
app.use('/api', apiLimiter);

// ══════════════════════════════════════════════════════════════════════════════
// STATIC  — serve HTML status page from /public folder
// ══════════════════════════════════════════════════════════════════════════════
app.use(express.static(path.join(__dirname, 'public')));

// Root → status page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ══════════════════════════════════════════════════════════════════════════════
// ROUTES
// ══════════════════════════════════════════════════════════════════════════════
app.use(statusRouter);    // GET  /health, GET /api/status
app.use(infoRouter);      // POST /api/info
app.use(downloadRouter);  // GET  /api/download
app.use(previewRouter);   // GET  /api/preview

// ── 404 ───────────────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found.' });
});

// ── Global error handler ──────────────────────────────────────────────────────
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

// ══════════════════════════════════════════════════════════════════════════════
// GRACEFUL SHUTDOWN
// ══════════════════════════════════════════════════════════════════════════════
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
