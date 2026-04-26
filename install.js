/**
 * ============================================
 * MediaSnap — install.js
 * Auto-installs yt-dlp + ffmpeg at startup
 * (Required for Render / cloud deployments)
 * ============================================
 */

'use strict';

const { execSync, execFile } = require('child_process');
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const https = require('https');

// ── Install paths ─────────────────────────────────────────────────────────────
// Render allows writing to /tmp and the project directory
const BIN_DIR  = path.join(os.homedir(), '.local', 'bin');
const YTDLP    = path.join(BIN_DIR, 'yt-dlp');

// ── Helpers ───────────────────────────────────────────────────────────────────
function log(msg)  { console.log(`[install] ${msg}`); }
function warn(msg) { console.warn(`[install] ⚠  ${msg}`); }

function isAvailable(cmd) {
  try {
    execSync(`which ${cmd}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function ensureBinDir() {
  if (!fs.existsSync(BIN_DIR)) fs.mkdirSync(BIN_DIR, { recursive: true });

  // Add BIN_DIR to PATH for this process
  const current = process.env.PATH || '';
  if (!current.includes(BIN_DIR)) {
    process.env.PATH = `${BIN_DIR}:${current}`;
  }
}

// ── Download a file via HTTPS (follows redirect) ──────────────────────────────
function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const follow = (u) => {
      https.get(u, { headers: { 'User-Agent': 'MediaSnap/1.0' } }, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) {
          return follow(res.headers.location);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode} for ${u}`));
        }
        const out = fs.createWriteStream(dest);
        res.pipe(out);
        out.on('finish', () => out.close(resolve));
        out.on('error', reject);
      }).on('error', reject);
    };
    follow(url);
  });
}

// ── Install yt-dlp ────────────────────────────────────────────────────────────
async function installYtDlp() {
  // সবসময় latest version download করো — পুরনো version TikTok break করে
  log('Downloading latest yt-dlp...');
  const url = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';
  await downloadFile(url, YTDLP);
  fs.chmodSync(YTDLP, 0o755);

  try {
    const v = execSync(`${YTDLP} --version`, { encoding: 'utf8' }).trim();
    log(`yt-dlp installed/updated  ✓  (${v})`);
  } catch (e) {
    warn(`yt-dlp installed but version check failed: ${e.message}`);
  }
}

// ── Install ffmpeg (via apt or static binary) ─────────────────────────────────
async function installFfmpeg() {
  if (isAvailable('ffmpeg')) {
    log('ffmpeg already available  ✓');
    return;
  }

  log('ffmpeg not found — trying apt-get...');

  // Try apt-get (works on Render's Ubuntu environment)
  try {
    execSync('apt-get install -y ffmpeg 2>&1', { stdio: 'pipe', timeout: 120_000 });
    if (isAvailable('ffmpeg')) {
      log('ffmpeg installed via apt-get  ✓');
      return;
    }
  } catch {
    warn('apt-get failed — trying static binary...');
  }

  // Fallback: download static ffmpeg binary
  try {
    const tmpTar = path.join(os.tmpdir(), 'ffmpeg-static.tar.xz');
    // Static build for Linux amd64
    const ffmpegUrl = 'https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz';
    log('Downloading static ffmpeg binary (this may take ~30s)...');
    await downloadFile(ffmpegUrl, tmpTar);

    execSync(`tar -xf ${tmpTar} --wildcards '*/ffmpeg' -O > ${BIN_DIR}/ffmpeg`, { stdio: 'pipe' });
    fs.chmodSync(path.join(BIN_DIR, 'ffmpeg'), 0o755);

    if (isAvailable('ffmpeg')) {
      log('ffmpeg installed via static binary  ✓');
    } else {
      warn('ffmpeg install via static binary may have failed — merging might not work');
    }
  } catch (e) {
    warn(`ffmpeg static install failed: ${e.message}`);
    warn('Video merging (best quality) may fail — single-stream fallback will be used');
  }
}

// ── Main export ───────────────────────────────────────────────────────────────
async function ensureDependencies() {
  log('Checking required dependencies...');
  ensureBinDir();

  await Promise.allSettled([
    installYtDlp(),
    installFfmpeg(),
  ]);

  log('Dependency check complete.\n');
}

module.exports = { ensureDependencies };
