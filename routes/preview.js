/**
 * ============================================
 * MediaSnap — routes/preview.js
 * GET /api/preview?url=<encoded>
 * Fallback if directUrl doesn't work in browser.
 * Downloads to temp file, serves with Range support.
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

// Simple cache: url → { filePath, expires }
const cache   = new Map();
const CACHE_TTL = 10 * 60 * 1000; // 10 min

function getCached(url) {
  const e = cache.get(url);
  if (!e) return null;
  if (Date.now() > e.expires || !fs.existsSync(e.filePath)) {
    try { fs.unlinkSync(e.filePath); } catch (_) {}
    cache.delete(url);
    return null;
  }
  return e.filePath;
}

router.get('/api/preview', async (req, res) => {
  const m   = req.app.locals.metrics;
  const url = (req.query?.url || '').trim();

  if (!url) return res.status(400).json({ error: 'url param required' });

  const platform = detectPlatform(url);
  if (!platform) return res.status(400).json({ error: 'Unsupported URL' });

  if (m.concurrentDownloads >= m.maxConcurrent) {
    return res.status(429).json({ error: 'Server busy. Try again shortly.' });
  }

  let filePath = getCached(url);

  if (!filePath) {
    m.concurrentDownloads++;
    try {
      let result;
      if (platform === 'tiktok')    result = await downloadTikTok(url);
      if (platform === 'instagram') result = await downloadInstagram(url);
      if (platform === 'facebook')  result = await downloadFacebook(url);
      filePath = result.filePath;
      cache.set(url, { filePath, expires: Date.now() + CACHE_TTL });
    } catch (err) {
      m.concurrentDownloads--;
      return res.status(500).json({ error: err.message });
    }
    m.concurrentDownloads--;
  }

  const stat     = fs.statSync(filePath);
  const fileSize = stat.size;
  const range    = req.headers.range;

  if (range) {
    const [startStr, endStr] = range.replace(/bytes=/, '').split('-');
    const start     = parseInt(startStr, 10);
    const end       = endStr ? parseInt(endStr, 10) : fileSize - 1;
    const chunkSize = end - start + 1;
    res.writeHead(206, {
      'Content-Range'  : `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges'  : 'bytes',
      'Content-Length' : chunkSize,
      'Content-Type'   : 'video/mp4',
    });
    fs.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length' : fileSize,
      'Content-Type'   : 'video/mp4',
      'Accept-Ranges'  : 'bytes',
    });
    fs.createReadStream(filePath).pipe(res);
  }
});

module.exports = router;
