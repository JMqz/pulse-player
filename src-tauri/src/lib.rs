//! Pulse native host (Tauri v2 / WebView2).
//!
//! Replaces Electron's main process: owns the window, tray, media keys, dialogs and the
//! renderer's storage, serves the UI from disk through the `pulse://` protocol and supervises the
//! Node media server (src/host/server-entry.js). The renderer talks to it through
//! src/renderer/tauri-bridge.js, which implements the same window.electronAPI the UI expects.

mod commands;
mod google;
mod media_keys;
mod paths;
mod protocol;
mod server;
mod storage;
mod tray;
mod window;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, RunEvent};

/// Host settings that must be known before the webview exists (pulse-config.json).
#[derive(Serialize, Deserialize, Default)]
#[serde(default)]
pub struct Config {
    pub proxy: String,
}

impl Config {
    fn path() -> PathBuf {
        paths::user_data().join("pulse-config.json")
    }

    fn load() -> Self {
        std::fs::read(Self::path()).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
    }

    pub fn save(&self) -> std::io::Result<()> {
        paths::write_atomic(&Self::path(), serde_json::to_string_pretty(self)?.as_bytes())
    }
}

pub struct AppState {
    pub server: Arc<server::MediaServer>,
    pub storage: Arc<storage::Storage>,
    pub config: Mutex<Config>,
    pub window: Mutex<window::WindowState>,
    pub menu_pick: Mutex<Option<Sender<String>>>,
    tray_on_close: AtomicBool,
    quitting: AtomicBool,
    shut_down: AtomicBool,
}

impl AppState {
    pub fn tray_on_close(&self) -> bool {
        self.tray_on_close.load(Ordering::Relaxed)
    }
    pub fn set_tray_on_close(&self, v: bool) {
        self.tray_on_close.store(v, Ordering::Relaxed);
    }
    pub fn is_quitting(&self) -> bool {
        self.quitting.load(Ordering::Relaxed)
    }
    pub fn begin_quit(&self) {
        self.quitting.store(true, Ordering::Relaxed);
    }
}

/// Flushes renderer storage and window bounds and stops the media server (idempotent).
pub fn shutdown(app: &AppHandle) {
    let state = app.state::<AppState>();
    if state.shut_down.swap(true, Ordering::SeqCst) {
        return;
    }
    window::save_bounds(&state.window);
    state.storage.flush();
    state.server.stop();
}

/// Electron's startup.json `multiInstance` flag (written by the Node host for the settings UI).
fn multi_instance_allowed() -> bool {
    std::fs::read(paths::media_data_dir().join("startup.json"))
        .ok()
        .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
        .and_then(|v| v.get("multiInstance").and_then(|m| m.as_bool()))
        .unwrap_or(false)
}

pub fn run() {
    let root = paths::app_root();
    let server = Arc::new(server::MediaServer::new());
    // Start Node right away so it boots while the webview initialises.
    server.start(root.clone());
    let storage = Arc::new(storage::Storage::new());

    let protocol_root = root;
    let protocol_storage = storage.clone();

    let mut builder = tauri::Builder::default();
    if !multi_instance_allowed() {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| window::show(app)));
    }

    let app = builder
        .plugin(media_keys::plugin())
        .manage(AppState {
            server,
            storage,
            config: Mutex::new(Config::load()),
            window: Mutex::default(),
            menu_pick: Mutex::default(),
            tray_on_close: AtomicBool::new(true),
            quitting: AtomicBool::new(false),
            shut_down: AtomicBool::new(false),
        })
        .register_asynchronous_uri_scheme_protocol("pulse", move |_ctx, request, responder| {
            let root = protocol_root.clone();
            let storage = protocol_storage.clone();
            tauri::async_runtime::spawn_blocking(move || {
                responder.respond(protocol::handle(&root, &storage, request));
            });
        })
        .on_menu_event(|app, event| {
            if event.id().as_ref() == commands::MENU_PLAYLIST_EXPORT {
                if let Some(tx) = app.state::<AppState>().menu_pick.lock().unwrap().take() {
                    let _ = tx.send(event.id().as_ref().to_string());
                }
            }
        })
        .setup(|app| {
            window::create(app.handle())?;
            if let Err(e) = tray::create(app.handle()) {
                eprintln!("[pulse] tray unavailable: {e}");
                app.state::<AppState>().set_tray_on_close(false);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::server_wait,
            commands::win_minimize,
            commands::win_toggle_maximize,
            commands::win_close,
            commands::win_start_drag,
            commands::set_tray_on_close,
            commands::toggle_mini_window,
            commands::set_mini_lyrics,
            commands::set_zoom,
            commands::set_media_keys,
            commands::set_app_proxy,
            commands::open_external,
            commands::open_path,
            commands::restart_app,
            commands::dialog_open,
            commands::dialog_save,
            commands::playlist_context_menu,
            google::google_login,
            google::google_logout,
        ])
        .build(tauri::generate_context!())
        .expect("failed to build the Pulse host");

    app.run(|app, event| {
        if let RunEvent::Exit = event {
            shutdown(app);
        }
    });
}
