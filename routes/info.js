/**
 * ============================================
 * MediaSnap — routes/info.js
 * POST /api/info
 *
 * ✅ OPTIMIZED v2:
 *   - Metadata + video একসাথে download হয়
 *   - filePath cache এ রাখা হয়
 *   - /api/download এ cache hit হলে instant stream
 * ============================================
 */

'use strict';

const express = require('express');
const router  = express.Router();

const { getTikTokInfo,     downloadTikTok    } = require('../platforms/tiktok');
const { getInstagramInfo,  downloadInstagram } = require('../platforms/instagram');
const { getFacebookInfo,   downloadFacebook  } = require('../platforms/facebook');

function detectPlatform(url) {
  if (/tiktok\.com|vm\.tiktok\.com|vt\.tiktok\.com/i.test(url))  return 'tiktok';
  if (/instagram\.com\/(reel|p|tv)\//i.test(url))                 return 'instagram';
  if (/facebook\.com|fb\.watch|fb\.com/i.test(url))               return 'facebook';
  return null;
}

function formatSize(bytes) {
  if (!bytes || isNaN(bytes) || bytes <= 0) return null;
  if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(2) + ' GB';
  if (bytes >= 1048576)    return (bytes / 1048576).toFixed(2) + ' MB';
  if (bytes >= 1024)       return (bytes / 1024).toFixed(2) + ' KB';
  return bytes + ' B';
}

router.post('/api/info', async (req, res) => {
  const m     = req.app.locals.metrics;
  const cache = req.app.locals.infoCache;
  const url   = (req.body?.url || '').trim();

  if (!url) return res.status(400).json({ success: false, error: 'URL is required.' });

  const platform = detectPlatform(url);
  if (!platform) {
    return res.status(400).json({
      success: false,
      error  : 'Unsupported URL. Send a TikTok, Instagram, or Facebook link.',
    });
  }

  if (m.concurrentDownloads >= m.maxConcurrent) {
    return res.status(429).json({ success: false, error: 'Server busy. Please try again shortly.' });
  }

  m.requests.total++;
  m.concurrentDownloads++;

  try {
    // ✅ Metadata + video file একসাথে আনো (parallel)
    let info, downloadResult;

    if (platform === 'tiktok') {
      [info, downloadResult] = await Promise.all([
        getTikTokInfo(url),
        downloadTikTok(url),
      ]);
    }
    if (platform === 'instagram') {
      [info, downloadResult] = await Promise.all([
        getInstagramInfo(url),
        downloadInstagram(url),
      ]);
    }
    if (platform === 'facebook') {
      [info, downloadResult] = await Promise.all([
        getFacebookInfo(url),
        downloadFacebook(url),
      ]);
    }

    m.concurrentDownloads--;
    m.requests.success++;

    // ✅ info + filePath একসাথে cache এ রাখো
    cache.set(url, {
      ...info,
      filePath: downloadResult.filePath,
      fileSize: downloadResult.size,
    });

    return res.json({
      success    : true,
      platform   : info.platform,
      title      : info.title,
      uploader   : info.uploader,
      duration   : info.duration,
      thumbnail  : info.thumbnail,
      format     : info.format,
      size       : downloadResult.size || formatSize(info.filesize) || 'Available after download',
      directUrl  : info.directUrl || null,
      previewUrl : `/api/preview?url=${encodeURIComponent(url)}`,
      downloadUrl: `/api/download?url=${encodeURIComponent(url)}`,
      url,
    });
  } catch (err) {
    m.concurrentDownloads--;
    m.requests.failed++;
    console.error(`[/api/info] ${platform} error:`, err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
