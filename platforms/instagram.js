/**
 * ============================================
 * MediaSnap — platforms/instagram.js
 *
 * ✅ Primary  : yt-dlp (User-Agent rotation + retry)
 * ✅ Fallback1: snapinsta.app
 * ✅ Fallback2: saveig.app
 * ✅ Fallback3: reelsaver.net
 * ✅ FIXED    : cookies /tmp/ এ copy
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

const YTDLP_TIMEOUT    = 120_000;
const DOWNLOAD_TIMEOUT = 60_000;
const SOCKET_TIMEOUT   = '30';
const FORMAT_STR       = 'best[ext=mp4][vcodec!=none][acodec!=none]/best[ext=mp4]/best';

// ── User-Agent pool ───────────────────────────────────────────────────────────
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Mobile/15E148 Safari/604.1',
];
function randomUA() { return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]; }
function sleep(ms)  { return new Promise(r => setTimeout(r, ms)); }

// ── Cookies ───────────────────────────────────────────────────────────────────
let COOKIES_PATH = null;
function getCookiesPath() {
  if (COOKIES_PATH) return COOKIES_PATH;
  const secretPath = '/etc/secrets/cookies.txt';
  const tmpPath    = path.join(os.tmpdir(), 'instagram_cookies.txt');
  try {
    if (fs.existsSync(secretPath)) {
      fs.copyFileSync(secretPath, tmpPath);
      COOKIES_PATH = tmpPath;
      console.log('[Instagram] Cookies copied to /tmp ✓');
    }
  } catch (e) { console.warn('[Instagram] Could not copy cookies:', e.message); }
  return COOKIES_PATH;
}
getCookiesPath();
function getCookiesArgs() { const p = getCookiesPath(); return p ? ['--cookies', p] : []; }

// ── HTTP helpers ──────────────────────────────────────────────────────────────
function downloadToFile(videoUrl, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const outFile = path.join(os.tmpdir(), `ig_dl_${Date.now()}_${Math.random().toString(36).slice(2)}.mp4`);
    const doRequest = (url, redirectCount = 0) => {
      if (redirectCount > 5) return reject(new Error('Too many redirects'));
      let parsed;
      try { parsed = new urlModule.URL(url); } catch (e) { return reject(new Error('Invalid URL: ' + url)); }
      const lib = parsed.protocol === 'https:' ? https : http;
      const req = lib.request({
        hostname : parsed.hostname,
        path     : parsed.pathname + parsed.search,
        method   : 'GET',
        headers  : { 'User-Agent': randomUA(), 'Accept': 'video/mp4,video/*,*/*', 'Accept-Encoding': 'identity', ...extraHeaders },
        timeout  : DOWNLOAD_TIMEOUT,
      }, (res) => {
        if ([301,302,307,308].includes(res.statusCode) && res.headers.location) return doRequest(res.headers.location, redirectCount + 1);
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        const fileStream = fs.createWriteStream(outFile);
        res.pipe(fileStream);
        fileStream.on('finish', () => resolve(outFile));
        fileStream.on('error', (e) => { fs.unlink(outFile, () => {}); reject(e); });
        res.on('error', (e) => { fs.unlink(outFile, () => {}); reject(e); });
      });
      req.on('error', (e) => { fs.unlink(outFile, () => {}); reject(e); });
      req.on('timeout', () => { req.destroy(); reject(new Error('Download timeout')); });
      req.end();
    };
    doRequest(videoUrl);
  });
}

function fetchPost(targetUrl, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new urlModule.URL(targetUrl);
    const lib    = parsed.protocol === 'https:' ? https : http;
    const buf    = Buffer.from(body);
    const req = lib.request({
      hostname : parsed.hostname,
      path     : parsed.pathname + parsed.search,
      method   : 'POST',
      headers  : { 'User-Agent': randomUA(), 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': buf.length, ...headers },
      timeout  : DOWNLOAD_TIMEOUT,
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(buf);
    req.end();
  });
}

// ── yt-dlp ────────────────────────────────────────────────────────────────────
function ytdlpInfoOnce(videoUrl, ua) {
  return new Promise((resolve, reject) => {
    const args = [
      '--dump-json', '--no-playlist', '--playlist-items', '1',
      '--no-warnings', '--quiet',
      '--socket-timeout', SOCKET_TIMEOUT,
      '--user-agent', ua,
      '--add-header', 'Accept-Language:en-US,en;q=0.9',
      '--extractor-args', 'instagram:api=0',
      '--sleep-requests', '1',
      '--format', FORMAT_STR,
      ...getCookiesArgs(),
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
      console.log(`[Instagram] ytdlpInfo attempt ${i + 1}/${retries}`);
      return await ytdlpInfoOnce(videoUrl, randomUA());
    } catch (err) {
      lastErr = err;
      const isRateLimit = /rate.limit|login required|not available|429/i.test(err.message);
      if (isRateLimit && i < retries - 1) { await sleep((i + 1) * 3000); }
      else { break; }
    }
  }
  throw lastErr;
}

function ytdlpDownloadOnce(videoUrl, ua) {
  return new Promise((resolve, reject) => {
    const outFile = path.join(os.tmpdir(), `instagram_${Date.now()}_${Math.random().toString(36).slice(2)}.mp4`);
    const args = [
      '--no-playlist', '--playlist-items', '1',
      '--no-warnings', '--quiet',
      '--socket-timeout', SOCKET_TIMEOUT,
      '--user-agent', ua,
      '--add-header', 'Accept-Language:en-US,en;q=0.9',
      '--extractor-args', 'instagram:api=0',
      '--sleep-requests', '1',
      '--format', FORMAT_STR,
      '--merge-output-format', 'mp4',
      '--output', outFile,
      ...getCookiesArgs(),
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
      console.log(`[Instagram] ytdlpDownload attempt ${i + 1}/${retries}`);
      return await ytdlpDownloadOnce(videoUrl, randomUA());
    } catch (err) {
      lastErr = err;
      const isRateLimit = /rate.limit|login required|not available|429/i.test(err.message);
      if (isRateLimit && i < retries - 1) { await sleep((i + 1) * 3000); }
      else { break; }
    }
  }
  throw lastErr;
}

// ── Fallback: snapinsta.app ───────────────────────────────────────────────────
async function fallbackSnapinsta(videoUrl) {
  const raw    = await fetchPost(
    'https://snapinsta.app/action.php',
    `url=${encodeURIComponent(videoUrl)}&lang=en`,
    { Referer: 'https://snapinsta.app/', Origin: 'https://snapinsta.app' }
  );
  const parsed = JSON.parse(raw);
  const inner  = parsed?.data || parsed?.html || '';
  const mp4    = inner.match(/href="(https?:\/\/[^"]+\.mp4[^"]*)"/i)
              || inner.match(/href="(https?:\/\/[^"]+)"\s+[^>]*download/i);
  if (!mp4) throw new Error('snapinsta: no mp4 found');
  const cleanUrl = mp4[1].replace(/&amp;/g, '&');
  return await downloadToFile(cleanUrl, { Referer: 'https://snapinsta.app/' });
}

// ── Fallback: saveig.app ──────────────────────────────────────────────────────
async function fallbackSaveig(videoUrl) {
  const raw    = await fetchPost(
    'https://saveig.app/api/ajaxSearch',
    `q=${encodeURIComponent(videoUrl)}&t=media&lang=en`,
    { Referer: 'https://saveig.app/', Origin: 'https://saveig.app', 'X-Requested-With': 'XMLHttpRequest' }
  );
  const parsed  = JSON.parse(raw);
  const content = parsed?.data || '';
  const mp4     = content.match(/href="(https?:\/\/[^"]+\.mp4[^"]*)"/i);
  if (!mp4) throw new Error('saveig: no mp4 found');
  const cleanUrl = mp4[1].replace(/&amp;/g, '&');
  return await downloadToFile(cleanUrl, { Referer: 'https://saveig.app/' });
}

// ── Fallback: reelsaver.net ───────────────────────────────────────────────────
async function fallbackReelsaver(videoUrl) {
  const raw    = await fetchPost(
    'https://reelsaver.net/wp-json/aio-dl/video-data/',
    `url=${encodeURIComponent(videoUrl)}`,
    { Referer: 'https://reelsaver.net/', Origin: 'https://reelsaver.net' }
  );
  const parsed = JSON.parse(raw);
  const medias = parsed?.medias || [];
  const video  = medias.find(m => m.url);
  if (!video?.url) throw new Error('reelsaver: no url found');
  return await downloadToFile(video.url, { Referer: 'https://reelsaver.net/' });
}

// ── Formatters ────────────────────────────────────────────────────────────────
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
    const sizes = info.formats.map(f => f.filesize || f.filesize_approx || 0).filter(Boolean);
    if (sizes.length) return sizes.reduce((a, b) => a + b, 0);
  }
  return null;
}

// ── Public: getInstagramInfo ──────────────────────────────────────────────────
async function getInstagramInfo(videoUrl) {
  const info = await ytdlpInfo(videoUrl);
  let directUrl = null;
  if (info.formats && info.formats.length) {
    const best = info.formats.filter(f => f.ext === 'mp4' && f.vcodec !== 'none' && f.acodec !== 'none').pop()
              || info.formats[info.formats.length - 1];
    directUrl = best?.url || null;
  }
  if (!directUrl) directUrl = info.url || null;
  // caption/description আসল post এর text — title এর চেয়ে ভালো
  const caption = info.description || info.fulltitle || info.title || 'Instagram Video';
  // caption অনেক লম্বা হতে পারে, তাই 100 char এ trim করা হয়
  const title = caption.replace(/\n+/g, ' ').trim().slice(0, 100) || 'Instagram Video';

  return {
    title,
    uploader  : info.uploader || info.creator || '',
    duration  : formatDuration(info.duration  || 0),
    thumbnail : info.thumbnail || '',
    platform  : 'Instagram',
    format    : 'MP4',
    directUrl,
    filesize  : getBestFilesize(info),
    _rawUrl   : videoUrl,
  };
}

// ── Public: downloadInstagram ─────────────────────────────────────────────────
async function downloadInstagram(videoUrl, cachedInfo = null) {

  // ── Primary: yt-dlp ───────────────────────────────────────────────────────
  try {
    if (cachedInfo) {
      const filePath = await ytdlpDownload(videoUrl);
      const stat = fs.statSync(filePath);
      return { filePath, title: cachedInfo.title || 'Instagram Video', uploader: cachedInfo.uploader || '', size: formatSize(stat.size), duration: cachedInfo.duration || 'Unknown', platform: 'Instagram' };
    }
    const [infoData, filePath] = await Promise.all([ytdlpInfo(videoUrl), ytdlpDownload(videoUrl)]);
    const stat = fs.statSync(filePath);
    const dlCaption = infoData.description || infoData.fulltitle || infoData.title || 'Instagram Video';
    const dlTitle   = dlCaption.replace(/\n+/g, ' ').trim().slice(0, 100) || 'Instagram Video';
    return { filePath, title: dlTitle, uploader: infoData.uploader || '', size: formatSize(stat.size), duration: formatDuration(infoData.duration || 0), platform: 'Instagram' };
  } catch (err) {
    console.warn('[Instagram] yt-dlp failed:', err.message);
  }

  // ── Fallback 1: snapinsta.app ─────────────────────────────────────────────
  try {
    console.log('[Instagram] Trying snapinsta.app...');
    const filePath = await fallbackSnapinsta(videoUrl);
    const stat = fs.statSync(filePath);
    return { filePath, title: cachedInfo?.title || 'Instagram Video', uploader: cachedInfo?.uploader || '', size: formatSize(stat.size), duration: cachedInfo?.duration || 'Unknown', platform: 'Instagram' };
  } catch (e) { console.warn('[Instagram] snapinsta failed:', e.message); }

  // ── Fallback 2: saveig.app ────────────────────────────────────────────────
  try {
    console.log('[Instagram] Trying saveig.app...');
    const filePath = await fallbackSaveig(videoUrl);
    const stat = fs.statSync(filePath);
    return { filePath, title: cachedInfo?.title || 'Instagram Video', uploader: cachedInfo?.uploader || '', size: formatSize(stat.size), duration: cachedInfo?.duration || 'Unknown', platform: 'Instagram' };
  } catch (e) { console.warn('[Instagram] saveig failed:', e.message); }

  // ── Fallback 3: reelsaver.net ─────────────────────────────────────────────
  try {
    console.log('[Instagram] Trying reelsaver.net...');
    const filePath = await fallbackReelsaver(videoUrl);
    const stat = fs.statSync(filePath);
    return { filePath, title: cachedInfo?.title || 'Instagram Video', uploader: cachedInfo?.uploader || '', size: formatSize(stat.size), duration: cachedInfo?.duration || 'Unknown', platform: 'Instagram' };
  } catch (e) { console.warn('[Instagram] reelsaver failed:', e.message); }

  throw new Error('Could not download Instagram video. Make sure the post/reel is public.');
}

module.exports = { getInstagramInfo, downloadInstagram };
