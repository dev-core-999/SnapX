/**
 * ============================================
 * MediaSnap — routes/status.js
 * ============================================
 * GET /health      → simple alive check
 * GET /api/status  → full server metrics
 * ============================================
 */

'use strict';

const express = require('express');
const router  = express.Router();
const os      = require('os');

// ── GET /health ───────────────────────────────────────────────────────────────
router.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ── GET /api/status ───────────────────────────────────────────────────────────
router.get('/api/status', (req, res) => {
  const m       = req.app.locals.metrics;
  const uptimeSec = Math.floor(process.uptime());

  // Memory
  const memUsed = process.memoryUsage().rss;
  const memMB   = (memUsed / 1024 / 1024).toFixed(1);

  res.json({
    status              : 'ok',
    startedAt           : m.startedAt,
    uptimeRaw           : uptimeSec,
    nodeVersion         : m.nodeVersion,
    memoryUsed          : `${memMB} MB`,
    ytdlpVersion        : m.ytdlpVersion,
    ytdlpStatus         : m.ytdlpStatus,
    ffmpegStatus        : m.ffmpegStatus,
    concurrentDownloads : m.concurrentDownloads,
    maxConcurrent       : m.maxConcurrent,
    requests            : { ...m.requests },
    platform            : os.platform(),
  });
});

module.exports = router;
