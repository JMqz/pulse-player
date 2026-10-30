// Pulse: window.electronAPI implementation for the Tauri v2 / WebView2 host (src-tauri).
// Loaded before every other renderer script; does nothing under Electron (preload.js already
// exposed electronAPI). The page is served by the Rust host from http://pulse.localhost and the
// host injects window.__PULSE__ = { port, token, version, webview } before any script runs.
//
//   Rust host (invoke)          window, tray-on-close, mini player, dialogs, media keys, zoom, links
//   Rust host (same-origin)     /__pulse/storage, /__pulse/cache, /__pulse/file (local media, Range)
//   Node host (/__host/*)       local metadata, data/download folders, account files, Google cookies
(() => {
  if (window.electronAPI || !window.__TAURI_INTERNALS__) return;
  const boot = window.__PULSE__ || {};
  const port = boot.port || 38472;
  const token = boot.token || '';
  const serverBase = `http://127.0.0.1:${port}`;

  const invoke = (cmd, args) => window.__TAURI_INTERNALS__.invoke(cmd, args || {});
  const fire = (cmd, args) => { invoke(cmd, args).catch((e) => console.warn('[pulse]', cmd, e)); };

  // ---------- host -> page events (Rust calls window.__pulseEmit via webview.eval) ----------
  const listeners = {};
  const on = (name, cb) => { if (typeof cb === 'function') (listeners[name] = listeners[name] || []).push(cb); };
  window.__pulseEmit = (name, payload) => {
    for (const cb of listeners[name] || []) {
      try { cb(payload); } catch (e) { console.error('[pulse] listener', name, e); }
    }
  };

  // ---------- updates (GitHub releases of the Pulse repo) ----------
  const PULSE_RELEASES_API = 'https://api.github.com/repos/JMqz/pulse-player/releases/latest';
  const PULSE_RELEASES_PAGE = 'https://github.com/JMqz/pulse-player/releases/latest';
  function isNewerVersion(latest, current) {
    const a = String(latest).split('.').map((n) => parseInt(n, 10) || 0);
    const b = String(current).split('.').map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
    }
    return false;
  }

  // ---------- Node host calls ----------
  let serverReady = null;
  const waitServer = () => serverReady || (serverReady = invoke('server_wait').catch((e) => { serverReady = null; throw e; }));
  async function host(name, body) {
    await waitServer();
    const res = await fetch(`${serverBase}/__host/${name}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Riff-Token': token },
      body: JSON.stringify(body || {})
    });
    return res.json();
  }

  // ---------- synchronous same-origin storage (replaces ipcRenderer.sendSync) ----------
  function syncRequest(method, path, body) {
    try {
      const xhr = new XMLHttpRequest();
      xhr.open(method, path, false);
      if (body !== undefined) xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.send(body);
      return xhr.status === 200 ? xhr.responseText : null;
    } catch (_) {
      return null;
    }
  }

  // ---------- file:// -> same-origin local media route ----------
  function localUrl(u) {
    if (typeof u !== 'string' || !/^file:/i.test(u)) return u;
    let p;
    try { p = decodeURIComponent(new URL(u).pathname); } catch (_) { return u; }
    if (/^\/[a-zA-Z]:\//.test(p)) p = p.slice(1);
    return '/__pulse/file?p=' + encodeURIComponent(p.replace(/\//g, '\\'));
  }
  const rewriteCss = (v) => (typeof v === 'string' && v.indexOf('file:') !== -1)
    ? v.replace(/url\(\s*(["']?)(file:[^"')]+)\1\s*\)/gi, (m, q, u) => `url(${q}${localUrl(u)}${q})`)
    : v;

  function patchSetter(proto, prop, rewrite) {
    const desc = proto && Object.getOwnPropertyDescriptor(proto, prop);
    if (!desc || !desc.set) return;
    Object.defineProperty(proto, prop, {
      configurable: true,
      enumerable: desc.enumerable,
      get: desc.get,
      set(v) { desc.set.call(this, rewrite(v)); }
    });
  }
  for (const proto of [HTMLMediaElement.prototype, HTMLImageElement.prototype, HTMLSourceElement.prototype]) {
    patchSetter(proto, 'src', localUrl);
  }
  patchSetter(HTMLVideoElement.prototype, 'poster', localUrl);
  // el.style.backgroundImage & co. are named-property interceptors in Chromium (not patchable
  // accessors), so inline styles are fixed up after the fact when they mention file: URLs.
  const fixStyle = (el) => {
    const css = el.getAttribute && el.getAttribute('style');
    if (css && css.indexOf('file:') !== -1) el.setAttribute('style', css);
  };
  new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === 'attributes') { fixStyle(m.target); continue; }
      for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue;
        fixStyle(n);
        if (n.firstElementChild) n.querySelectorAll('[style*="file:"]').forEach(fixStyle);
      }
    }
  }).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['style'] });
  const origSetProperty = CSSStyleDeclaration.prototype.setProperty;
  CSSStyleDeclaration.prototype.setProperty = function (name, value, priority) {
    return origSetProperty.call(this, name, rewriteCss(value), priority);
  };
  const origSetAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name, value) {
    const n = String(name).toLowerCase();
    if (n === 'src' || n === 'poster' || n === 'href') value = localUrl(value);
    else if (n === 'style') value = rewriteCss(value);
    return origSetAttribute.call(this, name, value);
  };
  const origFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    if (typeof input === 'string') {
      // The webview runs with --disable-web-security (like Electron's webSecurity:false, needed so
      // Web Audio can process media from the local server), and then Chromium omits the Origin
      // header that Tauri's ipc.localhost transport requires. Failing that request at the network
      // level makes Tauri switch to its postMessage transport for the rest of the session.
      if (input.startsWith('http://ipc.localhost/')) return Promise.reject(new TypeError('pulse: postMessage IPC'));
      if (/^file:/i.test(input)) input = localUrl(input);
    }
    return origFetch(input, init);
  };

  // ---------- frameless window dragging (Electron's -webkit-app-region) ----------
  function appRegion(el) {
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const r = getComputedStyle(n).getPropertyValue('-webkit-app-region') || getComputedStyle(n).getPropertyValue('app-region');
      if (r === 'drag' || r === 'no-drag') return r;
      if (n.matches('button, a, input, select, textarea, [contenteditable="true"]')) return 'no-drag';
    }
    return 'none';
  }
  window.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || appRegion(e.target) !== 'drag') return;
    if (e.detail === 2) fire('win_toggle_maximize');
    else fire('win_start_drag');
  }, true);

  // ---------- dialogs ----------
  const AUDIO = ['mp3', 'flac', 'wav', 'ogg', 'm4a', 'aac', 'opus', 'wma'];
  const openDialog = (opts) => invoke('dialog_open', { opts });
  const saveDialog = (opts) => invoke('dialog_save', { opts });
  const toFileUrl = (p) => 'file:///' + p.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/').replace(/^([a-zA-Z])%3A/, '$1:');

  // ---------- media keys ----------
  let mediaKeysWanted = true;
  let mediaKeysActive = false;
  const syncMediaKeys = () => fire('set_media_keys', { enabled: mediaKeysWanted && mediaKeysActive });

  // ---------- debounced storage saves ----------
  const STORAGE_DEBOUNCE_MS = 200;
  const STORAGE_MAX_WAIT_MS = 1000;
  let storageTimer = 0;
  let storageDirty = false;
  let storageFirstDirty = 0;
  function flushStorage() {
    clearTimeout(storageTimer);
    storageFirstDirty = 0;
    if (!storageDirty || !window.__pulseLastStorage) return;
    storageDirty = false;
    fetch('/__pulse/storage?debounce=1', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(window.__pulseLastStorage), keepalive: false }).catch(noop);
  }
  // Going to the tray/minimised or unloading: don't leave a change waiting in the timer.
  const flushStorageNow = () => {
    if (!storageDirty) return;
    clearTimeout(storageTimer);
    storageDirty = false;
    storageFirstDirty = 0;
    try { syncRequest('POST', '/__pulse/storage', JSON.stringify(window.__pulseLastStorage)); } catch (_) {}
  };
  on('window-visibility', (visible) => { if (!visible) flushStorageNow(); });
  window.addEventListener('pagehide', flushStorageNow);
  document.addEventListener('visibilitychange', () => { if (document.hidden) flushStorageNow(); });

  const noop = () => {};
  const api = {
    serverToken: token,
    isWindows: true,

    minimizeWindow: () => fire('win_minimize'),
    maximizeWindow: () => fire('win_toggle_maximize'),
    closeWindow: () => fire('win_close'),
    toggleMiniWindow: () => invoke('toggle_mini_window'),
    setMiniLyrics: (enabled) => invoke('set_mini_lyrics', { enabled: !!enabled }),
    setTrayOnClose: (enabled) => fire('set_tray_on_close', { enabled: !!enabled }),
    onWindowVisibility: (cb) => on('window-visibility', cb),
    setZoomFactor: (factor) => { const f = Number(factor) || 1; api._zoom = f; fire('set_zoom', { factor: f }); },
    getZoomFactor: () => api._zoom || 1,
    clearWebFrameCache: noop,
    restartApp: () => {
      try { syncRequest('POST', '/__pulse/storage', JSON.stringify(window.__pulseLastStorage || null)); } catch (_) {}
      fire('restart_app');
    },

    getServerPort: async () => (await waitServer()).port,
    setAppProxy: (proxyUrl) => invoke('set_app_proxy', { proxy: String(proxyUrl || '') }),
    getGpuCompositing: async () => 'enabled',
    getAppVersion: async () => boot.version || '',
    // No in-place installer: a newer GitHub release is announced and the sheet opens its page.
    checkForUpdates: async () => {
      try {
        const res = await fetch(PULSE_RELEASES_API, { headers: { Accept: 'application/vnd.github+json' }, cache: 'no-store' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const rel = await res.json();
        const version = String(rel.tag_name || '').replace(/^v/i, '');
        if (version && isNewerVersion(version, boot.version || '0')) {
          window.__pulseEmit('update-available', {
            version, releaseNotes: rel.body || '', publishedAt: rel.published_at || '',
            htmlUrl: rel.html_url || PULSE_RELEASES_PAGE, canInstall: false
          });
        } else {
          window.__pulseEmit('update-not-available', { version });
        }
        return { ok: true };
      } catch (e) {
        window.__pulseEmit('update-error', { message: e && e.message ? e.message : String(e) });
        return { ok: true, error: true };
      }
    },
    updateAction: noop,
    installUpdateNow: noop,
    onUpdateAvailable: (cb) => on('update-available', cb),
    onUpdateNotAvailable: (cb) => on('update-not-available', cb),
    onUpdateError: (cb) => on('update-error', cb),
    onUpdateDownloaded: noop, onUpdateProgress: noop, onUpdateReady: noop,

    openExternal: (u) => fire('open_external', { url: String(u || '') }),
    openLogsFolder: async () => fire('open_path', { path: await host('logs-dir') }),
    logError: (level, message, stack) => { host('log', { level, message, stack }).catch(noop); },
    getDiagnostics: () => host('diagnostics', { version: boot.version, webview: boot.webview }),
    getAudioOutputInfo: () => host('audio-output-info'),

    pickMedia: async () => {
      const r = await openDialog({ filters: [{ name: 'Media', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'mp4', 'webm'] }] });
      return r && r.length ? toFileUrl(r[0]) : null;
    },
    importAudioFiles: async () => {
      const r = await openDialog({ multiple: true, filters: [{ name: 'Audio', extensions: ['mp3', 'wav', 'flac', 'opus', 'ogg', 'oga', 'm4a', 'aac', 'webm', 'weba'] }] });
      return r && r.length ? host('import-audio-files', { paths: r }) : [];
    },
    pickLocalFiles: async () => {
      const r = await openDialog({ multiple: true, filters: [{ name: 'Audio', extensions: AUDIO }] });
      return r && r.length ? host('local-metadata', { paths: r }) : [];
    },
    pickLocalFolder: async () => {
      const r = await openDialog({ directory: true, multiple: true });
      return r && r.length ? host('scan-folders', { dirs: r }) : [];
    },
    rescanLocalMetadata: (paths) => Array.isArray(paths) ? host('local-metadata', { paths }) : Promise.resolve([]),

    getCacheSize: () => host('cache-size'),
    clearCache: () => host('clear-cache'),
    getDataDir: () => host('data-dir-get'),
    pickDataDir: async () => {
      const cur = await host('data-dir-get').catch(() => ({}));
      const r = await openDialog({ title: 'Choose music folder', directory: true, defaultPath: cur.dir });
      return r && r.length ? r[0] : null;
    },
    setDataDir: (dir, move) => host('data-dir-set', { dir, move }),
    getDownloadDir: () => host('download-dir-get'),
    pickDownloadDir: async () => {
      const cur = await host('download-dir-get').catch(() => ({}));
      const r = await openDialog({ title: 'Choose download folder', directory: true, defaultPath: cur.dir });
      return r && r.length ? r[0] : null;
    },
    setDownloadDir: (dir) => host('download-dir-set', { dir }),
    resetDownloadDir: () => host('download-dir-set', { reset: true }),

    getMultiInstance: () => host('multi-instance-get'),
    setMultiInstance: (v) => { host('multi-instance-set', { value: !!v }).catch(noop); },

    onMediaCommand: (cb) => on('media-command', cb),
    onMediaControl: (cb) => on('media-control', cb),
    setMediaKeys: (v) => { mediaKeysWanted = !!v; syncMediaKeys(); },
    mediaKeysActive: () => { if (!mediaKeysActive) { mediaKeysActive = true; syncMediaKeys(); } },

    // Discord RPC, launcher, plugins and the welcome tutorial were removed from Pulse.
    discordRpcUpdate: noop, discordRpcClear: noop, discordRpcSetEnabled: noop,
    discordRpcGetEnabled: async () => false, discordRpcGetConnected: async () => false, discordRpcReconnect: async () => true,
    welcomeFinish: noop, onWelcomeResult: noop,
    getLauncherInfo: async () => ({ supported: false }),
    installLauncher: async () => ({ ok: false, error: 'Not available in Pulse' }),
    listThemes: async () => [], importThemes: async () => [], setThemeEnabled: noop, disableAllThemes: noop, removeTheme: noop,
    listPlugins: async () => [], importPlugins: async () => ({ ok: false }), setPluginEnabled: noop, disableAllPlugins: noop,
    openPluginsFolder: noop, removePlugin: noop,
    getAppCss: async () => '',

    // Sign-in happens in a native WebView2 window (src-tauri/src/google.rs): browsers' cookie stores
    // are no longer readable by yt-dlp on Windows.
    googleLogin: () => invoke('google_login'),
    googleLogout: async () => {
      const res = await host('google-logout');
      await invoke('google_logout').catch(() => false);
      return res;
    },
    googleAuthStatus: () => host('google-auth-status'),
    googleImportLibrary: (opts) => host('google-import-library', opts || {}),

    savePlaylistsJson: async (payload) => {
      const p = await saveDialog({ title: 'Export playlists as JSON', defaultName: (payload && payload.defaultName) || 'playlists.json', filters: [{ name: 'JSON', extensions: ['json'] }] });
      if (!p) return { canceled: true };
      return host('write-text', { path: p, content: (payload && payload.content) || '' });
    },
    showPlaylistContextMenu: () => invoke('playlist_context_menu'),
    accountExport: async (payload) => {
      const p = await saveDialog({ title: 'Export Pulse account', defaultName: 'pulse-account.pulseacc', filters: [{ name: 'Pulse Account (.pulseacc)', extensions: ['pulseacc'] }] });
      if (!p) return { canceled: true };
      return host('account-export', { path: p, payload: payload || {} }).catch((e) => ({ success: false, error: e.message }));
    },
    accountImport: async () => {
      const r = await openDialog({ title: 'Import Pulse account', filters: [{ name: 'Pulse Account (.pulseacc, .rfacc)', extensions: ['pulseacc', 'rfacc'] }] });
      if (!r || !r.length) return { canceled: true };
      return host('account-import', { path: r[0] }).catch((e) => ({ success: false, error: e.message }));
    },

    storageInitSync: () => {
      const txt = syncRequest('GET', '/__pulse/storage');
      try { return txt ? JSON.parse(txt) : null; } catch (_) { return null; }
    },
    // Bursts of setItem (queue edits, settings sliders, playback state) coalesce into one
    // JSON.stringify + request: sent 200 ms after the last change, at most 1 s after the first.
    storageSaveBatch: (data) => {
      if (!data || typeof data !== 'object') return;
      window.__pulseLastStorage = data;
      storageDirty = true;
      clearTimeout(storageTimer);
      if (!storageFirstDirty) storageFirstDirty = Date.now();
      const wait = Math.max(0, Math.min(STORAGE_DEBOUNCE_MS, storageFirstDirty + STORAGE_MAX_WAIT_MS - Date.now()));
      storageTimer = setTimeout(flushStorage, wait);
    },
    storageSaveSync: (data) => {
      clearTimeout(storageTimer);
      storageDirty = false;
      storageFirstDirty = 0;
      if (data && typeof data === 'object') syncRequest('POST', '/__pulse/storage', JSON.stringify(data));
      return true;
    },
    readCacheFile: async () => {
      const r = await fetch('/__pulse/cache').catch(() => null);
      return r && r.ok ? r.json().catch(() => null) : null;
    },
    writeCacheFile: (data) => {
      if (!data || typeof data !== 'object') return;
      fetch('/__pulse/cache', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }).catch(noop);
    }
  };

  window.electronAPI = api;
  window.riff = api;
})();
