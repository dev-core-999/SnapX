/**
 * ============================================
 * MediaSnap — routes/info.js
 * POST /api/info
 * Returns metadata + directUrl for video preview
 * ============================================
 */

'use strict';

const express = require('express');
const router  = express.Router();

const { getTikTokInfo    } = require('../platforms/tiktok');
const { getInstagramInfo } = require('../platforms/instagram');
const { getFacebookInfo  } = require('../platforms/facebook');

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
  const m   = req.app.locals.metrics;
  const url = (req.body?.url || '').trim();

  if (!url) return res.status(400).json({ success: false, error: 'URL is required.' });

  const platform = detectPlatform(url);
  if (!platform) {
    return res.status(400).json({
      success : false,
      error   : 'Unsupported URL. Send a TikTok, Instagram, or Facebook link.',
    });
  }

  m.requests.total++;

  try {
    let info;
    if (platform === 'tiktok')    info = await getTikTokInfo(url);
    if (platform === 'instagram') info = await getInstagramInfo(url);
    if (platform === 'facebook')  info = await getFacebookInfo(url);

    m.requests.success++;

    return res.json({
      success     : true,
      platform    : info.platform,
      title       : info.title,
      uploader    : info.uploader,
      duration    : info.duration,
      thumbnail   : info.thumbnail,
      format      : info.format,
      size        : formatSize(info.filesize) ?? 'Available after download',
      // directUrl → browser video tag plays this directly (no server proxy needed)
      // Falls back to /api/preview if directUrl is null or fails
      directUrl   : info.directUrl || null,
      previewUrl  : `/api/preview?url=${encodeURIComponent(url)}`,
      downloadUrl : `/api/download?url=${encodeURIComponent(url)}`,
      url,
    });
  } catch (err) {
    m.requests.failed++;
    console.error(`[/api/info] ${platform} error:`, err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
