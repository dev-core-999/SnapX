/**
 * ============================================
 * MediaSnap — routes/download.js
 * GET /api/download?url=<encoded>
 * Saves video to temp file, streams as attachment
 * → mobile browser saves directly to device
 *
 * ✅ OPTIMIZED:
 *   আগে: yt-dlp info() + yt-dlp download() — দুটো PARALLEL চলত
 *   এখন: cache থেকে info নাও, শুধু download() চালাও
 *   ফলে প্রতিটা download এ ~5–15 সেকেন্ড বাঁচে
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

function safeFilename(title, platform) {
  const base = (title || platform || 'video')
    .replace(/[^\w\s\-_.]/g, '')
    .replace(/\s+/g, '_')
    .slice(0, 80);
  return `${base || platform}_MediaSnap.mp4`;
}

router.get('/api/download', async (req, res) => {
  const m     = req.app.locals.metrics;
  const cache = req.app.locals.infoCache;
  const url   = (req.query?.url || '').trim();

  if (!url) return res.status(400).json({ error: 'url query param required' });

  const platform = detectPlatform(url);
  if (!platform) return res.status(400).json({ error: 'Unsupported URL' });

  if (m.concurrentDownloads >= m.maxConcurrent) {
    return res.status(429).json({ error: 'Server busy. Please try again shortly.' });
  }

  m.concurrentDownloads++;
  m.requests.total++;

  // ✅ cache থেকে আগের info নাও (যদি থাকে)
  const cachedInfo = cache.get(url);
  if (cachedInfo) {
    console.log(`[/api/download] Cache HIT — skipping yt-dlp info for: ${url.slice(0, 60)}...`);
  } else {
    console.log(`[/api/download] Cache MISS — downloading without cached info: ${url.slice(0, 60)}...`);
  }

  let result;
  try {
    // ✅ cachedInfo pass করো platform download function এ
    //    cache hit হলে platform function আর info call করবে না
    if (platform === 'tiktok')    result = await downloadTikTok(url, cachedInfo);
    if (platform === 'instagram') result = await downloadInstagram(url, cachedInfo);
    if (platform === 'facebook')  result = await downloadFacebook(url, cachedInfo);
  } catch (err) {
    m.concurrentDownloads--;
    m.requests.failed++;
    console.error(`[/api/download] ${platform} error:`, err.message);
    return res.status(500).json({ error: err.message });
  }

  m.concurrentDownloads--;
  m.requests.success++;

  const { filePath, title } = result;
  const filename  = safeFilename(title, platform);
  const stat      = fs.statSync(filePath);
  const fileSize  = stat.size;

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
