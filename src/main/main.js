const { app, BrowserWindow, dialog, ipcMain, screen, shell, Tray, Menu, nativeImage, globalShortcut, powerMonitor, session } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const url = require('url');
const { pathToFileURL } = url;
const { spawn, execFile } = require('child_process');
const crypto = require('crypto');
const zlib = require('zlib');
const { encryptAccount, decryptAccount } = require('../shared/account-crypto');
const { LIBRARY_DIR, DATA_DIR, resolveBinary, tutorialDone, markTutorialDone, readStartupConfig, writeStartupConfig } = require('../shared/platform');
const { getLauncherInfo, installLauncher } = require('./launcher');
const { getSystemAudioOutputInfo } = require('../shared/audio-output');
const { log, tail, LOG_DIR } = require('../shared/logger');
const logger = { log, tail, LOG_DIR, error: (msg, err) => log('ERROR', `${msg}: ${err && err.message ? err.message : err}`) };

process.on('uncaughtException', (err) => {
  try { logger.error('Uncaught exception in main', err); } catch (_) {}
});
process.on('unhandledRejection', (reason) => {
  try {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    logger.error('Unhandled rejection in main', err);
  } catch (_) {}
});

const enabledFeatures = [];
if (process.platform === 'linux') {
  enabledFeatures.push('WaylandWindowDecorations', 'UseOzonePlatform', 'WaylandFractionalScaleV1', 'MediaSessionService', 'HardwareMediaKeyHandling');
  app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
  app.commandLine.appendSwitch('disable-features', 'Vulkan,AudioServiceOutOfProcess');

  if (process.env.RIFF_SKIP_GPU_BUFFER_FLAGS !== '1') {
    app.commandLine.appendSwitch('disable-gpu-memory-buffer-video-frames');
    app.commandLine.appendSwitch('disable-gpu-memory-buffer-compositor-resources');
  }
}

if (process.platform === 'win32') {
  enabledFeatures.push('HardwareMediaKeyHandling', 'MediaSessionService');
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
}

if (enabledFeatures.length > 0) {
  app.commandLine.appendSwitch('enable-features', enabledFeatures.join(','));
}

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('renderer-process-limit', '1');
app.commandLine.appendSwitch('disable-component-update');
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-domain-reliability');
app.commandLine.appendSwitch('disable-sync');
app.commandLine.appendSwitch('disable-speech-api');
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=384');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');
app.commandLine.appendSwitch('disk-cache-size', '52428800');
app.commandLine.appendSwitch('media-cache-size', '52428800');

setInterval(() => {
  try {
    session.defaultSession.clearCache().catch(() => {});
    if (global.gc) global.gc();
  } catch (_) {}
}, 180000);
app.on('ready', () => {
  const cleanUA = (app.userAgentFallback || '').replace(/\s*Electron\/[^\s]+/gi, '').replace(/\s*riff\/[^\s]+/gi, '');
  if (cleanUA) app.userAgentFallback = cleanUA;
});

const extraFlags = (process.env.RIFF_FLAGS || '').split(';').map((s) => s.trim()).filter(Boolean);
for (const flag of extraFlags) {
  const eq = flag.indexOf('=');
  if (eq > 0) app.commandLine.appendSwitch(flag.slice(0, eq), flag.slice(eq + 1));
  else app.commandLine.appendSwitch(flag);
}

if (process.env.RIFF_DEBUG === '1') {
  app.whenReady().then(async () => {
    console.log('[gpu] features', JSON.stringify(app.getGPUFeatureStatus()));
    try {
      console.log('[gpu] info', JSON.stringify(await app.getGPUInfo('basic')));
    } catch (e) {}
    setInterval(() => {
      const rows = app.getAppMetrics().map((m) => `${m.type}:${Math.round(m.cpu.percentCPUUsage)}%`);
      console.log('[cpu]', rows.join('  '));
    }, 5000).unref();
  });
}

if (process.argv.includes('lyrics') || process.argv.includes('--lyrics')) {
  const cliPath = path.join(__dirname, 'cli.js');
  const child = spawn(process.execPath, [cliPath, 'lyrics'], { stdio: 'inherit', env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' }) });
  child.on('exit', (code) => process.exit(code || 0));
} else {
  runGUI();
}

function runGUI() {
  const { startServer, PORT, getServerToken } = require('../server/server');
  // Pulse: Discord RPC removed — no-op stub keeps the IPC contract intact.
  const discordRPC = { initRPC() {}, updatePresence() {}, clearPresence() {}, setEnabled() {}, getEnabled: () => false, getConnected: () => false, reconnectRPC() {}, destroyRPC() {} };

  let mainWindow = null;
  const allowMulti = !!readStartupConfig().multiInstance;
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock && !allowMulti) { app.quit(); return; }
  if (!gotLock && allowMulti) app.setPath('userData', `${app.getPath('userData')}-instance-${process.pid}`);
  app.on('second-instance', () => {
    if (allowMulti) return;
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
  let serverPort = PORT;
  let tray = null;
  let isQuitting = false;
  let trayOnClose = process.platform !== 'linux';
  let isMiniWindow = false;
  let preMiniBounds = null;

  const windowStatePath = path.join(app.getPath('userData'), 'window-state.json');
  const CACHE_FILE = path.join(app.getPath('userData'), 'cache.json');

  const PRIMARY_STORAGE_FILE = path.join(__dirname, '../storage.json');
  const FALLBACK_STORAGE_FILE = path.join(app.getPath('userData'), 'storage.json');

  function getActiveStorageFile() {
    if (process.platform === 'darwin' || app.isPackaged) {
      return FALLBACK_STORAGE_FILE;
    }
    try {
      fs.accessSync(path.dirname(PRIMARY_STORAGE_FILE), fs.constants.W_OK);
      return PRIMARY_STORAGE_FILE;
    } catch (_) {
      return FALLBACK_STORAGE_FILE;
    }
  }

  function readStorageDiskSync() {
    const file = getActiveStorageFile();
    try {
      if (fs.existsSync(file)) {
        const raw = fs.readFileSync(file, 'utf8').trim();
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === 'object' && Object.keys(parsed).length > 0) return parsed;
        }
      }
    } catch (e) {
      console.warn('[riff] storage.json read warning:', e.message);
    }
    return null;
  }

  function writeStorageDiskSync(data) {
    if (!data || typeof data !== 'object') return;
    const file = getActiveStorageFile();
    const tmpFile = file + '.tmp';
    try {
      fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2), 'utf8');
      fs.renameSync(tmpFile, file);
    } catch (_) {
      try {
        fs.writeFileSync(FALLBACK_STORAGE_FILE, JSON.stringify(data, null, 2), 'utf8');
      } catch (_) {}
    }
  }

  let storageFlushTimer = null;
  let latestStorageSnapshot = null;
  let storageDirty = false;

  ipcMain.on('storage-get-all-sync', (event) => {
    event.returnValue = latestStorageSnapshot || readStorageDiskSync();
  });

  ipcMain.on('storage-save-batch', (event, data) => {
    if (!data || typeof data !== 'object') return;
    latestStorageSnapshot = data;
    storageDirty = true;
    if (storageFlushTimer) clearTimeout(storageFlushTimer);
    storageFlushTimer = setTimeout(() => {
      storageFlushTimer = null;
      storageDirty = false;
      writeStorageDiskSync(latestStorageSnapshot);
    }, 250);
  });

  ipcMain.on('storage-save-sync', (event, data) => {
    if (data && typeof data === 'object') {
      if (storageFlushTimer) { clearTimeout(storageFlushTimer); storageFlushTimer = null; }
      latestStorageSnapshot = data;
      storageDirty = false;
      writeStorageDiskSync(latestStorageSnapshot);
    }
    event.returnValue = true;
  });

  app.on('before-quit', () => {
    if (storageFlushTimer) {
      clearTimeout(storageFlushTimer);
      storageFlushTimer = null;
    }
    if (storageDirty && latestStorageSnapshot) {
      storageDirty = false;
      writeStorageDiskSync(latestStorageSnapshot);
    }
  });

  ipcMain.handle('cache-read', async () => {
    try {
      if (fs.existsSync(CACHE_FILE)) {
        return JSON.parse(await fs.promises.readFile(CACHE_FILE, 'utf8'));
      }
    } catch (_) {}
    return null;
  });

  ipcMain.on('cache-write', (event, data) => {
    if (!data || typeof data !== 'object') return;
    const tmp = CACHE_FILE + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
      fs.renameSync(tmp, CACHE_FILE);
    } catch (_) {
      try { fs.unlinkSync(tmp); } catch (_) {}
    }
  });

  app.on('before-quit', () => {
    if (storageFlushTimer) {
      clearTimeout(storageFlushTimer);
      storageFlushTimer = null;
      if (latestStorageSnapshot) writeStorageDiskSync(latestStorageSnapshot);
    }
  });

  function readWindowState() {
    try {
      const raw = fs.readFileSync(windowStatePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return null;
      return parsed;
    } catch (error) {
      return null;
    }
  }

  function clampBoundsToDisplay(bounds) {
    const primaryDisplay = screen.getPrimaryDisplay();
    const primaryWorkArea = primaryDisplay.workArea;
    const scaleFactor = primaryDisplay.scaleFactor;

    const sourceBounds = bounds && Number.isFinite(bounds.width) && Number.isFinite(bounds.height)
    ? { ...bounds }
    : {};

    const minW = 800;
    const minH = 540;

    const width = Math.max(minW, Math.min(sourceBounds.width || 0, primaryWorkArea.width));
    const height = Math.max(minH, Math.min(sourceBounds.height || 0, primaryWorkArea.height));

    const display = screen.getDisplayMatching({
      x: sourceBounds.x ?? primaryWorkArea.x,
      y: sourceBounds.y ?? primaryWorkArea.y,
      width,
      height
    }) || primaryDisplay;

    const workArea = display.workArea;
    const x = Math.min(
      Math.max(sourceBounds.x ?? workArea.x + Math.round((workArea.width - width) / 2), workArea.x),
                       workArea.x + Math.max(0, workArea.width - width)
    );
    const y = Math.min(
      Math.max(sourceBounds.y ?? workArea.y + Math.round((workArea.height - height) / 2), workArea.y),
                       workArea.y + Math.max(0, workArea.height - height)
    );

    return { x, y, width, height };
  }

  function getResponsiveWindowBounds() {
    const { workArea } = screen.getPrimaryDisplay();
    const persisted = readWindowState();
    const responsiveBounds = {
      width: Math.round(workArea.width * 0.82),
      height: Math.round(workArea.height * 0.86),
      x: workArea.x + Math.round(workArea.width * 0.09),
      y: workArea.y + Math.round(workArea.height * 0.07)
    };
    const merged = {
      ...responsiveBounds,
      ...(persisted && persisted.bounds ? persisted.bounds : {})
    };
    return clampBoundsToDisplay(merged);
  }

  function persistWindowState() {
    if (isMiniWindow) return;
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const isMaximized = mainWindow.isMaximized();
    const isFullScreen = mainWindow.isFullScreen();
    const bounds = isMaximized || isFullScreen ? mainWindow.getNormalBounds() : mainWindow.getBounds();
    try {
      fs.mkdirSync(path.dirname(windowStatePath), { recursive: true });
      fs.writeFileSync(windowStatePath, JSON.stringify({
        bounds,
        isMaximized,
        isFullScreen
      }, null, 2));
    } catch (error) {
      console.warn('Failed to persist window state:', error);
    }
  }

  async function createWindow() {
    serverPort = await startServer(PORT);
    // Pulse: welcome tutorial disabled — always open straight into the player.
    const firstRun = false;
    if (!tutorialDone()) { try { markTutorialDone(); } catch (_) {} }
    const initialBounds = getResponsiveWindowBounds();
    const savedState = readWindowState();

    const primaryDisplay = screen.getPrimaryDisplay();
    const scaleFactor = primaryDisplay.scaleFactor;

    app.setAppUserModelId('io.github.rootscripts.riff');
    mainWindow = new BrowserWindow({
      x: initialBounds.x,
      y: initialBounds.y,
      width: initialBounds.width,
      height: initialBounds.height,
      minWidth: 800,
      minHeight: 540,
                                   backgroundColor: firstRun ? '#8d5ef2' : '#000000',
                                   title: 'Pulse',
                                   icon: path.join(__dirname, '../../assets', 'icon.png'),
                                   frame: false,
                                   titleBarStyle: 'hidden',
                                   show: false,
                                   useContentSize: true,
                                   webPreferences: {
                                     preload: path.join(__dirname, 'preload.js'),
                                   additionalArguments: [`--riff-token=${getServerToken()}`],
                                   nodeIntegration: false,
                                   contextIsolation: true,
                                   webSecurity: false,
                                   backgroundThrottling: true,
                                   spellcheck: false
                                   }
    });

    if (savedState?.isMaximized) {
      mainWindow.maximize();
    }

    mainWindow.once('ready-to-show', () => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      mainWindow.show();
    });

    mainWindow.loadFile(path.join(__dirname, '../renderer', firstRun ? 'welcome.html' : 'index.html'));
    if (firstRun) {
      ipcMain.removeAllListeners('welcome-finish');
      ipcMain.once('welcome-finish', (e, detail) => {
        markTutorialDone();
        if (detail && detail.launcher) installLauncher();
        if (!mainWindow || mainWindow.isDestroyed()) return;
        const result = detail && !detail.skipped ? detail : null;
        mainWindow.setBackgroundColor('#000000');
        mainWindow.webContents.once('did-finish-load', () => { if (result) mainWindow.webContents.send('welcome-result', result); });
        mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

      });
    }

    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      shell.openExternal(url);
      return { action: 'deny' };
    });

    mainWindow.webContents.on('did-finish-load', () => {
      try {
        const curUrl = mainWindow.webContents.getURL() || '';
        if (curUrl.includes('index.html')) {
          if (mainWindow.webContents.navigationHistory?.clear) {
            mainWindow.webContents.navigationHistory.clear();
          } else if (mainWindow.webContents.clearHistory) {
            mainWindow.webContents.clearHistory();
          }
        }
      } catch (_) {}
    });

    mainWindow.on('minimize', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('window-visibility', false);
        if (global.gc) global.gc();
      }
    });

    mainWindow.on('blur', () => {
      if (global.gc) global.gc();
    });

    mainWindow.on('restore', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('window-visibility', true);
      }
    });

    mainWindow.on('hide', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('window-visibility', false);
      }
    });

    mainWindow.on('show', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('window-visibility', true);
      }
    });
    mainWindow.on('resize', persistWindowState);
    mainWindow.on('move', persistWindowState);
    mainWindow.on('maximize', persistWindowState);
    mainWindow.on('unmaximize', persistWindowState);
    mainWindow.on('enter-full-screen', persistWindowState);
    mainWindow.on('leave-full-screen', persistWindowState);
    mainWindow.on('close', (e) => {
      persistWindowState();
      if (trayOnClose && tray && !isQuitting) {
        e.preventDefault();
        mainWindow.hide();
      }
    });

    discordRPC.initRPC();
  }

  ipcMain.removeHandler('get-server-port');
  ipcMain.removeHandler('discord-rpc-get-enabled');
  ipcMain.removeHandler('discord-rpc-get-connected');
  ipcMain.removeHandler('discord-rpc-reconnect');
  ipcMain.removeHandler('account-export');
  ipcMain.removeHandler('account-import');
  ipcMain.removeHandler('pick-media');
  ipcMain.removeHandler('import-audio-files');
  ipcMain.removeHandler('pick-local-files');
  ipcMain.removeHandler('pick-local-folder');
  ipcMain.removeHandler('rescan-local-metadata');

  ipcMain.on('window-minimize', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize();
  });

    ipcMain.on('window-maximize', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        if (mainWindow.isMaximized()) mainWindow.unmaximize();
        else mainWindow.maximize();
      }
    });

    ipcMain.on('window-close', () => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
    });

    ipcMain.on('open-external', (e, u) => {
      if (/^https:\/\/(?:accounts\.spotify\.com|(?:www\.)?last\.fm|github\.com)\//i.test(String(u))) {
        shell.openExternal(String(u));
      }
    });

    let mainLogCount = 0;
    let mainLogReset = Date.now();
    ipcMain.on('log-error', (e, data) => {
      const now = Date.now();
      if (now - mainLogReset > 60000) {
        mainLogReset = now;
        mainLogCount = 0;
      }
      if (mainLogCount < 20) {
        mainLogCount++;
        if (data && typeof data === 'object') {
          logger.log(data.level || 'ERROR', data.message || '', data.stack || null);
        }
      }
    });

    ipcMain.handle('get-diagnostics', async () => {
      const lines = [`Riff ${app.getVersion()}`, `OS ${process.platform} ${process.arch} ${os.release()}`, `Electron ${process.versions.electron} Chromium ${process.versions.chrome} Node ${process.versions.node}`, `Locale ${app.getLocale()}`, `Data ${DATA_DIR}`];
      for (const name of ['yt-dlp', 'ffmpeg']) {
        const bin = resolveBinary(name);
        lines.push(`${name}: ${bin || 'NOT FOUND'}`);
      }
      lines.push('--- last log lines ---', ...tail(60));
      return lines.join('\n');
    });
    ipcMain.on('open-logs-folder', () => { shell.openPath(LOG_DIR); });

      ipcMain.handle('get-server-port', () => serverPort);
      ipcMain.handle('set-app-proxy', async (event, proxyUrl) => {
        try {
          const clean = String(proxyUrl || '').trim();
          const config = clean
            ? { proxyRules: clean, proxyBypassRules: '<local>,127.0.0.1,localhost' }
            : { mode: 'direct' };
          await session.defaultSession.setProxy(config);
          const googleSess = session.fromPartition('persist:riff-google');
          if (googleSess) await googleSess.setProxy(config);
          return { success: true };
        } catch (e) {
          return { success: false, error: e.message };
        }
      });
      ipcMain.handle('get-gpu-compositing', () => { try { return String(app.getGPUFeatureStatus().gpu_compositing || ''); } catch (e) { return ''; } });
      ipcMain.handle('launcher-info', () => getLauncherInfo());
      ipcMain.handle('install-launcher', () => {
        try {
          return installLauncher();
        } catch (err) {
          return { ok: false, error: err.message || String(err) };
        }
      });
      ipcMain.handle('get-audio-output-info', async () => getSystemAudioOutputInfo());
      require('./themes').register(() => mainWindow);
      // Pulse: plugins removed.
      try { ipcMain.removeHandler('plugins-list'); ipcMain.removeHandler('plugins-import'); } catch (_) {}
      ipcMain.handle('plugins-list', () => []);
      ipcMain.handle('plugins-import', () => ({ ok: false }));

      ipcMain.on('discord-rpc-update', (event, trackInfo) => {
        discordRPC.updatePresence(trackInfo);
      });

      ipcMain.on('discord-rpc-clear', () => {
        discordRPC.clearPresence();
      });

      ipcMain.on('discord-rpc-set-enabled', (event, enabled) => {
        discordRPC.setEnabled(enabled);
      });

      ipcMain.handle('discord-rpc-get-enabled', () => discordRPC.getEnabled());
      ipcMain.handle('discord-rpc-get-connected', () => discordRPC.getConnected());
      ipcMain.handle('discord-rpc-reconnect', () => {
        if (discordRPC && discordRPC.reconnectRPC) discordRPC.reconnectRPC();
        return true;
      });
      ipcMain.on('discord-rpc-reconnect', () => {
        if (discordRPC && discordRPC.reconnectRPC) discordRPC.reconnectRPC();
      });

      ipcMain.handle('get-cache-size', async () => {
        const fs = require('fs');
        const path = require('path');
        const os = require('os');
        const { session } = require('electron');

        let webSize = 0;
        try { webSize = await session.defaultSession.getCacheSize(); } catch(e) {}

        let audioSize = 0;
        const tracksDir = require('../shared/platform').CACHE_DIR;
        const thumbnailsDir = require('../shared/platform').THUMBNAILS_DIR;
        const audioExtRegex = /\.(opus|webm|m4a|mp3)$/i;
        try {
          if (fs.existsSync(tracksDir)) {
            for (const file of fs.readdirSync(tracksDir)) {
              if (audioExtRegex.test(file)) {
                try { audioSize += fs.statSync(path.join(tracksDir, file)).size; } catch(e) {}
              }
            }
          }
        } catch(e) {}
        try {
          if (fs.existsSync(thumbnailsDir)) {
            for (const file of fs.readdirSync(thumbnailsDir)) {
              try { audioSize += fs.statSync(path.join(thumbnailsDir, file)).size; } catch(e) {}
            }
          }
        } catch(e) {}

        return { audio: audioSize, web: webSize };
      });

      ipcMain.handle('clear-cache', async () => {
        const fs = require('fs');
        const path = require('path');
        const os = require('os');
        const { session } = require('electron');
        
        try { await session.defaultSession.clearCache(); } catch(e) {}
        try { await session.defaultSession.clearStorageData({ storages: ['serviceworkers', 'cachestorage'] }); } catch(e) {}

        const tracksDir = require('../shared/platform').CACHE_DIR;
        const thumbnailsDir = require('../shared/platform').THUMBNAILS_DIR;
        const audioExtRegex = /\.(opus|webm|m4a|mp3)$/i;
        try {
          if (fs.existsSync(tracksDir)) {
            for (const file of fs.readdirSync(tracksDir)) {
              if (audioExtRegex.test(file)) {
                try { fs.unlinkSync(path.join(tracksDir, file)); } catch(e) {}
              }
            }
          }
        } catch(e) {}
        try {
          if (fs.existsSync(thumbnailsDir)) {
            for (const file of fs.readdirSync(thumbnailsDir)) {
              try { fs.unlinkSync(path.join(thumbnailsDir, file)); } catch(e) {}
            }
          }
        } catch(e) {}

        return true;
      });

      ipcMain.handle('pick-media', async () => {
        const r = await dialog.showOpenDialog(mainWindow, { properties: ['openFile'], filters: [{ name: 'Media', extensions: ['png','jpg','jpeg','webp','gif','mp4','webm'] }] });
        return r.canceled ? null : pathToFileURL(r.filePaths[0]).href;
      });

      ipcMain.handle('import-audio-files', async () => {
        const r = await dialog.showOpenDialog(mainWindow, { properties: ['openFile', 'multiSelections', 'openDirectory'], filters: [{ name: 'Audio', extensions: ['mp3','wav','flac','opus','ogg','oga','m4a','aac','webm','weba'] }] });
        if (r.canceled) return [];
        const AUDIO_EXT = new Set(['mp3','wav','flac','opus','ogg','oga','m4a','aac','webm','weba']);
        const sources = [];
        for (const p of r.filePaths) {
          const st = fs.statSync(p);
          if (st.isDirectory()) {
            for (const f of fs.readdirSync(p)) {
              const fp = path.join(p, f);
              if (AUDIO_EXT.has(path.extname(f).slice(1).toLowerCase()) && fs.statSync(fp).isFile()) sources.push(fp);
            }
          } else {
            sources.push(p);
          }
        }
        fs.mkdirSync(LIBRARY_DIR, { recursive: true });
        const out = [];
        for (const src of sources) {
          const st = fs.statSync(src), ext = path.extname(src).slice(1).toLowerCase();
          const id = 'local_' + crypto.createHash('sha1').update(path.basename(src) + st.size).digest('hex').slice(0, 12);
          const file = `${id}.${ext}`;
          if (!fs.existsSync(path.join(LIBRARY_DIR, file))) await fs.promises.copyFile(src, path.join(LIBRARY_DIR, file));
          out.push({ id, file, ext, name: path.basename(src, path.extname(src)) });
        }
        return out;
      });

      const { extractLocalTrackMetadata: extractLocalTrackMetadataShared } = require('../shared/local-metadata');
      const extractLocalTrackMetadata = (filePath) => extractLocalTrackMetadataShared(filePath, path.join(app.getPath('userData'), 'local-covers'));

      ipcMain.handle('pick-local-files', async () => {
        const r = await dialog.showOpenDialog(mainWindow, {
          properties: ['openFile', 'multiSelections'],
          filters: [{ name: 'Audio', extensions: ['mp3', 'flac', 'wav', 'ogg', 'm4a', 'aac', 'opus', 'wma'] }]
        });
        if (r.canceled || !r.filePaths) return [];
        const tracks = [];
        for (const fp of r.filePaths) {
          try {
            const meta = await extractLocalTrackMetadata(fp);
            if (meta) tracks.push(meta);
          } catch (e) {}
        }
        return tracks;
      });

      ipcMain.handle('pick-local-folder', async () => {
        const r = await dialog.showOpenDialog(mainWindow, {
          properties: ['openDirectory', 'multiSelections']
        });
        if (r.canceled || !r.filePaths) return [];
        const AUDIO_EXT = new Set(['.mp3', '.flac', '.wav', '.ogg', '.m4a', '.aac', '.opus', '.wma']);
        const sources = [];

        function scanDir(dir) {
          try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
              const fullPath = path.join(dir, entry.name);
              if (entry.isDirectory()) {
                scanDir(fullPath);
              } else if (entry.isFile()) {
                const ext = path.extname(entry.name).toLowerCase();
                if (AUDIO_EXT.has(ext)) {
                  sources.push(fullPath);
                }
              }
            }
          } catch (e) {}
        }

        for (const dir of r.filePaths) {
          scanDir(dir);
        }

        const tracks = [];
        for (const fp of sources) {
          try {
            const meta = await extractLocalTrackMetadata(fp);
            if (meta) tracks.push(meta);
          } catch (e) {}
        }
        return tracks;
      });

      ipcMain.handle('rescan-local-metadata', async (event, paths) => {
        if (!Array.isArray(paths)) return [];
        const tracks = [];
        for (const fp of paths) {
          if (!fp || typeof fp !== 'string') continue;
          try {
            if (fs.existsSync(fp)) {
              const meta = await extractLocalTrackMetadata(fp);
              if (meta) tracks.push(meta);
            }
          } catch (e) {}
        }
        return tracks;
      });

      ipcMain.handle('get-data-dir', () => {
        const platform = require('../shared/platform');
        return {
          dir: platform.DATA_DIR,
          defaultDir: platform.DEFAULT_DATA_DIR,
          isCustom: platform.DATA_DIR !== platform.DEFAULT_DATA_DIR
        };
      });

      ipcMain.handle('pick-data-dir', async () => {
        const platform = require('../shared/platform');
        const r = await dialog.showOpenDialog(mainWindow, {
          title: 'Choose music folder',
          defaultPath: platform.DATA_DIR,
          properties: ['openDirectory', 'createDirectory']
        });
        return r.canceled ? null : r.filePaths[0];
      });

      ipcMain.handle('set-data-dir', async (event, payload) => {
        const platform = require('../shared/platform');
        const target = payload && payload.dir ? path.resolve(String(payload.dir)) : null;
        const move = !!(payload && payload.move);
        if (!target) return { ok: false, error: 'No folder selected' };

        const current = path.resolve(platform.DATA_DIR);
        if (target === current) return { ok: true, dir: target, moved: false };

        const rel = path.relative(current, target);
        const insideCurrent = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
        const relBack = path.relative(target, current);
        const currentInsideTarget = relBack === '' || (!relBack.startsWith('..') && !path.isAbsolute(relBack));
        if (insideCurrent || currentInsideTarget) {
          return { ok: false, error: 'Choose a folder outside the current music folder' };
        }

        try {
          fs.mkdirSync(target, { recursive: true });
          fs.accessSync(target, fs.constants.W_OK);
        } catch (e) {
          return { ok: false, error: 'That folder is not writable' };
        }

        if (move) {
          try {
            await platform.copyDirContents(current, target);
          } catch (e) {
            return { ok: false, error: 'Could not move files: ' + e.message };
          }
        }

        platform.setDataDir(target);

        if (move) {
          try { await platform.removeDirContents(current); } catch (e) {}
        }

        return { ok: true, dir: target, moved: move };
      });

      const defaultDownloadsDir = () => {
        try { return app.getPath('downloads'); } catch (e) { return null; }
      };

      ipcMain.handle('get-download-dir', () => {
        const platform = require('../shared/platform');
        const def = defaultDownloadsDir();
        const custom = platform.resolveDownloadDir();
        return {
          dir: custom || def,
          defaultDir: def,
          isCustom: !!custom
        };
      });

      ipcMain.handle('pick-download-dir', async () => {
        const platform = require('../shared/platform');
        const r = await dialog.showOpenDialog(mainWindow, {
          title: 'Choose download folder',
          defaultPath: platform.resolveDownloadDir() || defaultDownloadsDir() || undefined,
          properties: ['openDirectory', 'createDirectory']
        });
        return r.canceled ? null : r.filePaths[0];
      });

      ipcMain.handle('set-download-dir', async (event, payload) => {
        const platform = require('../shared/platform');
        const reset = !!(payload && payload.reset);
        if (reset) {
          platform.setDownloadDir(null);
          return { ok: true, dir: defaultDownloadsDir(), reset: true };
        }
        const target = payload && payload.dir ? path.resolve(String(payload.dir)) : null;
        if (!target) return { ok: false, error: 'No folder selected' };
        try {
          fs.mkdirSync(target, { recursive: true });
          fs.accessSync(target, fs.constants.W_OK);
        } catch (e) {
          return { ok: false, error: 'That folder is not writable' };
        }
        platform.setDownloadDir(target);
        return { ok: true, dir: target };
      });

      ipcMain.on('restart-app', () => {
        app.relaunch();
        app.exit(0);
      });

      ipcMain.on('set-tray-on-close', (e, v) => {
        trayOnClose = !!v;
      });

      ipcMain.handle('get-multi-instance', () => !!readStartupConfig().multiInstance);
      ipcMain.on('set-multi-instance', (e, value) => { writeStartupConfig({ multiInstance: !!value }); });

      const MEDIA_KEYS = { MediaPlayPause: 'toggle', MediaNextTrack: 'next', MediaPreviousTrack: 'prev', MediaStop: 'stop' };
      let mediaKeysWanted = true;
      let mediaKeysActive = false;
      const sendMedia = (cmd) => {
        if (process.env.RIFF_DEBUG === '1') console.log('[media] globalShortcut', cmd);
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('media-command', cmd);
      };
      function unregisterMediaKeys() {
        for (const k of Object.keys(MEDIA_KEYS)) {
          try { globalShortcut.unregister(k); } catch (e) {}
        }
      }
      function registerMediaKeys() {
        if (process.platform !== 'win32') return;
        unregisterMediaKeys();
        if (!mediaKeysWanted || !mediaKeysActive) return;
        for (const [k, cmd] of Object.entries(MEDIA_KEYS)) {
          try {
            if (!globalShortcut.register(k, () => sendMedia(cmd))) {
              console.warn('[media] could not register', k);
            }
          } catch (e) {}
        }
      }
      ipcMain.on('set-media-keys', (e, enabled) => { mediaKeysWanted = !!enabled; registerMediaKeys(); });
      ipcMain.on('media-keys-active', () => { if (!mediaKeysActive) { mediaKeysActive = true; registerMediaKeys(); } });
      powerMonitor.on('resume', registerMediaKeys);
      powerMonitor.on('unlock-screen', registerMediaKeys);
      app.on('will-quit', () => {
        try {
          globalShortcut.unregister('MediaPlayPause');
          globalShortcut.unregister('MediaNextTrack');
          globalShortcut.unregister('MediaPreviousTrack');
        } catch (e) {}
        globalShortcut.unregisterAll();
      });

      let preMiniLyricsH = null;
      ipcMain.removeHandler('toggle-mini-window');
      ipcMain.handle('toggle-mini-window', () => {
        if (!mainWindow || mainWindow.isDestroyed()) return false;
        if (!isMiniWindow) {
          isMiniWindow = true;
          preMiniBounds = mainWindow.isMaximized() ? mainWindow.getNormalBounds() : mainWindow.getBounds();
          if (mainWindow.isMaximized()) mainWindow.unmaximize();
          mainWindow.setMinimumSize(280, 115);
          mainWindow.setSize(380, 160);
          mainWindow.setAlwaysOnTop(true);
          return true;
        } else {
          isMiniWindow = false;
          preMiniLyricsH = null;
          mainWindow.setAlwaysOnTop(false);
          mainWindow.setMinimumSize(800, 540);
          if (preMiniBounds) {
            mainWindow.setBounds(clampBoundsToDisplay(preMiniBounds));
          } else {
            mainWindow.setSize(1000, 700);
          }
          return false;
        }
      });

      ipcMain.removeHandler('set-mini-lyrics');
      ipcMain.handle('set-mini-lyrics', (e, enabled) => {
        if (!mainWindow || mainWindow.isDestroyed() || !isMiniWindow) return false;
        const bounds = mainWindow.getBounds();
        const display = screen.getDisplayMatching(bounds);
        const maxH = Math.floor(display.workArea.height * 0.9);
        if (enabled) {
          if (!preMiniLyricsH) preMiniLyricsH = bounds.height;
          mainWindow.setMinimumSize(320, 240);
          const targetH = Math.min(Math.max(bounds.height, 360), maxH);
          if (bounds.y + targetH > display.workArea.y + display.workArea.height) {
            const newY = Math.max(display.workArea.y, display.workArea.y + display.workArea.height - targetH);
            mainWindow.setBounds({ x: bounds.x, y: newY, width: bounds.width, height: targetH });
          } else {
            mainWindow.setSize(bounds.width, targetH);
          }
        } else {
          mainWindow.setMinimumSize(320, 140);
          const targetH = preMiniLyricsH || 160;
          mainWindow.setSize(bounds.width, targetH);
          preMiniLyricsH = null;
        }
        return true;
      });

      ipcMain.handle('get-app-version', () => app.getVersion());

      ipcMain.handle('save-playlists-json', async (event, payload) => {
        const win = BrowserWindow.fromWebContents(event.sender) || mainWindow;
        const defaultName = payload && payload.defaultName ? payload.defaultName : 'playlists.json';
        const content = payload && payload.content ? payload.content : '';
        const r = await dialog.showSaveDialog(win, {
          title: 'Export playlists as JSON',
          defaultPath: defaultName,
          filters: [{ name: 'JSON', extensions: ['json'] }]
        });
        if (r.canceled || !r.filePath) return { canceled: true };
        await fs.promises.writeFile(r.filePath, content, 'utf8');
        return { success: true, filePath: r.filePath };
      });

      ipcMain.handle('account-export', async (event, payload) => {
        try {
          const win = BrowserWindow.fromWebContents(event.sender) || mainWindow;
          const r = await dialog.showSaveDialog(win, {
            title: 'Export Riff account',
            defaultPath: 'riff-account.rfacc',
            filters: [{ name: 'Riff Account (.rfacc)', extensions: ['rfacc'] }]
          });
          if (r.canceled || !r.filePath) return { canceled: true };
          const buffer = encryptAccount(payload || {});
          await fs.promises.writeFile(r.filePath, buffer);
          return { success: true, filePath: r.filePath };
        } catch (err) {
          return { success: false, error: err.message };
        }
      });

      ipcMain.handle('account-import', async (event) => {
        try {
          const win = BrowserWindow.fromWebContents(event.sender) || mainWindow;
          const r = await dialog.showOpenDialog(win, {
            title: 'Import Riff account',
            properties: ['openFile'],
            filters: [{ name: 'Riff Account (.rfacc)', extensions: ['rfacc'] }]
          });
          if (r.canceled || !r.filePaths || !r.filePaths.length) return { canceled: true };
          const buffer = await fs.promises.readFile(r.filePaths[0]);
          const data = decryptAccount(buffer);
          return { success: true, data, filePath: r.filePaths[0] };
        } catch (err) {
          return { success: false, error: err.message };
        }
      });

      ipcMain.handle('show-playlist-context-menu', async (event) => {
        const win = BrowserWindow.fromWebContents(event.sender) || mainWindow;
        return new Promise((resolve) => {
          const menu = Menu.buildFromTemplate([
            {
              label: 'Export as JSON',
              click: () => resolve('export')
            }
          ]);
          menu.popup({
            window: win,
            callback: () => resolve(null)
          });
        });
      });

      const YT_COOKIES_FILE = path.join(DATA_DIR, 'yt-cookies.txt');
      const YT_LOGOUT_FLAG = path.join(DATA_DIR, '.yt-logged-out');

      function hasValidYtCookiesFile() {
        try {
          if (!fs.existsSync(YT_COOKIES_FILE)) return false;
          const txt = fs.readFileSync(YT_COOKIES_FILE, 'utf8');
          return /\.(?:youtube|google)\.com\s+.*\s+(?:SAPISID|__Secure-3PAPISID|__Secure-1PAPISID|LOGIN_INFO|SID)\s+\S+/i.test(txt);
        } catch (_) {
          return false;
        }
      }

      function getSystemDefaultBrowserSpec() {
        try {
          if (process.platform === 'linux') {
            const raw = execSync('xdg-settings get default-web-browser 2>/dev/null || true', { encoding: 'utf8' }).trim().toLowerCase();
            if (raw.includes('firefox')) return 'firefox';
            if (raw.includes('zen')) return 'firefox:' + path.join(os.homedir(), '.zen');
            if (raw.includes('brave')) return 'brave';
            if (raw.includes('google-chrome') || raw.includes('chrome')) return 'chrome';
            if (raw.includes('chromium')) return 'chromium';
            if (raw.includes('vivaldi')) return 'vivaldi';
            if (raw.includes('edge')) return 'edge';
          }
        } catch (_) {}
        return 'firefox';
      }

      function getCandidateBrowserSpecs() {
        const home = os.homedir();
        const specs = [getSystemDefaultBrowserSpec()];
        const addIfDir = (dirPath, spec) => {
          try {
            if (fs.existsSync(dirPath) && !specs.includes(spec)) specs.push(spec);
          } catch (_) {}
        };
        if (process.platform === 'linux') {
          addIfDir(path.join(home, '.mozilla', 'firefox'), 'firefox');
          addIfDir(path.join(home, '.config', 'google-chrome'), 'chrome');
          addIfDir(path.join(home, '.config', 'chromium'), 'chromium');
          addIfDir(path.join(home, '.config', 'BraveSoftware', 'Brave-Browser'), 'brave');
          addIfDir(path.join(home, '.zen'), 'firefox:' + path.join(home, '.zen'));
          addIfDir(path.join(home, '.config', 'zen'), 'firefox:' + path.join(home, '.config', 'zen'));
          addIfDir(path.join(home, '.var/app/app.zen_browser.zen/.zen'), 'firefox:' + path.join(home, '.var/app/app.zen_browser.zen/.zen'));
          addIfDir(path.join(home, '.librewolf'), 'firefox:' + path.join(home, '.librewolf'));
          addIfDir(path.join(home, '.floorp'), 'firefox:' + path.join(home, '.floorp'));
          addIfDir(path.join(home, '.config', 'vivaldi'), 'vivaldi');
          addIfDir(path.join(home, '.config', 'microsoft-edge'), 'edge');
        } else if (process.platform === 'win32') {
          const local = process.env.LOCALAPPDATA || '';
          const roaming = process.env.APPDATA || '';
          addIfDir(path.join(roaming, 'Mozilla', 'Firefox'), 'firefox');
          addIfDir(path.join(local, 'Google', 'Chrome'), 'chrome');
          addIfDir(path.join(local, 'BraveSoftware', 'Brave-Browser'), 'brave');
          addIfDir(path.join(local, 'Microsoft', 'Edge'), 'edge');
          addIfDir(path.join(roaming, 'Zen'), 'firefox:' + path.join(roaming, 'Zen'));
          addIfDir(path.join(local, 'Vivaldi'), 'vivaldi');
        } else if (process.platform === 'darwin') {
          const appSup = path.join(home, 'Library', 'Application Support');
          addIfDir(path.join(appSup, 'Firefox'), 'firefox');
          addIfDir(path.join(appSup, 'Google', 'Chrome'), 'chrome');
          addIfDir(path.join(appSup, 'BraveSoftware', 'Brave-Browser'), 'brave');
          addIfDir(path.join(appSup, 'zen'), 'firefox:' + path.join(appSup, 'zen'));
        }
        if (!specs.includes('firefox')) specs.push('firefox');
        if (!specs.includes('chrome')) specs.push('chrome');
        return specs;
      }

      async function exportYoutubeCookiesToDisk() {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        if (hasValidYtCookiesFile()) return true;

        const tmpTestCookie = '/tmp/test-yt-cookies.txt';
        try {
          if (fs.existsSync(tmpTestCookie)) {
            const tmpTxt = fs.readFileSync(tmpTestCookie, 'utf8');
            if (/SAPISID|__Secure-3PAPISID|LOGIN_INFO|SID/.test(tmpTxt)) {
              fs.writeFileSync(YT_COOKIES_FILE, tmpTxt, 'utf8');
              try { if (fs.existsSync(YT_LOGOUT_FLAG)) fs.unlinkSync(YT_LOGOUT_FLAG); } catch (_) {}
              return true;
            }
          }
        } catch (_) {}

        const ytdlpBin = resolveBinary('yt-dlp');
        if (!ytdlpBin) return false;

        const specs = getCandidateBrowserSpecs();
        for (const spec of specs) {
          try {
            await new Promise((resolve) => {
              execFile(ytdlpBin, [
                '--no-config',
                '--cookies-from-browser', spec,
                '--cookies', YT_COOKIES_FILE,
                '--skip-download',
                '--no-warnings',
                'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
              ], { timeout: 12000, windowsHide: true }, () => resolve());
            });
            if (hasValidYtCookiesFile()) {
              try { if (fs.existsSync(YT_LOGOUT_FLAG)) fs.unlinkSync(YT_LOGOUT_FLAG); } catch (_) {}
              return true;
            }
          } catch (_) {}
        }
        return false;
      }

      ipcMain.handle('google-auth-status', async () => {
        try {
          if (fs.existsSync(YT_LOGOUT_FLAG)) {
            return { loggedIn: false };
          }
          if (hasValidYtCookiesFile()) {
            return { loggedIn: true };
          }
          const synced = await exportYoutubeCookiesToDisk();
          return { loggedIn: synced };
        } catch (e) {
          return { loggedIn: false };
        }
      });

      ipcMain.handle('google-logout', async () => {
        try {
          fs.mkdirSync(DATA_DIR, { recursive: true });
          fs.writeFileSync(YT_LOGOUT_FLAG, '1', 'utf8');
          if (fs.existsSync(YT_COOKIES_FILE)) fs.unlinkSync(YT_COOKIES_FILE);
          const s = session.fromPartition('persist:riff-google');
          await s.clearStorageData();
          return { success: true };
        } catch (e) {
          return { success: false, error: e && e.message ? e.message : 'Logout failed' };
        }
      });

      ipcMain.handle('google-login', async () => {
        try {
          if (fs.existsSync(YT_LOGOUT_FLAG)) fs.unlinkSync(YT_LOGOUT_FLAG);
        } catch (_) {}

        const alreadyInBrowser = await exportYoutubeCookiesToDisk();
        if (alreadyInBrowser && hasValidYtCookiesFile()) {
          return { success: true, loggedIn: true };
        }

        shell.openExternal('https://accounts.google.com/ServiceLogin?service=youtube&continue=https%3A%2F%2Fwww.youtube.com%2F');

        const start = Date.now();
        while (Date.now() - start < 90000) {
          await new Promise(r => setTimeout(r, 3500));
          const ok = await exportYoutubeCookiesToDisk();
          if (ok && hasValidYtCookiesFile()) {
            return { success: true, loggedIn: true };
          }
        }
        return { success: false, loggedIn: false };
      });

      ipcMain.handle('google-import-library', async (event, opts) => {
        const s = session.fromPartition('persist:riff-google');
        const cookies = await s.cookies.get({ name: 'SAPISID' });
        const sapisidCookie = Array.isArray(cookies) ? cookies.find(c => c && c.value) : null;
        return require('../shared/google-library').importGoogleLibrary(opts, {
          sapisid: sapisidCookie ? sapisidCookie.value : '',
          fetchImpl: (u, o) => s.fetch(u, o)
        });
      });

      function setupTray() {
        try {
          const iconPath = path.join(__dirname, '../../assets', 'icon.png');
          let trayIcon = nativeImage.createFromPath(iconPath);
          trayIcon = trayIcon.resize({ width: 22, height: 22 });
          tray = new Tray(trayIcon);
          tray.setToolTip('Pulse');
          const contextMenu = Menu.buildFromTemplate([
            {
              label: 'Show/Hide',
              click: () => {
                if (!mainWindow || mainWindow.isDestroyed()) return;
                if (mainWindow.isVisible()) mainWindow.hide();
                else { mainWindow.show(); mainWindow.focus(); }
              }
            },
            {
              label: 'Play/Pause',
              click: () => {
                if (mainWindow && !mainWindow.isDestroyed()) {
                  mainWindow.webContents.send('media-command', 'toggle');
                }
              }
            },
            { type: 'separator' },
            {
              label: 'Quit',
              click: () => {
                isQuitting = true;
                app.quit();
              }
            }
          ]);
          tray.setContextMenu(contextMenu);
          tray.on('click', () => {
            if (!mainWindow || mainWindow.isDestroyed()) return;
            if (mainWindow.isVisible()) mainWindow.hide();
            else { mainWindow.show(); mainWindow.focus(); }
          });
        } catch (err) {
          console.warn('Tray creation failed:', err);
          tray = null;
        }
      }

      app.on('before-quit', () => {
        isQuitting = true;
      });

      app.whenReady().then(() => {
        if (!fs.existsSync(YT_LOGOUT_FLAG)) exportYoutubeCookiesToDisk().catch(() => {});
        global.riffSessionFetch = (urlStr, opts) => session.defaultSession.fetch(urlStr, opts);
        if (process.platform === 'darwin' && app.dock) {
          try {
            const dockIcon = nativeImage.createFromPath(path.join(__dirname, '../../assets', 'icon.png'));
            if (!dockIcon.isEmpty()) app.dock.setIcon(dockIcon);
          } catch (_) {}
        }
        setupTray();
        try { require('./launcher').refreshLauncherOnStartup?.(); } catch (_) {}
        try {
          session.defaultSession.webRequest.onBeforeSendHeaders(
            { urls: ['*://*.googlevideo.com/*'] },
            (details, callback) => {
              const h = details.requestHeaders || {};
              try {
                const u = new URL(details.url);
                const c = (u.searchParams.get('c') || '').toUpperCase();
                if (c === 'ANDROID_VR') {
                  h['User-Agent'] = 'com.google.android.apps.youtube.vr.oculus/1.61.48 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip';
                } else if (c === 'IOS') {
                  h['User-Agent'] = 'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)';
                } else if (c === 'ANDROID_MUSIC') {
                  h['User-Agent'] = 'com.google.android.apps.youtube.music/7.27.52 (Linux; U; Android 14; en_US; sdk_gphone64_x86_64 Build/UE1A.230829.036) gzip';
                } else if (c === 'TVHTML5_SIMPLY_EMBEDDED_PLAYER' || c.startsWith('TVHTML5')) {
                  h['User-Agent'] = 'Mozilla/5.0 (SMART-TV; LINUX; Tizen 6.5) AppleWebKit/537.36 (KHTML, like Gecko) 85.0.4183.93/6.5 TV Safari/537.36';
                } else if (c === 'ANDROID_TESTSUITE') {
                  h['User-Agent'] = 'com.google.android.youtube/1.9 (Linux; U; Android 11; en_US) gzip';
                } else if (c.startsWith('ANDROID')) {
                  h['User-Agent'] = 'com.google.android.youtube/19.44.38 (Linux; U; Android 14; en_US; sdk_gphone64_x86_64 Build/UE1A.230829.036) gzip';
                }
                delete h['Origin'];
                delete h['origin'];
                delete h['Referer'];
                delete h['referer'];
              } catch (_) {}
              callback({ requestHeaders: h });
            }
          );
        } catch (_) {}
        try {
          session.defaultSession.webRequest.onHeadersReceived(
            {
              urls: [
                '*://*.googlevideo.com/*',
                '*://*.ytimg.com/*',
                '*://*.ggpht.com/*',
                '*://*.googleusercontent.com/*',
                '*://*.scdn.co/*',
                '*://*.spotifycdn.com/*',
                '*://*.mzstatic.com/*',
                '*://*.sndcdn.com/*',
                '*://*.dzcdn.net/*',
                '*://*.yandex.net/*'
              ]
            },
            (details, callback) => {
              const rh = Object.assign({}, details.responseHeaders || {});
              delete rh['access-control-allow-origin'];
              delete rh['Access-Control-Allow-Origin'];
              rh['Access-Control-Allow-Origin'] = ['*'];
              rh['Access-Control-Allow-Headers'] = ['*'];
              rh['Access-Control-Expose-Headers'] = ['Content-Length, Content-Range, Accept-Ranges'];
              callback({ responseHeaders: rh });
            }
          );
        } catch (_) {}
        createWindow();
        try {
          globalShortcut.register('MediaPlayPause', () => {
            mainWindow?.webContents.send('media-control', 'play-pause');
          });
          globalShortcut.register('MediaNextTrack', () => {
            mainWindow?.webContents.send('media-control', 'next');
          });
          globalShortcut.register('MediaPreviousTrack', () => {
            mainWindow?.webContents.send('media-control', 'prev');
          });
        } catch (e) {}
        // Pulse: auto-updater removed; keep get-app-version / update-check answering.
        try { ipcMain.removeHandler('get-app-version'); } catch (_) {}
        ipcMain.handle('get-app-version', () => app.getVersion());
        try { ipcMain.removeHandler('update-check'); } catch (_) {}
        ipcMain.handle('update-check', () => ({ ok: true, disabled: true }));
        app.on('activate', () => {
          if (BrowserWindow.getAllWindows().length === 0) createWindow();
        });
      });

      app.on('window-all-closed', () => {
        discordRPC.destroyRPC();
        if (process.platform !== 'darwin') app.quit();
      });
}
