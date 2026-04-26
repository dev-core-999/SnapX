/**
 * ============================================
 * MediaSnap — platforms/facebook.js  (yt-dlp + fallbacks)
 *
 * ✅ OPTIMIZED: cachedInfo থাকলে ytdlpInfo() skip
 * ✅ FIXED: User-Agent rotation added
 * ✅ FIXED: Retry logic with backoff
 * ✅ ADDED: Cookies support (FACEBOOK_COOKIES env)
 * ✅ ADDED: Fallback APIs (getfvid, savefrom, fbdownloader)
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
const FORMAT_STR =
  'bestvideo[ext=mp4][height>=1080]+bestaudio[ext=m4a]/' +
  'bestvideo[ext=mp4][height>=720]+bestaudio[ext=m4a]/'  +
  'bestvideo[ext=mp4][height>=480]+bestaudio[ext=m4a]/'  +
  'bestvideo[ext=mp4]+bestaudio[ext=m4a]/'               +
  'bestvideo+bestaudio/'                                  +
  'best[ext=mp4]/best';

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
  const envPath    = process.env.FACEBOOK_COOKIES || null;
  const secretPath = '/etc/secrets/cookies.txt';
  const tmpPath    = path.join(os.tmpdir(), 'facebook_cookies.txt');
  try {
    const src = envPath || (fs.existsSync(secretPath) ? secretPath : null);
    if (src && fs.existsSync(src)) {
      fs.copyFileSync(src, tmpPath);
      COOKIES_PATH = tmpPath;
      console.log('[Facebook] Cookies loaded ✓');
    }
  } catch (e) { console.warn('[Facebook] Could not load cookies:', e.message); }
  return COOKIES_PATH;
}
getCookiesPath();
function getCookiesArgs() { const p = getCookiesPath(); return p ? ['--cookies', p] : []; }

// ── HTTP helpers ──────────────────────────────────────────────────────────────
function downloadToFile(videoUrl, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const outFile = path.join(os.tmpdir(), `fb_dl_${Date.now()}_${Math.random().toString(36).slice(2)}.mp4`);
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

// ── Redirect resolver ─────────────────────────────────────────────────────────
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

// ── yt-dlp info (single attempt) ─────────────────────────────────────────────
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

// ── yt-dlp download (single attempt) ─────────────────────────────────────────
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

// ── Fallback 1: getfvid.com ───────────────────────────────────────────────────
async function fallbackGetfvid(videoUrl) {
  console.log('[Facebook] Trying getfvid.com...');
  const raw    = await fetchPost(
    'https://www.getfvid.com/downloader',
    `url=${encodeURIComponent(videoUrl)}`,
    { Referer: 'https://www.getfvid.com/', Origin: 'https://www.getfvid.com' }
  );
  // HD mp4 আগে try করো
  const hdMp4  = raw.match(/href="(https?:\/\/[^"]+\.mp4[^"]*)"[^>]*>.*?HD/i)
              || raw.match(/href="(https?:\/\/[^"]+\.mp4[^"]*)"/i);
  if (!hdMp4) throw new Error('getfvid: no mp4 found');
  const cleanUrl = hdMp4[1].replace(/&amp;/g, '&');
  const filePath = await downloadToFile(cleanUrl, { Referer: 'https://www.getfvid.com/' });
  return { filePath, title: 'Facebook Video', uploader: '' };
}

// ── Fallback 2: savefrom.net ──────────────────────────────────────────────────
async function fallbackSavefrom(videoUrl) {
  console.log('[Facebook] Trying savefrom.net...');
  const raw    = await fetchPost(
    'https://savefrom.net/api/convert',
    `url=${encodeURIComponent(videoUrl)}&lang=en`,
    { Referer: 'https://savefrom.net/', Origin: 'https://savefrom.net', 'X-Requested-With': 'XMLHttpRequest' }
  );
  const parsed = JSON.parse(raw);
  const medias = parsed?.url || [];
  // সবচেয়ে ভালো quality এর mp4 নেও
  const best   = medias
    .filter(m => m.ext === 'mp4' && m.url)
    .sort((a, b) => (parseInt(b.quality) || 0) - (parseInt(a.quality) || 0))[0];
  if (!best?.url) throw new Error('savefrom: no mp4 found');
  const filePath = await downloadToFile(best.url, { Referer: 'https://savefrom.net/' });
  return { filePath, title: parsed?.meta?.title || 'Facebook Video', uploader: '' };
}

// ── Fallback 3: fdownloader.net ───────────────────────────────────────────────
async function fallbackFdownloader(videoUrl) {
  console.log('[Facebook] Trying fdownloader.net...');
  const raw    = await fetchPost(
    'https://fdownloader.net/api/ajaxSearch',
    `q=${encodeURIComponent(videoUrl)}&t=media&lang=en`,
    { Referer: 'https://fdownloader.net/', Origin: 'https://fdownloader.net', 'X-Requested-With': 'XMLHttpRequest' }
  );
  const parsed  = JSON.parse(raw);
  const content = parsed?.data || '';
  const mp4     = content.match(/href="(https?:\/\/[^"]+\.mp4[^"]*)"/i)
              || content.match(/href="(https?:\/\/[^"]+)"[^>]*download/i);
  if (!mp4) throw new Error('fdownloader: no mp4 found');
  const cleanUrl = mp4[1].replace(/&amp;/g, '&');
  const filePath = await downloadToFile(cleanUrl, { Referer: 'https://fdownloader.net/' });
  return { filePath, title: 'Facebook Video', uploader: '' };
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
    const sizes = info.formats
      .map(f => f.filesize || f.filesize_approx || 0)
      .filter(Boolean);
    if (sizes.length) return sizes.reduce((a, b) => a + b, 0);
  }
  return null;
}

// ── Public: getFacebookInfo ───────────────────────────────────────────────────
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

// ── Public: downloadFacebook ──────────────────────────────────────────────────
async function downloadFacebook(videoUrl, cachedInfo = null) {
  let finalUrl = videoUrl;
  if (cachedInfo?._rawUrl) {
    finalUrl = cachedInfo._rawUrl;
  } else if (/fb\.watch/i.test(videoUrl)) {
    finalUrl = await resolveRedirect(videoUrl);
  }

  // ── Primary: yt-dlp ──────────────────────────────────────────────────────
  try {
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
  } catch (err) {
    console.warn('[Facebook] yt-dlp failed:', err.message);
  }

  // ── Fallback 1: getfvid.com ──────────────────────────────────────────────
  try {
    const { filePath, title, uploader } = await fallbackGetfvid(finalUrl);
    const stat = fs.statSync(filePath);
    return { filePath, title: cachedInfo?.title || title, uploader: cachedInfo?.uploader || uploader, size: formatSize(stat.size), duration: cachedInfo?.duration || 'Unknown', platform: 'Facebook' };
  } catch (e) { console.warn('[Facebook] getfvid failed:', e.message); }

  // ── Fallback 2: savefrom.net ─────────────────────────────────────────────
  try {
    const { filePath, title, uploader } = await fallbackSavefrom(finalUrl);
    const stat = fs.statSync(filePath);
    return { filePath, title: cachedInfo?.title || title, uploader: cachedInfo?.uploader || uploader, size: formatSize(stat.size), duration: cachedInfo?.duration || 'Unknown', platform: 'Facebook' };
  } catch (e) { console.warn('[Facebook] savefrom failed:', e.message); }

  // ── Fallback 3: fdownloader.net ──────────────────────────────────────────
  try {
    const { filePath, title, uploader } = await fallbackFdownloader(finalUrl);
    const stat = fs.statSync(filePath);
    return { filePath, title: cachedInfo?.title || title, uploader: cachedInfo?.uploader || uploader, size: formatSize(stat.size), duration: cachedInfo?.duration || 'Unknown', platform: 'Facebook' };
  } catch (e) { console.warn('[Facebook] fdownloader failed:', e.message); }

  throw new Error('Could not download Facebook video. Please try again later.');
}

module.exports = { getFacebookInfo, downloadFacebook };
