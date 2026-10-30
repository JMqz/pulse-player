//! Global media keys (Electron's globalShortcut MediaPlayPause / MediaNextTrack / ...).
//! Registered only once the page reports playback started and the user setting allows it,
//! so Pulse does not grab the keys from other players while idle.

use tauri::AppHandle;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

use crate::window;

const KEYS: [(Code, &str); 4] = [
    (Code::MediaPlayPause, "toggle"),
    (Code::MediaTrackNext, "next"),
    (Code::MediaTrackPrevious, "prev"),
    (Code::MediaStop, "stop"),
];

pub fn plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, shortcut, event| {
            if event.state() != ShortcutState::Pressed {
                return;
            }
            if let Some((_, cmd)) = KEYS.iter().find(|(code, _)| shortcut.matches(Modifiers::empty(), *code)) {
                window::emit(app, "media-command", serde_json::Value::String((*cmd).into()));
            }
        })
        .build()
}

pub fn set_enabled(app: &AppHandle, enabled: bool) {
    let gs = app.global_shortcut();
    for (code, _) in KEYS {
        let shortcut = Shortcut::new(None, code);
        let registered = gs.is_registered(shortcut);
        if enabled && !registered {
            let _ = gs.register(shortcut);
        } else if !enabled && registered {
            let _ = gs.unregister(shortcut);
        }
    }
}
