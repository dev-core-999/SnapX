/**
 * ============================================
 * MediaSnap — routes/download.js
 * GET /api/download?url=<encoded>
 *
 * ✅ OPTIMIZED v2:
 *   Cache HIT  → /api/info এ download হওয়া file সরাসরি stream — INSTANT
 *   Cache MISS → নতুন করে yt-dlp download করে stream (fallback)
 * ============================================
 */

'use strict';

const express = require('express');
const router  = express.Router();
const fs      = require('fs');

const { downloadTikTok    } = require('../platforms/tiktok');
const { downloadInstagram } = require('../platforms/instagram');
const { downloadFacebook  } = require('../platforms/facebook');

function detectPlatform(url) {
  if (/tiktok\.com|vm\.tiktok\.com|vt\.tiktok\.com/i.test(url))  return 'tiktok';
  if (/instagram\.com\/(reel|p|tv)\//i.test(url))                 return 'instagram';
  if (/facebook\.com|fb\.watch|fb\.com/i.test(url))               return 'facebook';
  return null;
}

function safeFilename(title, platform, uploader) {
  const p = (platform || 'Video').replace(/[^\w]/g, '');
  const u = (uploader || '').replace(/[^\w\s\-_.]/g, '').replace(/\s+/g, '_').slice(0, 50);
  const base = u ? `${p}_${u}` : p;
  return `${base}_MediaSnap.mp4`;
}

router.get('/api/download', async (req, res) => {
  const m     = req.app.locals.metrics;
  const cache = req.app.locals.infoCache;
  const url   = (req.query?.url || '').trim();

  if (!url) return res.status(400).json({ error: 'url query param required' });

  const platform = detectPlatform(url);
  if (!platform) return res.status(400).json({ error: 'Unsupported URL' });

  m.requests.total++;

  // ✅ Cache HIT — /api/info এ download হওয়া file আছে
  const cached = cache.get(url);
  if (cached?.filePath && fs.existsSync(cached.filePath)) {
    console.log(`[/api/download] INSTANT — serving cached file for: ${url.slice(0, 60)}...`);

    const filename = safeFilename(cached.title, platform, cached.uploader);
    const stat     = fs.statSync(cached.filePath);
    const fileSize = stat.size;

    res.writeHead(200, {
      'Content-Type'          : 'application/octet-stream',
      'Content-Length'        : fileSize,
      'Content-Disposition'   : `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      'Cache-Control'         : 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });

    const stream = fs.createReadStream(cached.filePath);
    stream.pipe(res);

    const cleanup = () => {
      try { fs.unlinkSync(cached.filePath); } catch (_) {}
      cache.clearFile(url); // cache এ filePath null করো
    };
    res.on('finish', () => { m.requests.success++; cleanup(); });
    res.on('close',  cleanup);
    stream.on('error', (err) => {
      console.error('[/api/download] stream error:', err.message);
      m.requests.failed++;
      cleanup();
    });

    return;
  }

  // ✅ Cache MISS — নতুন করে download করো (fallback)
  console.log(`[/api/download] FALLBACK — re-downloading: ${url.slice(0, 60)}...`);

  if (m.concurrentDownloads >= m.maxConcurrent) {
    return res.status(429).json({ error: 'Server busy. Please try again shortly.' });
  }

  m.concurrentDownloads++;

  let result;
  try {
    if (platform === 'tiktok')    result = await downloadTikTok(url);
    if (platform === 'instagram') result = await downloadInstagram(url);
    if (platform === 'facebook')  result = await downloadFacebook(url);
  } catch (err) {
    m.concurrentDownloads--;
    m.requests.failed++;
    console.error(`[/api/download] ${platform} error:`, err.message);
    return res.status(500).json({ error: err.message });
  }

  m.concurrentDownloads--;
  m.requests.success++;

  const { filePath, title, uploader } = result;
  const filename = safeFilename(title, platform, uploader);
  const stat     = fs.statSync(filePath);
  const fileSize = stat.size;

  res.writeHead(200, {
    'Content-Type'          : 'application/octet-stream',
    'Content-Length'        : fileSize,
    'Content-Disposition'   : `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    'Cache-Control'         : 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  });

  const stream = fs.createReadStream(filePath);
  stream.pipe(res);

  const cleanup = () => { try { fs.unlinkSync(filePath); } catch (_) {} };
  res.on('finish', cleanup);
  res.on('close',  cleanup);
  stream.on('error', (err) => {
    console.error('[/api/download] stream error:', err.message);
    cleanup();
  });
});

module.exports = router;
