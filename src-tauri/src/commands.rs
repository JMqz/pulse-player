//! Commands invoked by src/renderer/tauri-bridge.js (the native half of Electron's ipcMain).

use std::path::PathBuf;
use std::time::Duration;

use serde::Deserialize;
use tauri::menu::{Menu, MenuItem};
use tauri::{AppHandle, Manager, State, WebviewWindow};

use crate::{media_keys, window, AppState};

#[tauri::command]
pub async fn server_wait(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let server = state.server.clone();
    let port = tauri::async_runtime::spawn_blocking(move || server.wait_ready(Duration::from_secs(25)))
        .await
        .map_err(|e| e.to_string())??;
    Ok(serde_json::json!({ "port": port }))
}

#[tauri::command]
pub fn win_minimize(w: WebviewWindow) {
    let _ = w.minimize();
}

#[tauri::command]
pub fn win_toggle_maximize(w: WebviewWindow) {
    if w.is_maximized().unwrap_or(false) {
        let _ = w.unmaximize();
    } else {
        let _ = w.maximize();
    }
}

#[tauri::command]
pub fn win_close(w: WebviewWindow) {
    // Goes through CloseRequested, which hides to the tray when that is enabled.
    let _ = w.close();
}

#[tauri::command]
pub fn win_start_drag(w: WebviewWindow) {
    let _ = w.start_dragging();
}

#[tauri::command]
pub fn set_tray_on_close(state: State<'_, AppState>, enabled: bool) {
    state.set_tray_on_close(enabled);
}

#[tauri::command]
pub fn toggle_mini_window(app: AppHandle) -> bool {
    window::toggle_mini(&app)
}

#[tauri::command]
pub fn set_mini_lyrics(app: AppHandle, enabled: bool) -> bool {
    window::set_mini_lyrics(&app, enabled)
}

#[tauri::command]
pub fn set_player_idle(app: AppHandle, idle: bool) {
    window::set_page_idle(&app, idle);
}

#[tauri::command]
pub fn set_zoom(w: WebviewWindow, factor: f64) {
    if factor.is_finite() && (0.25..=5.0).contains(&factor) {
        let _ = w.set_zoom(factor);
    }
}

#[tauri::command]
pub fn set_media_keys(app: AppHandle, enabled: bool) {
    media_keys::set_enabled(&app, enabled);
}

/// WebView2 takes its proxy at creation time, so the setting is stored and applied on next launch.
#[tauri::command]
pub fn set_app_proxy(state: State<'_, AppState>, proxy: String) -> serde_json::Value {
    let mut config = state.config.lock().unwrap();
    config.proxy = proxy.trim().to_string();
    match config.save() {
        Ok(()) => serde_json::json!({ "success": true, "restartRequired": true }),
        Err(e) => serde_json::json!({ "success": false, "error": e.to_string() }),
    }
}

/// Same allow-list Electron used for shell.openExternal.
#[tauri::command]
pub fn open_external(url: String) {
    let allowed = ["https://accounts.spotify.com/", "https://last.fm/", "https://www.last.fm/", "https://github.com/"];
    let lower = url.to_ascii_lowercase();
    if allowed.iter().any(|p| lower.starts_with(p)) && !url.contains(char::is_whitespace) {
        shell_open(&url);
    }
}

#[tauri::command]
pub fn open_path(path: String) {
    if PathBuf::from(&path).is_dir() {
        shell_open(&path);
    }
}

#[tauri::command]
pub fn restart_app(app: AppHandle) {
    crate::shutdown(&app);
    app.restart();
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct DialogOptions {
    title: Option<String>,
    multiple: bool,
    directory: bool,
    filters: Vec<DialogFilter>,
    default_path: Option<String>,
    default_name: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub struct DialogFilter {
    name: String,
    extensions: Vec<String>,
}

fn file_dialog(w: &WebviewWindow, opts: &DialogOptions) -> rfd::FileDialog {
    let mut d = rfd::FileDialog::new().set_parent(w);
    if let Some(t) = &opts.title {
        d = d.set_title(t);
    }
    if let Some(p) = &opts.default_path {
        d = d.set_directory(p);
    }
    if let Some(n) = &opts.default_name {
        d = d.set_file_name(n);
    }
    for f in &opts.filters {
        d = d.add_filter(&f.name, &f.extensions);
    }
    d
}

fn to_strings(paths: Vec<PathBuf>) -> Vec<String> {
    paths.into_iter().map(|p| p.to_string_lossy().into_owned()).collect()
}

#[tauri::command]
pub async fn dialog_open(w: WebviewWindow, opts: DialogOptions) -> Result<Option<Vec<String>>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let d = file_dialog(&w, &opts);
        let picked = match (opts.directory, opts.multiple) {
            (true, true) => d.pick_folders(),
            (true, false) => d.pick_folder().map(|p| vec![p]),
            (false, true) => d.pick_files(),
            (false, false) => d.pick_file().map(|p| vec![p]),
        };
        picked.map(to_strings)
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn dialog_save(w: WebviewWindow, opts: DialogOptions) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        file_dialog(&w, &opts).save_file().map(|p| p.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| e.to_string())
}

pub const MENU_PLAYLIST_EXPORT: &str = "pl-export";

/// Native "Export as JSON" context menu; resolves with "export" or null when dismissed.
#[tauri::command]
pub async fn playlist_context_menu(app: AppHandle, w: WebviewWindow) -> Result<Option<String>, String> {
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    *app.state::<AppState>().menu_pick.lock().unwrap() = Some(tx);
    let item = MenuItem::with_id(&app, MENU_PLAYLIST_EXPORT, "Export as JSON", true, None::<&str>).map_err(|e| e.to_string())?;
    let menu = Menu::with_items(&app, &[&item]).map_err(|e| e.to_string())?;
    w.popup_menu(&menu).map_err(|e| e.to_string())?;
    // The popup is modal on Windows; a pick arrives through the app menu-event handler.
    let picked = tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(Duration::from_secs(120)).ok())
        .await
        .map_err(|e| e.to_string())?;
    Ok(picked.filter(|id| id == MENU_PLAYLIST_EXPORT).map(|_| "export".to_string()))
}

#[cfg(windows)]
fn shell_open(target: &str) {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
    let wide = |s: &str| std::ffi::OsStr::new(s).encode_wide().chain(Some(0)).collect::<Vec<u16>>();
    let (verb, file) = (wide("open"), wide(target));
    unsafe {
        ShellExecuteW(std::ptr::null_mut(), verb.as_ptr(), file.as_ptr(), std::ptr::null(), std::ptr::null(), SW_SHOWNORMAL);
    }
}

#[cfg(not(windows))]
fn shell_open(target: &str) {
    let _ = std::process::Command::new("xdg-open").arg(target).spawn();
}
