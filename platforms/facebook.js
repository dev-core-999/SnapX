/**
 * ============================================
 * MediaSnap — platforms/facebook.js  (yt-dlp only)
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
// Facebook: prefer HD
const FORMAT_STR =
  'bestvideo[ext=mp4][height>=720]+bestaudio[ext=m4a]/' +
  'bestvideo[ext=mp4]+bestaudio[ext=m4a]/' +
  'best[ext=mp4]/best';

// fb.watch redirect resolver
function resolveRedirect(shortUrl) {
  return new Promise((resolve) => {
    try {
      const parsed = new urlModule.URL(shortUrl);
      const lib    = parsed.protocol === 'https:' ? https : http;
      const req    = lib.request(
        { hostname: parsed.hostname, path: parsed.pathname + parsed.search, method: 'HEAD', headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 10000 },
        (res) => resolve(res.headers.location || shortUrl)
      );
      req.on('error', () => resolve(shortUrl));
      req.end();
    } catch { resolve(shortUrl); }
  });
}

function ytdlpInfo(videoUrl) {
  return new Promise((resolve, reject) => {
    const args = [
      '--dump-json', '--no-playlist', '--playlist-items', '1',
      '--no-warnings', '--quiet',
      '--socket-timeout', SOCKET_TIMEOUT,
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

function ytdlpDownload(videoUrl) {
  return new Promise((resolve, reject) => {
    const outFile = path.join(os.tmpdir(), `facebook_${Date.now()}_${Math.random().toString(36).slice(2)}.mp4`);
    const args = [
      '--no-playlist', '--playlist-items', '1',
      '--no-warnings', '--quiet',
      '--socket-timeout', SOCKET_TIMEOUT,
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

  return {
    title     : info.title    || 'Facebook Video',
    uploader  : info.uploader || info.creator || '',
    duration  : formatDuration(info.duration  || 0),
    thumbnail : info.thumbnail || '',
    platform  : 'Facebook',
    format    : 'MP4',
    directUrl,
    filesize  : info.filesize ?? info.filesize_approx ?? null,
    _rawUrl   : finalUrl,
  };
}

async function downloadFacebook(videoUrl) {
  let finalUrl = videoUrl;
  if (/fb\.watch/i.test(videoUrl)) finalUrl = await resolveRedirect(videoUrl);

  const [infoData, filePath] = await Promise.all([ytdlpInfo(finalUrl), ytdlpDownload(finalUrl)]);
  const stat = fs.statSync(filePath);
  return {
    filePath,
    title    : infoData.title    || 'Facebook Video',
    uploader : infoData.uploader || '',
    size     : formatSize(stat.size),
    duration : formatDuration(infoData.duration || 0),
    platform : 'Facebook',
  };
}

module.exports = { getFacebookInfo, downloadFacebook };
