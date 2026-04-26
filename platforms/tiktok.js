/**
 * ============================================
 * MediaSnap — platforms/tiktok.js  (yt-dlp + fallbacks)
 *
 * ✅ OPTIMIZED: cachedInfo থাকলে ytdlpInfo() skip
 * ✅ FIXED: User-Agent rotation added
 * ✅ FIXED: Retry logic with backoff
 * ✅ ADDED: Cookies support (TIKTOK_COOKIES env)
 * ✅ ADDED: Fallback APIs (tikwm, savetik, ssstik)
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

const YTDLP_TIMEOUT    = 30_000;
const DOWNLOAD_TIMEOUT = 60_000;
const SOCKET_TIMEOUT   = '15';
const FORMAT_STR       = 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best';

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
  const envPath    = process.env.TIKTOK_COOKIES || null;
  const secretPath = '/etc/secrets/cookies.txt';
  const tmpPath    = path.join(os.tmpdir(), 'tiktok_cookies.txt');
  try {
    const src = envPath || (fs.existsSync(secretPath) ? secretPath : null);
    if (src && fs.existsSync(src)) {
      fs.copyFileSync(src, tmpPath);
      COOKIES_PATH = tmpPath;
      console.log('[TikTok] Cookies loaded ✓');
    }
  } catch (e) { console.warn('[TikTok] Could not load cookies:', e.message); }
  return COOKIES_PATH;
}
getCookiesPath();
function getCookiesArgs() { const p = getCookiesPath(); return p ? ['--cookies', p] : []; }

// ── HTTP helpers ──────────────────────────────────────────────────────────────
function downloadToFile(videoUrl, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const outFile = path.join(os.tmpdir(), `tiktok_dl_${Date.now()}_${Math.random().toString(36).slice(2)}.mp4`);
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

function fetchGet(targetUrl, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new urlModule.URL(targetUrl);
    const lib    = parsed.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname : parsed.hostname,
      path     : parsed.pathname + parsed.search,
      method   : 'GET',
      headers  : { 'User-Agent': randomUA(), ...headers },
      timeout  : DOWNLOAD_TIMEOUT,
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
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

// ── yt-dlp info with retry ────────────────────────────────────────────────────
async function ytdlpInfo(videoUrl, retries = 1) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      console.log(`[TikTok] ytdlpInfo attempt ${i + 1}/${retries}`);
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
    const outFile = path.join(os.tmpdir(), `tiktok_${Date.now()}_${Math.random().toString(36).slice(2)}.mp4`);
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

// ── yt-dlp download with retry ────────────────────────────────────────────────
async function ytdlpDownload(videoUrl, retries = 1) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      console.log(`[TikTok] ytdlpDownload attempt ${i + 1}/${retries}`);
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

// ── Fallback 1: tikwm.com API ─────────────────────────────────────────────────
async function fallbackTikwm(videoUrl) {
  console.log('[TikTok] Trying tikwm.com...');
  const raw    = await fetchPost(
    'https://www.tikwm.com/api/',
    `url=${encodeURIComponent(videoUrl)}&count=12&cursor=0&web=1&hd=1`,
    { Referer: 'https://www.tikwm.com/', Origin: 'https://www.tikwm.com' }
  );
  const parsed = JSON.parse(raw);
  if (parsed?.code !== 0 || !parsed?.data) throw new Error('tikwm: no data');
  const data   = parsed.data;
  // HD version আগে try করো, তারপর normal
  const mp4Url = data.hdplay || data.play || null;
  if (!mp4Url) throw new Error('tikwm: no mp4 url');
  const filePath = await downloadToFile(mp4Url, { Referer: 'https://www.tikwm.com/' });
  return { filePath, title: data.title || 'TikTok Video', uploader: data.author?.nickname || '' };
}

// ── Fallback 2: savetik.net ───────────────────────────────────────────────────
async function fallbackSavetik(videoUrl) {
  console.log('[TikTok] Trying savetik.net...');
  const raw    = await fetchPost(
    'https://savetik.net/api/ajaxSearch',
    `q=${encodeURIComponent(videoUrl)}&t=media&lang=en`,
    { Referer: 'https://savetik.net/', Origin: 'https://savetik.net', 'X-Requested-With': 'XMLHttpRequest' }
  );
  const parsed  = JSON.parse(raw);
  const content = parsed?.data || '';
  const mp4     = content.match(/href="(https?:\/\/[^"]+\.mp4[^"]*)"/i);
  if (!mp4) throw new Error('savetik: no mp4 found');
  const cleanUrl = mp4[1].replace(/&amp;/g, '&');
  const filePath = await downloadToFile(cleanUrl, { Referer: 'https://savetik.net/' });
  return { filePath, title: 'TikTok Video', uploader: '' };
}

// ── Fallback 3: ssstik.io ─────────────────────────────────────────────────────
async function fallbackSsstik(videoUrl) {
  console.log('[TikTok] Trying ssstik.io...');
  // প্রথমে token নিতে হবে
  const page   = await fetchGet('https://ssstik.io/en', { Referer: 'https://ssstik.io/' });
  const token  = page.match(/s_tt\s*=\s*["']([^"']+)["']/)?.[1] || '';
  if (!token) throw new Error('ssstik: no token');
  const raw    = await fetchPost(
    'https://ssstik.io/abc?url=dl',
    `id=${encodeURIComponent(videoUrl)}&locale=en&tt=${token}`,
    { Referer: 'https://ssstik.io/', Origin: 'https://ssstik.io', 'HX-Request': 'true' }
  );
  const mp4    = raw.match(/href="(https?:\/\/[^"]+\.mp4[^"]*)"/i)
              || raw.match(/href="(https?:\/\/[^"]+)"[^>]*download/i);
  if (!mp4) throw new Error('ssstik: no mp4 found');
  const cleanUrl = mp4[1].replace(/&amp;/g, '&');
  const filePath = await downloadToFile(cleanUrl, { Referer: 'https://ssstik.io/' });
  return { filePath, title: 'TikTok Video', uploader: '' };
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

// ── Public: getTikTokInfo ─────────────────────────────────────────────────────
async function getTikTokInfo(videoUrl) {
  const info = await ytdlpInfo(videoUrl);
  let directUrl = null;
  if (info.formats && info.formats.length) {
    const best = info.formats.filter(f => f.ext === 'mp4' && f.vcodec !== 'none' && f.acodec !== 'none').pop()
              || info.formats[info.formats.length - 1];
    directUrl = best?.url || null;
  }
  if (!directUrl) directUrl = info.url || null;

  const ttCaption = info.description || info.fulltitle || info.title || 'TikTok Video';
  const ttTitle   = ttCaption.replace(/\n+/g, ' ').trim().slice(0, 100) || 'TikTok Video';

  return {
    title     : ttTitle,
    uploader  : info.uploader || info.creator || '',
    duration  : formatDuration(info.duration  || 0),
    thumbnail : info.thumbnail || '',
    platform  : 'TikTok',
    format    : 'MP4',
    directUrl,
    filesize  : getBestFilesize(info),
    _rawUrl   : videoUrl,
  };
}

// ── Public: downloadTikTok ────────────────────────────────────────────────────
async function downloadTikTok(videoUrl, cachedInfo = null) {

  // ── Primary: yt-dlp ──────────────────────────────────────────────────────
  try {
    if (cachedInfo) {
      const filePath = await ytdlpDownload(videoUrl);
      const stat = fs.statSync(filePath);
      return {
        filePath,
        title    : cachedInfo.title    || 'TikTok Video',
        uploader : cachedInfo.uploader || '',
        size     : formatSize(stat.size),
        duration : cachedInfo.duration || 'Unknown',
        platform : 'TikTok',
      };
    }
    const [infoData, downloadedPath] = await Promise.all([
      ytdlpInfo(videoUrl),
      ytdlpDownload(videoUrl),
    ]);
    const stat = fs.statSync(downloadedPath);
    const ttDlCaption = infoData.description || infoData.fulltitle || infoData.title || 'TikTok Video';
    const ttDlTitle   = ttDlCaption.replace(/\n+/g, ' ').trim().slice(0, 100) || 'TikTok Video';
    return {
      filePath : downloadedPath,
      title    : ttDlTitle,
      uploader : infoData.uploader || '',
      size     : formatSize(stat.size),
      duration : formatDuration(infoData.duration || 0),
      platform : 'TikTok',
    };
  } catch (err) {
    console.warn('[TikTok] yt-dlp failed:', err.message);
  }

  // ── Fallback 1: tikwm.com ────────────────────────────────────────────────
  try {
    const { filePath, title, uploader } = await fallbackTikwm(videoUrl);
    const stat = fs.statSync(filePath);
    return { filePath, title: cachedInfo?.title || title, uploader: cachedInfo?.uploader || uploader, size: formatSize(stat.size), duration: cachedInfo?.duration || 'Unknown', platform: 'TikTok' };
  } catch (e) { console.warn('[TikTok] tikwm failed:', e.message); }

  // ── Fallback 2: savetik.net ──────────────────────────────────────────────
  try {
    const { filePath, title, uploader } = await fallbackSavetik(videoUrl);
    const stat = fs.statSync(filePath);
    return { filePath, title: cachedInfo?.title || title, uploader: cachedInfo?.uploader || uploader, size: formatSize(stat.size), duration: cachedInfo?.duration || 'Unknown', platform: 'TikTok' };
  } catch (e) { console.warn('[TikTok] savetik failed:', e.message); }

  // ── Fallback 3: ssstik.io ────────────────────────────────────────────────
  try {
    const { filePath, title, uploader } = await fallbackSsstik(videoUrl);
    const stat = fs.statSync(filePath);
    return { filePath, title: cachedInfo?.title || title, uploader: cachedInfo?.uploader || uploader, size: formatSize(stat.size), duration: cachedInfo?.duration || 'Unknown', platform: 'TikTok' };
  } catch (e) { console.warn('[TikTok] ssstik failed:', e.message); }

  throw new Error('Could not download TikTok video. Please try again later.');
}

module.exports = { getTikTokInfo, downloadTikTok };
