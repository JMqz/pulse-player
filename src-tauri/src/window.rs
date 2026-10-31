//! Main window: creation, persisted bounds, mini player, visibility events to the page.

use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::webview::Color;
use tauri::{AppHandle, LogicalSize, Manager, PhysicalPosition, PhysicalSize, Size, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};

use crate::{paths, AppState};

pub const MAIN: &str = "main";
const MIN_W: f64 = 800.0;
const MIN_H: f64 = 540.0;
/// Without focus for this long (another app in front, mini player left aside) the WebView
/// is asked to trim memory even though it is still visible.
const UNFOCUSED_LOW_AFTER: std::time::Duration = std::time::Duration::from_secs(30);

#[derive(Clone, Copy, Serialize, Deserialize, Default)]
pub struct Bounds {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    #[serde(default, rename = "isMaximized")]
    pub maximized: bool,
}

#[derive(Default)]
pub struct WindowState {
    /// Last normal (not maximized / minimized / mini) bounds, persisted on exit.
    pub normal: Option<Bounds>,
    pub maximized: bool,
    pub mini: bool,
    pub pre_mini: Option<Bounds>,
    pub pre_mini_lyrics_h: Option<f64>,
    pub visible: bool,
    /// Bumped on every focus change so a pending "unfocused for a while" timer can tell it is stale.
    focus_gen: u64,
    unfocused_long: bool,
    /// The page reports the player idle (paused/stopped and no input for a while).
    page_idle: bool,
    memory_low: bool,
}

fn state_file() -> std::path::PathBuf {
    paths::user_data().join("window-state.json")
}

fn load_bounds() -> Option<Bounds> {
    #[derive(Deserialize)]
    struct OnDisk {
        bounds: Bounds,
        #[serde(default, rename = "isMaximized")]
        is_maximized: bool,
    }
    let bytes = std::fs::read(state_file()).ok()?;
    let disk: OnDisk = serde_json::from_slice(&bytes).ok()?;
    Some(Bounds { maximized: disk.is_maximized, ..disk.bounds })
}

pub fn save_bounds(ws: &Mutex<WindowState>) {
    let ws = ws.lock().unwrap();
    if let Some(b) = ws.normal {
        let json = serde_json::json!({ "bounds": b, "isMaximized": ws.maximized });
        let _ = paths::write_atomic(&state_file(), json.to_string().as_bytes());
    }
}

/// Browser flags: Electron ran with webSecurity:false and autoplay allowed; the renderer relies on
/// cross-origin fetches to the local server and to lyric/cover APIs. Tauri's own default
/// --disable-features list is repeated because setting args replaces it.
/// Memory: a small V8 old space (the page heap is ~5-30 MB), one raster thread and no GPU
/// shader disk cache keep the renderer and GPU process lean.
fn browser_args(proxy: &str) -> String {
    let mut args = String::from(
        "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,CalculateNativeWinOcclusion,Translate,AutofillServerCommunication \
         --disable-web-security --autoplay-policy=no-user-gesture-required \
         --enable-features=TrimOnMemoryPressure,ResourceScheduler \
         --renderer-process-limit=1 --js-flags=--max-old-space-size=96 \
         --num-raster-threads=1 --disable-gpu-shader-disk-cache --disable-bundled-ppapi-flash \
         --disk-cache-size=33554432 --media-cache-size=33554432 \
         --disable-background-networking --disable-component-update --disable-sync --disable-speech-api",
    );
    if !proxy.is_empty() && !proxy.contains(char::is_whitespace) {
        args.push_str(&format!(" --proxy-server={proxy} --proxy-bypass-list=<local>;127.0.0.1;localhost;pulse.localhost"));
    }
    args
}

pub fn create(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let state = app.state::<AppState>();
    let boot = serde_json::json!({
        "port": state.server.port,
        "token": state.server.token,
        "version": app.package_info().version.to_string(),
        "webview": tauri::webview_version().unwrap_or_default(),
    });
    let init = format!("window.__PULSE__ = Object.freeze({boot});");
    let url = WebviewUrl::CustomProtocol("pulse://localhost/src/renderer/index.html".parse().unwrap());

    let window = WebviewWindowBuilder::new(app, MAIN, url)
        .title("Pulse")
        .decorations(false)
        .shadow(true)
        .visible(false)
        .min_inner_size(MIN_W, MIN_H)
        .background_color(Color(0, 0, 0, 255))
        .initialization_script(init)
        .additional_browser_args(&browser_args(&state.config.lock().unwrap().proxy))
        .disable_drag_drop_handler()
        .build()?;

    let saved = load_bounds();
    let bounds = saved.and_then(|b| clamp_to_monitors(&window, b)).or_else(|| default_bounds(&window));
    if let Some(b) = bounds {
        let _ = window.set_size(Size::Physical(PhysicalSize::new(b.width, b.height)));
        let _ = window.set_position(PhysicalPosition::new(b.x, b.y));
        state.window.lock().unwrap().normal = Some(b);
    }
    if saved.map(|b| b.maximized).unwrap_or(false) {
        let _ = window.maximize();
    }
    let _ = window.show();
    state.window.lock().unwrap().visible = true;

    let handle = app.clone();
    window.on_window_event(move |event| on_event(&handle, event));
    Ok(window)
}

fn default_bounds(window: &WebviewWindow) -> Option<Bounds> {
    let monitor = window.primary_monitor().ok().flatten()?;
    let wa = monitor.work_area();
    Some(Bounds {
        width: (wa.size.width as f64 * 0.82) as u32,
        height: (wa.size.height as f64 * 0.86) as u32,
        x: wa.position.x + (wa.size.width as f64 * 0.09) as i32,
        y: wa.position.y + (wa.size.height as f64 * 0.07) as i32,
        maximized: false,
    })
}

/// Keeps saved bounds only if they still land on a connected monitor (shrinking to fit).
fn clamp_to_monitors(window: &WebviewWindow, b: Bounds) -> Option<Bounds> {
    let monitors = window.available_monitors().ok()?;
    let (cx, cy) = (b.x + b.width as i32 / 2, b.y + b.height as i32 / 2);
    let wa = monitors.iter().map(|m| *m.work_area()).find(|wa| {
        cx >= wa.position.x && cy >= wa.position.y
            && cx < wa.position.x + wa.size.width as i32 && cy < wa.position.y + wa.size.height as i32
    })?;
    let width = b.width.min(wa.size.width);
    let height = b.height.min(wa.size.height);
    let x = b.x.clamp(wa.position.x, wa.position.x + (wa.size.width - width) as i32);
    let y = b.y.clamp(wa.position.y, wa.position.y + (wa.size.height - height) as i32);
    Some(Bounds { x, y, width, height, maximized: b.maximized })
}

fn on_event(app: &AppHandle, event: &WindowEvent) {
    let state = app.state::<AppState>();
    let Some(window) = app.get_webview_window(MAIN) else { return };
    match event {
        WindowEvent::CloseRequested { api, .. } => {
            save_bounds(&state.window);
            if state.tray_on_close() && !state.is_quitting() {
                api.prevent_close();
                hide(app);
            } else {
                state.begin_quit();
            }
        }
        WindowEvent::Resized(_) | WindowEvent::Moved(_) => {
            let minimized = window.is_minimized().unwrap_or(false);
            let maximized = window.is_maximized().unwrap_or(false);
            let mut ws = state.window.lock().unwrap();
            if !minimized {
                ws.maximized = maximized;
            }
            if !minimized && !maximized && !ws.mini {
                if let (Ok(pos), Ok(size)) = (window.outer_position(), window.inner_size()) {
                    ws.normal = Some(Bounds { x: pos.x, y: pos.y, width: size.width, height: size.height, maximized: false });
                }
            }
            let visible = !minimized && window.is_visible().unwrap_or(true);
            if visible != ws.visible {
                ws.visible = visible;
                drop(ws);
                emit(app, "window-visibility", serde_json::Value::Bool(visible));
                apply_memory_target(app);
            }
        }
        WindowEvent::Focused(focused) => on_focus(app, *focused),
        _ => {}
    }
}

fn on_focus(app: &AppHandle, focused: bool) {
    let state = app.state::<AppState>();
    let gen = {
        let mut ws = state.window.lock().unwrap();
        ws.focus_gen += 1;
        ws.unfocused_long = false;
        ws.focus_gen
    };
    apply_memory_target(app);
    if !focused {
        let app = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(UNFOCUSED_LOW_AFTER);
            let state = app.state::<AppState>();
            {
                let mut ws = state.window.lock().unwrap();
                if ws.focus_gen != gen {
                    return;
                }
                ws.unfocused_long = true;
            }
            apply_memory_target(&app);
        });
    }
}

/// Called by the page (set_player_idle) when playback has been stopped/paused with no input for a while.
pub fn set_page_idle(app: &AppHandle, idle: bool) {
    app.state::<AppState>().window.lock().unwrap().page_idle = idle;
    apply_memory_target(app);
}

/// LOW while hidden, unfocused for UNFOCUSED_LOW_AFTER, or with the player idle; NORMAL otherwise.
fn apply_memory_target(app: &AppHandle) {
    let state = app.state::<AppState>();
    let low = {
        let mut ws = state.window.lock().unwrap();
        let low = !ws.visible || ws.unfocused_long || ws.page_idle;
        if low == ws.memory_low {
            return;
        }
        ws.memory_low = low;
        low
    };
    set_memory_target(app, !low);
}

/// MemoryUsageTargetLevel LOW makes WebView2 release caches and GPU resources (playback keeps
/// running); NORMAL when the window is in use again.
#[cfg(windows)]
fn set_memory_target(app: &AppHandle, normal: bool) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2_19, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL,
    };
    use windows_core::Interface;
    let Some(window) = app.get_webview_window(MAIN) else { return };
    let _ = window.with_webview(move |wv| unsafe {
        let level = if normal { COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL } else { COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW };
        if let Ok(core) = wv.controller().CoreWebView2() {
            if let Ok(core19) = core.cast::<ICoreWebView2_19>() {
                let _ = core19.SetMemoryUsageTargetLevel(level);
            }
        }
    });
}
#[cfg(not(windows))]
fn set_memory_target(_app: &AppHandle, _normal: bool) {}

/// Calls window.__pulseEmit(name, payload) in the page (see src/renderer/tauri-bridge.js).
pub fn emit(app: &AppHandle, name: &str, payload: serde_json::Value) {
    if let Some(window) = app.get_webview_window(MAIN) {
        let script = format!(
            "window.__pulseEmit && window.__pulseEmit({}, {payload});",
            serde_json::Value::String(name.into())
        );
        let _ = window.eval(script);
    }
}

pub fn show(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(MAIN) {
        if w.is_minimized().unwrap_or(false) {
            let _ = w.unminimize();
        }
        let _ = w.show();
        let _ = w.set_focus();
        set_visible(app, true);
    }
}

pub fn hide(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(MAIN) {
        let _ = w.hide();
        set_visible(app, false);
    }
}

pub fn toggle(app: &AppHandle) {
    let visible = app.get_webview_window(MAIN).and_then(|w| w.is_visible().ok()).unwrap_or(false);
    if visible { hide(app) } else { show(app) }
}

fn set_visible(app: &AppHandle, visible: bool) {
    let state = app.state::<AppState>();
    let changed = {
        let mut ws = state.window.lock().unwrap();
        std::mem::replace(&mut ws.visible, visible) != visible
    };
    if changed {
        emit(app, "window-visibility", serde_json::Value::Bool(visible));
        apply_memory_target(app);
    }
}

/// Electron's toggle-mini-window: a small always-on-top player, restoring the old bounds after.
///
/// The state lock is never held across window calls: set_size & co. dispatch WM_SIZE
/// synchronously into on_event on this same thread, which takes the lock too.
pub fn toggle_mini(app: &AppHandle) -> bool {
    let state = app.state::<AppState>();
    let Some(w) = app.get_webview_window(MAIN) else { return false };
    let (entering, restore) = {
        let mut ws = state.window.lock().unwrap();
        ws.mini = !ws.mini;
        if ws.mini {
            ws.pre_mini = ws.normal;
        } else {
            ws.pre_mini_lyrics_h = None;
        }
        (ws.mini, ws.pre_mini)
    };
    if entering {
        if w.is_maximized().unwrap_or(false) {
            let _ = w.unmaximize();
        }
        let _ = w.set_min_size(Some(Size::Logical(LogicalSize::new(280.0, 115.0))));
        let _ = w.set_size(Size::Logical(LogicalSize::new(380.0, 160.0)));
        let _ = w.set_always_on_top(true);
    } else {
        let _ = w.set_always_on_top(false);
        let _ = w.set_min_size(Some(Size::Logical(LogicalSize::new(MIN_W, MIN_H))));
        match restore {
            Some(b) => {
                let _ = w.set_size(Size::Physical(PhysicalSize::new(b.width, b.height)));
                let _ = w.set_position(PhysicalPosition::new(b.x, b.y));
            }
            None => {
                let _ = w.set_size(Size::Logical(LogicalSize::new(1000.0, 700.0)));
            }
        }
    }
    entering
}

/// Electron's set-mini-lyrics: grow the mini player to show lyrics, or shrink it back.
pub fn set_mini_lyrics(app: &AppHandle, enabled: bool) -> bool {
    let state = app.state::<AppState>();
    let Some(w) = app.get_webview_window(MAIN) else { return false };
    let scale = w.scale_factor().unwrap_or(1.0);
    let size = w.inner_size().map(|s| s.to_logical::<f64>(scale)).unwrap_or(LogicalSize::new(380.0, 160.0));
    let restore_h = {
        let mut ws = state.window.lock().unwrap();
        if !ws.mini {
            return false;
        }
        if enabled {
            ws.pre_mini_lyrics_h.get_or_insert(size.height);
            None
        } else {
            Some(ws.pre_mini_lyrics_h.take().unwrap_or(160.0))
        }
    };
    match restore_h {
        None => {
            let max_h = w
                .current_monitor()
                .ok()
                .flatten()
                .map(|m| m.work_area().size.height as f64 / scale * 0.9)
                .unwrap_or(900.0);
            let _ = w.set_min_size(Some(Size::Logical(LogicalSize::new(320.0, 240.0))));
            let _ = w.set_size(Size::Logical(LogicalSize::new(size.width, size.height.max(360.0).min(max_h))));
        }
        Some(h) => {
            let _ = w.set_min_size(Some(Size::Logical(LogicalSize::new(320.0, 140.0))));
            let _ = w.set_size(Size::Logical(LogicalSize::new(size.width, h)));
        }
    }
    true
}
