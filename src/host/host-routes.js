// Pulse host bridge: the Node-side half of what Electron's main.js used to do over ipcMain.
// Mounted on the media server under /__host/*; called by src/renderer/tauri-bridge.js.
// Native-only concerns (window, tray, dialogs, media keys, storage) live in the Rust host (src-tauri).
//
//   POST /__host/<name>   JSON in / JSON out, requires X-Riff-Token
//   GET  /__host/file?p=<abs path>&t=<token>   local audio/image file with Range support
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const platform = require('../shared/platform');
const { log, tail, LOG_DIR } = require('../shared/logger');
const { getSystemAudioOutputInfo } = require('../shared/audio-output');
const { extractLocalTrackMetadata } = require('../shared/local-metadata');
const { encryptAccount, decryptAccount } = require('../shared/account-crypto');
const { importGoogleLibrary } = require('../shared/google-library');

const USER_DATA = process.env.PULSE_USER_DATA || path.join(process.env.APPDATA || os.homedir(), 'Pulse');
const COVERS_DIR = path.join(USER_DATA, 'local-covers');
const DATA_DIR = platform.DATA_DIR;
const YT_COOKIES_FILE = path.join(DATA_DIR, 'yt-cookies.txt');
const YT_LOGOUT_FLAG = path.join(DATA_DIR, '.yt-logged-out');

const AUDIO_EXT = new Set(['.mp3', '.flac', '.wav', '.ogg', '.oga', '.m4a', '.aac', '.opus', '.wma', '.webm', '.weba']);
// Extensions picked up when scanning a library folder (same set as the Electron folder picker).
const SCAN_EXT = new Set(['.mp3', '.flac', '.wav', '.ogg', '.m4a', '.aac', '.opus', '.wma']);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const VIDEO_EXT = new Set(['.mp4', '.webm']);
const MIME = {
  '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.oga': 'audio/ogg',
  '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.opus': 'audio/ogg', '.wma': 'audio/x-ms-wma', '.webm': 'audio/webm',
  '.weba': 'audio/webm', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.mp4': 'video/mp4'
};

function defaultDownloadsDir() {
  return path.join(os.homedir(), 'Downloads');
}

// ---------- local files ----------

async function tracksFromPaths(paths) {
  const tracks = [];
  for (const fp of paths) {
    if (!fp || typeof fp !== 'string') continue;
    try {
      if (!fs.existsSync(fp)) continue;
      const meta = await extractLocalTrackMetadata(fp, COVERS_DIR);
      if (meta) tracks.push(meta);
    } catch (_) {}
  }
  return tracks;
}

function scanAudioDirs(dirs) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && SCAN_EXT.has(path.extname(entry.name).toLowerCase())) out.push(full);
    }
  };
  for (const d of dirs) if (typeof d === 'string') walk(d);
  return out;
}

async function importAudioFiles(paths) {
  const sources = [];
  for (const p of paths) {
    try {
      const st = fs.statSync(p);
      if (st.isDirectory()) {
        for (const f of fs.readdirSync(p)) {
          const fp = path.join(p, f);
          if (AUDIO_EXT.has(path.extname(f).toLowerCase()) && fs.statSync(fp).isFile()) sources.push(fp);
        }
      } else {
        sources.push(p);
      }
    } catch (_) {}
  }
  fs.mkdirSync(platform.LIBRARY_DIR, { recursive: true });
  const out = [];
  for (const src of sources) {
    const st = fs.statSync(src);
    const ext = path.extname(src).slice(1).toLowerCase();
    const id = 'local_' + crypto.createHash('sha1').update(path.basename(src) + st.size).digest('hex').slice(0, 12);
    const file = `${id}.${ext}`;
    const dest = path.join(platform.LIBRARY_DIR, file);
    if (!fs.existsSync(dest)) await fs.promises.copyFile(src, dest);
    out.push({ id, file, ext, name: path.basename(src, path.extname(src)) });
  }
  return out;
}

function sumDir(dir, filter) {
  let total = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (filter && !filter.test(f)) continue;
      try { total += fs.statSync(path.join(dir, f)).size; } catch (_) {}
    }
  } catch (_) {}
  return total;
}

function clearDir(dir, filter) {
  try {
    for (const f of fs.readdirSync(dir)) {
      if (filter && !filter.test(f)) continue;
      try { fs.unlinkSync(path.join(dir, f)); } catch (_) {}
    }
  } catch (_) {}
}

function serveFile(req, res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (!path.isAbsolute(filePath) || !(AUDIO_EXT.has(ext) || IMAGE_EXT.has(ext) || VIDEO_EXT.has(ext))) {
    res.writeHead(403); return res.end();
  }
  let st;
  try { st = fs.statSync(filePath); } catch (_) { res.writeHead(404); return res.end(); }
  if (!st.isFile()) { res.writeHead(404); return res.end(); }
  const type = MIME[ext] || 'application/octet-stream';
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (range && (range[1] || range[2])) {
    let start = range[1] ? parseInt(range[1], 10) : st.size - parseInt(range[2], 10);
    let end = range[1] && range[2] ? parseInt(range[2], 10) : st.size - 1;
    start = Math.max(0, start); end = Math.min(end, st.size - 1);
    if (start > end) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
    res.writeHead(206, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Cache-Control': 'no-cache' });
    if (req.method === 'HEAD') return res.end();
    return fs.createReadStream(filePath, { start, end }).pipe(res);
  }
  res.writeHead(200, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': st.size, 'Cache-Control': 'no-cache' });
  if (req.method === 'HEAD') return res.end();
  return fs.createReadStream(filePath).pipe(res);
}

// ---------- Google / YouTube cookies ----------
// The cookie file is only ever written by the explicit sign-in window (src-tauri/src/google.rs);
// browser cookie stores are never read.

function hasValidYtCookiesFile() {
  try {
    const txt = fs.readFileSync(YT_COOKIES_FILE, 'utf8');
    return /\.(?:youtube|google)\.com\s+.*\s+(?:SAPISID|__Secure-3PAPISID|__Secure-1PAPISID|LOGIN_INFO|SID)\s+\S+/i.test(txt);
  } catch (_) {
    return false;
  }
}

function readGoogleCookies() {
  // Netscape cookie file: domain, includeSubdomains, path, secure, expiry, name, value
  const jar = new Map();
  try {
    for (const line of fs.readFileSync(YT_COOKIES_FILE, 'utf8').split(/\r?\n/)) {
      const raw = line.startsWith('#HttpOnly_') ? line.slice('#HttpOnly_'.length) : line;
      if (!raw || raw.startsWith('#')) continue;
      const parts = raw.split('\t');
      if (parts.length < 7) continue;
      if (!/(^|\.)(youtube|google)\.com$/i.test(parts[0])) continue;
      jar.set(parts[5], parts[6]);
    }
  } catch (_) {}
  return jar;
}

async function googleImportLibrary(opts) {
  const jar = readGoogleCookies();
  const sapisid = jar.get('SAPISID') || jar.get('__Secure-3PAPISID') || '';
  const cookieHeader = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  return importGoogleLibrary(opts, {
    sapisid,
    fetchImpl: (u, o) => fetch(u, Object.assign({}, o, { headers: Object.assign({}, o && o.headers, { Cookie: cookieHeader }) }))
  });
}

// ---------- data / download folders ----------

async function setDataDir(payload) {
  const target = payload && payload.dir ? path.resolve(String(payload.dir)) : null;
  const move = !!(payload && payload.move);
  if (!target) return { ok: false, error: 'No folder selected' };
  const current = path.resolve(platform.DATA_DIR);
  if (target === current) return { ok: true, dir: target, moved: false };
  const rel = path.relative(current, target);
  const relBack = path.relative(target, current);
  const nested = (r) => r === '' || (!r.startsWith('..') && !path.isAbsolute(r));
  if (nested(rel) || nested(relBack)) return { ok: false, error: 'Choose a folder outside the current music folder' };
  try {
    fs.mkdirSync(target, { recursive: true });
    fs.accessSync(target, fs.constants.W_OK);
  } catch (_) {
    return { ok: false, error: 'That folder is not writable' };
  }
  if (move) {
    try { await platform.copyDirContents(current, target); } catch (e) { return { ok: false, error: 'Could not move files: ' + e.message }; }
  }
  platform.setDataDir(target);
  if (move) { try { await platform.removeDirContents(current); } catch (_) {} }
  return { ok: true, dir: target, moved: move };
}

function setDownloadDir(payload) {
  if (payload && payload.reset) {
    platform.setDownloadDir(null);
    return { ok: true, dir: defaultDownloadsDir(), reset: true };
  }
  const target = payload && payload.dir ? path.resolve(String(payload.dir)) : null;
  if (!target) return { ok: false, error: 'No folder selected' };
  try {
    fs.mkdirSync(target, { recursive: true });
    fs.accessSync(target, fs.constants.W_OK);
  } catch (_) {
    return { ok: false, error: 'That folder is not writable' };
  }
  platform.setDownloadDir(target);
  return { ok: true, dir: target };
}

// ---------- user-chosen file paths (export/import) ----------
// Paths come from the native save/open dialog, but the route itself is reachable by anything holding
// the token, so the extension and location are checked here too.
const EXECUTABLE_EXT = new Set(['.exe', '.com', '.bat', '.cmd', '.ps1', '.psm1', '.psd1', '.vbs', '.vbe', '.js', '.jse',
  '.wsf', '.wsh', '.msi', '.msp', '.scr', '.pif', '.lnk', '.url', '.hta', '.cpl', '.dll', '.sys', '.reg', '.inf', '.jar', '.sh']);
function isInside(child, parent) {
  const rel = path.relative(parent.toLowerCase(), child.toLowerCase());
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function checkUserFile(raw, allowedExt) {
  const str = typeof raw === 'string' ? raw : '';
  if (!str || str.includes('\0')) throw new Error('Invalid path');
  // No UNC/device paths (\\server\share, \\?\, \\.\) and no NTFS alternate data streams (name:stream).
  if (/^[\\/]{2}/.test(str) || str.slice(2).includes(':')) throw new Error('Invalid path');
  if (!path.isAbsolute(str)) throw new Error('Invalid path');
  const full = path.resolve(str);
  const base = path.basename(full).replace(/[. ]+$/, '');
  const ext = path.extname(base).toLowerCase();
  if (!allowedExt.has(ext) || EXECUTABLE_EXT.has(ext)) throw new Error('File type not allowed');
  const startup = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu');
  if (process.env.APPDATA && isInside(full, startup)) throw new Error('Location not allowed');
  const sysRoots = [process.env.SystemRoot, process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.ProgramData]
    .filter(Boolean);
  if (sysRoots.some((r) => isInside(full, r))) throw new Error('Location not allowed');
  return full;
}

// Any user folder is fine (Documents, Desktop, a music drive...) as long as the type is one Pulse
// writes; system folders and the Startup menu are refused above.
const EXPORT_TEXT_EXT = new Set(['.json', '.txt', '.m3u', '.m3u8', '.csv']);
const ACCOUNT_EXT = new Set(['.pulseacc', '.rfacc', '.json']);

// ---------- route table ----------

let logCount = 0;
let logReset = Date.now();

const ROUTES = {
  'local-metadata': (b) => tracksFromPaths(Array.isArray(b.paths) ? b.paths : []),
  'scan-folders': (b) => tracksFromPaths(scanAudioDirs(Array.isArray(b.dirs) ? b.dirs : [])),
  'import-audio-files': (b) => importAudioFiles(Array.isArray(b.paths) ? b.paths : []),
  'cache-size': () => ({
    audio: sumDir(platform.CACHE_DIR, /\.(opus|webm|m4a|mp3)$/i) + sumDir(platform.THUMBNAILS_DIR),
    web: 0
  }),
  'clear-cache': () => {
    clearDir(platform.CACHE_DIR, /\.(opus|webm|m4a|mp3)$/i);
    clearDir(platform.THUMBNAILS_DIR);
    return true;
  },
  'data-dir-get': () => ({ dir: platform.DATA_DIR, defaultDir: platform.DEFAULT_DATA_DIR, isCustom: platform.DATA_DIR !== platform.DEFAULT_DATA_DIR }),
  'data-dir-set': (b) => setDataDir(b),
  'download-dir-get': () => {
    const custom = platform.resolveDownloadDir();
    return { dir: custom || defaultDownloadsDir(), defaultDir: defaultDownloadsDir(), isCustom: !!custom };
  },
  'download-dir-set': (b) => setDownloadDir(b),
  'account-export': async (b) => {
    const fp = checkUserFile(b.path, ACCOUNT_EXT);
    await fs.promises.writeFile(fp, encryptAccount(b.payload || {}));
    return { success: true, filePath: fp };
  },
  'account-import': async (b) => {
    const fp = checkUserFile(b.path, ACCOUNT_EXT);
    const st = await fs.promises.stat(fp);
    if (!st.isFile() || st.size > 64 * 1024 * 1024) throw new Error('Invalid account file');
    return { success: true, data: decryptAccount(await fs.promises.readFile(fp)), filePath: fp };
  },
  'write-text': async (b) => {
    const fp = checkUserFile(b.path, EXPORT_TEXT_EXT);
    await fs.promises.writeFile(fp, String(b.content || ''), 'utf8');
    return { success: true, filePath: fp };
  },
  'diagnostics': (b) => {
    const lines = [`Pulse ${b.version || ''}`, `OS ${process.platform} ${process.arch} ${os.release()}`,
      `Host Tauri/WebView2 ${b.webview || ''} - Node ${process.versions.node}`, `Data ${DATA_DIR}`];
    for (const name of ['yt-dlp', 'ffmpeg']) lines.push(`${name}: ${platform.resolveBinary(name) || 'NOT FOUND'}`);
    lines.push('--- last log lines ---', ...tail(60));
    return lines.join('\n');
  },
  'audio-output-info': () => getSystemAudioOutputInfo(),
  'multi-instance-get': () => !!platform.readStartupConfig().multiInstance,
  'multi-instance-set': (b) => { platform.writeStartupConfig({ multiInstance: !!b.value }); return true; },
  'logs-dir': () => LOG_DIR,
  'log': (b) => {
    const now = Date.now();
    if (now - logReset > 60000) { logReset = now; logCount = 0; }
    if (logCount++ < 20) log(b.level || 'ERROR', b.message || '', b.stack || null);
    return true;
  },
  'google-auth-status': () => ({ loggedIn: !fs.existsSync(YT_LOGOUT_FLAG) && hasValidYtCookiesFile() }),
  'google-logout': () => {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(YT_LOGOUT_FLAG, '1', 'utf8');
    fs.rmSync(YT_COOKIES_FILE, { force: true });
    return { success: true };
  },
  'google-import-library': (b) => googleImportLibrary(b)
};

function readJson(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size <= 64 * 1024 * 1024) chunks.push(c); });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (_) { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

function createHostHandler() {
  return async function hostHandler(req, res, parsedUrl, tokenMatches) {
    const pathname = parsedUrl.pathname || '';
    if (!pathname.startsWith('/__host/')) return false;
    const name = pathname.slice('/__host/'.length);

    if (name === 'file' && (req.method === 'GET' || req.method === 'HEAD')) {
      if (!tokenMatches(String(parsedUrl.query.t || ''))) { res.writeHead(403); res.end(); return true; }
      serveFile(req, res, String(parsedUrl.query.p || ''));
      return true;
    }

    const route = ROUTES[name];
    if (!route || req.method !== 'POST') { res.writeHead(404); res.end(); return true; }
    if (!tokenMatches(req.headers['x-riff-token'])) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'forbidden' }));
      return true;
    }
    try {
      const result = await route(await readJson(req));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result === undefined ? null : result));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e && e.message ? e.message : String(e) }));
    }
    return true;
  };
}

module.exports = { createHostHandler };
