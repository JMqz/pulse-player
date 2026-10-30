//! System tray: left click toggles the window; menu = Show/Hide, Play/Pause, Quit.

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};

use crate::{window, AppState};

pub fn create(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "tray-toggle", "Show/Hide", true, None::<&str>)?;
    let play = MenuItem::with_id(app, "tray-play", "Play/Pause", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "tray-quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &play, &sep, &quit])?;

    let mut builder = TrayIconBuilder::with_id("pulse")
        .tooltip("Pulse")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "tray-toggle" => window::toggle(app),
            "tray-play" => window::emit(app, "media-command", serde_json::Value::String("toggle".into())),
            "tray-quit" => {
                app.state::<AppState>().begin_quit();
                crate::shutdown(app);
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                window::toggle(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}
