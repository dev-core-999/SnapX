/**
 * ============================================
 * MediaSnap — platforms/facebook.js  (yt-dlp only)
 *
 * ✅ OPTIMIZED: cachedInfo থাকলে ytdlpInfo() skip
 * ✅ FIXED: User-Agent rotation added
 * ✅ FIXED: Retry logic with backoff
 * ============================================
 */

'use strict';

const { execFile, spawn } = require('child_process');
const fs        = require('fs');
const path      = require('path');
const os        = require('os');
const https     = require('https');
const http      = require('http');
const urlModule = require('url');

const YTDLP_TIMEOUT  = 120_000;
const SOCKET_TIMEOUT = '30';
const FORMAT_STR =
  'bestvideo[ext=mp4][height>=720]+bestaudio[ext=m4a]/' +
  'bestvideo[ext=mp4]+bestaudio[ext=m4a]/' +
  'best[ext=mp4]/best';

// ── User-Agent pool ───────────────────────────────────────────────────────────
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Mobile/15E148 Safari/604.1',
];

function randomUA() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function resolveRedirect(shortUrl) {
  return new Promise((resolve) => {
    try {
      const parsed = new urlModule.URL(shortUrl);
      const lib    = parsed.protocol === 'https:' ? https : http;
      const req    = lib.request(
        { hostname: parsed.hostname, path: parsed.pathname + parsed.search, method: 'HEAD', headers: { 'User-Agent': randomUA() }, timeout: 10000 },
        (res) => resolve(res.headers.location || shortUrl)
      );
      req.on('error', () => resolve(shortUrl));
      req.end();
    } catch { resolve(shortUrl); }
  });
}

function ytdlpInfoOnce(videoUrl, ua) {
  return new Promise((resolve, reject) => {
    const args = [
      '--dump-json', '--no-playlist', '--playlist-items', '1',
      '--no-warnings', '--quiet',
      '--socket-timeout', SOCKET_TIMEOUT,
      '--user-agent', ua,
      '--add-header', 'Accept-Language:en-US,en;q=0.9',
      '--add-header', 'Accept:text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      '--format', FORMAT_STR,
      videoUrl,
    ];
    const proc = execFile('yt-dlp', args,
      { timeout: YTDLP_TIMEOUT, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(err.message || stderr || 'yt-dlp info failed'));
        try { resolve(JSON.parse(stdout.trim().split('\n')[0])); }
        catch { reject(new Error('yt-dlp returned invalid JSON')); }
      }
    );
    setTimeout(() => { try { proc.kill('SIGKILL'); } catch (_) {} }, YTDLP_TIMEOUT + 5000);
  });
}

async function ytdlpInfo(videoUrl, retries = 3) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      console.log(`[Facebook] ytdlpInfo attempt ${i + 1}/${retries}`);
      return await ytdlpInfoOnce(videoUrl, randomUA());
    } catch (err) {
      lastErr = err;
      const isRetryable = /rate.limit|429|temporarily/i.test(err.message);
      if (isRetryable && i < retries - 1) {
        await sleep((i + 1) * 2000);
      } else { break; }
    }
  }
  throw lastErr;
}

function ytdlpDownloadOnce(videoUrl, ua) {
  return new Promise((resolve, reject) => {
    const outFile = path.join(os.tmpdir(), `facebook_${Date.now()}_${Math.random().toString(36).slice(2)}.mp4`);
    const args = [
      '--no-playlist', '--playlist-items', '1',
      '--no-warnings', '--quiet',
      '--socket-timeout', SOCKET_TIMEOUT,
      '--user-agent', ua,
      '--add-header', 'Accept-Language:en-US,en;q=0.9',
      '--add-header', 'Accept:text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      '--format', FORMAT_STR,
      '--merge-output-format', 'mp4',
      '--output', outFile,
      videoUrl,
    ];
    const proc = spawn('yt-dlp', args);
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });
    const killer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch (_) {} reject(new Error('timed out')); }, YTDLP_TIMEOUT);
    proc.on('close', (code) => {
      clearTimeout(killer);
      if (code !== 0) return reject(new Error(`yt-dlp failed: ${stderr.slice(0, 300)}`));
      if (!fs.existsSync(outFile)) return reject(new Error('Output file not found'));
      resolve(outFile);
    });
    proc.on('error', (e) => { clearTimeout(killer); reject(e); });
  });
}

async function ytdlpDownload(videoUrl, retries = 3) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      console.log(`[Facebook] ytdlpDownload attempt ${i + 1}/${retries}`);
      return await ytdlpDownloadOnce(videoUrl, randomUA());
    } catch (err) {
      lastErr = err;
      const isRetryable = /rate.limit|429|temporarily/i.test(err.message);
      if (isRetryable && i < retries - 1) {
        await sleep((i + 1) * 2000);
      } else { break; }
    }
  }
  throw lastErr;
}

function formatSize(bytes) {
  if (!bytes || bytes <= 0) return 'Unknown';
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(2)} MB` : `${(bytes / 1024).toFixed(1)} KB`;
}

function formatDuration(sec) {
  if (!sec || sec <= 0) return 'Unknown';
  const t = Math.floor(sec), h = Math.floor(t/3600), m = Math.floor((t%3600)/60), s = t%60;
  return h > 0 ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}` : `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

function getBestFilesize(info) {
  if (info.filesize)        return info.filesize;
  if (info.filesize_approx) return info.filesize_approx;
  if (Array.isArray(info.formats) && info.formats.length) {
    const best = info.formats
      .filter(f => f.ext === 'mp4' && f.vcodec !== 'none' && f.acodec !== 'none')
      .pop() || info.formats[info.formats.length - 1];
    if (best?.filesize)        return best.filesize;
    if (best?.filesize_approx) return best.filesize_approx;
    const sizes = info.formats
      .map(f => f.filesize || f.filesize_approx || 0)
      .filter(Boolean);
    if (sizes.length) return sizes.reduce((a, b) => a + b, 0);
  }
  return null;
}

async function getFacebookInfo(videoUrl) {
  let finalUrl = videoUrl;
  if (/fb\.watch/i.test(videoUrl)) finalUrl = await resolveRedirect(videoUrl);

  const info = await ytdlpInfo(finalUrl);
  let directUrl = null;
  if (info.formats && info.formats.length) {
    const best = info.formats.filter(f => f.ext === 'mp4' && f.vcodec !== 'none' && f.acodec !== 'none').pop()
              || info.formats[info.formats.length - 1];
    directUrl = best?.url || null;
  }
  if (!directUrl) directUrl = info.url || null;

  const fbCaption = info.description || info.fulltitle || info.title || 'Facebook Video';
  const fbTitle   = fbCaption.replace(/\n+/g, ' ').trim().slice(0, 100) || 'Facebook Video';

  return {
    title     : fbTitle,
    uploader  : info.uploader || info.creator || '',
    duration  : formatDuration(info.duration  || 0),
    thumbnail : info.thumbnail || '',
    platform  : 'Facebook',
    format    : 'MP4',
    directUrl,
    filesize  : getBestFilesize(info),
    _rawUrl   : finalUrl,
  };
}

// ✅ cachedInfo দেওয়া থাকলে ytdlpInfo() skip করা হয়
async function downloadFacebook(videoUrl, cachedInfo = null) {
  let finalUrl = videoUrl;
  if (cachedInfo?._rawUrl) {
    finalUrl = cachedInfo._rawUrl;
  } else if (/fb\.watch/i.test(videoUrl)) {
    finalUrl = await resolveRedirect(videoUrl);
  }

  if (cachedInfo) {
    const filePath = await ytdlpDownload(finalUrl);
    const stat = fs.statSync(filePath);
    return {
      filePath,
      title    : cachedInfo.title    || 'Facebook Video',
      uploader : cachedInfo.uploader || '',
      size     : formatSize(stat.size),
      duration : cachedInfo.duration || 'Unknown',
      platform : 'Facebook',
    };
  }

  const [infoData, filePath] = await Promise.all([
    ytdlpInfo(finalUrl),
    ytdlpDownload(finalUrl),
  ]);
  const stat = fs.statSync(filePath);
  const fbDlCaption = infoData.description || infoData.fulltitle || infoData.title || 'Facebook Video';
  const fbDlTitle   = fbDlCaption.replace(/\n+/g, ' ').trim().slice(0, 100) || 'Facebook Video';
  return {
    filePath,
    title    : fbDlTitle,
    uploader : infoData.uploader || '',
    size     : formatSize(stat.size),
    duration : formatDuration(infoData.duration || 0),
    platform : 'Facebook',
  };
}

module.exports = { getFacebookInfo, downloadFacebook };
