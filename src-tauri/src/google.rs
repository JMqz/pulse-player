//! In-app YouTube sign-in.
//!
//! yt-dlp's `--cookies-from-browser` can no longer read Chromium cookies on Windows (app-bound
//! encryption), so Pulse signs in inside its own WebView2 window instead and writes the session
//! as a Netscape cookie file (`%LOCALAPPDATA%\Pulse\yt-cookies.txt`, only the YouTube auth cookies), the file the Node server and
//! yt-dlp already use.
//!
//! The login window uses its own WebView2 profile (`%APPDATA%\Pulse\google-login`): it runs
//! without the main window's `--disable-web-security`, and the session it keeps lets a later
//! sign-in (or a refresh after the cookie file was removed) finish without typing anything.

use std::time::{Duration, Instant};

use tauri::webview::Cookie;
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::paths;

const LABEL: &str = "google-login";
const LOGIN_URL: &str =
    "https://accounts.google.com/ServiceLogin?service=youtube&continue=https%3A%2F%2Fwww.youtube.com%2F";
/// Cookies that only exist for a signed-in session.
const AUTH_COOKIES: &[&str] = &["SAPISID", "__Secure-3PAPISID", "__Secure-1PAPISID", "LOGIN_INFO"];
/// The only cookies written to yt-cookies.txt: what YouTube/yt-dlp need to authenticate (plus the
/// `*PSIDTS`/`*SIDCC` companions Google rotates with them). Everything else the Google account sets
/// for its other services stays in the sign-in profile.
const EXPORT_COOKIES: &[&str] = &[
    "LOGIN_INFO", "SAPISID", "APISID", "HSID", "SSID", "SID",
    "__Secure-1PSID", "__Secure-3PSID", "__Secure-1PAPISID", "__Secure-3PAPISID",
    "__Secure-1PSIDTS", "__Secure-3PSIDTS", "__Secure-1PSIDCC", "__Secure-3PSIDCC", "SIDCC",
    "PREF", "YSC", "VISITOR_INFO1_LIVE", "VISITOR_PRIVACY_METADATA",
];
const TIMEOUT: Duration = Duration::from_secs(10 * 60);
/// An existing session usually lands on youtube.com within this time; only then show the window.
const SILENT_GRACE: Duration = Duration::from_secs(4);

fn profile_dir() -> std::path::PathBuf {
    paths::user_data().join("google-login")
}

fn cookies_file() -> std::path::PathBuf {
    paths::media_data_dir().join("yt-cookies.txt")
}

fn logout_flag() -> std::path::PathBuf {
    paths::media_data_dir().join(".yt-logged-out")
}

/// Google sign-in hops across google.<tld>, youtube.com and their static/content hosts.
fn allowed_host(url: &Url) -> bool {
    if url.scheme() != "https" {
        return url.scheme() == "about" || url.scheme() == "data" || url.scheme() == "blob";
    }
    let host = url.host_str().unwrap_or("").to_ascii_lowercase();
    host.split('.').any(|label| matches!(label, "google" | "youtube" | "gstatic" | "googleusercontent" | "ggpht" | "googleapis"))
}

fn is_signed_in(cookies: &[Cookie<'static>]) -> bool {
    cookies.iter().any(|c| AUTH_COOKIES.contains(&c.name()) && !c.value().is_empty())
}

fn exportable(domain: &str, name: &str) -> bool {
    let domain = domain.trim_start_matches('.').to_ascii_lowercase();
    let on_youtube = ["youtube.com", "google.com"]
        .iter()
        .any(|d| domain == *d || domain.ends_with(&format!(".{d}")));
    on_youtube && EXPORT_COOKIES.contains(&name)
}

/// Drops anything outside `EXPORT_COOKIES` from a cookie file written by an older Pulse/Riff,
/// so upgrading does not keep the whole Google account jar on disk until the next sign-in.
pub fn scrub_cookie_file() {
    let path = cookies_file();
    let Ok(text) = std::fs::read_to_string(&path) else { return };
    let mut changed = false;
    let kept: Vec<&str> = text
        .lines()
        .filter(|line| {
            let raw = line.strip_prefix("#HttpOnly_").unwrap_or(line);
            if raw.trim().is_empty() || raw.starts_with('#') {
                return true;
            }
            let f: Vec<&str> = raw.split('\t').collect();
            let keep = f.len() >= 7 && exportable(f[0], f[5]);
            changed |= !keep;
            keep
        })
        .collect();
    if changed {
        let _ = paths::write_atomic(&path, (kept.join("\n") + "\n").as_bytes());
    }
}

/// Netscape cookie file (what yt-dlp's --cookies and src/host/host-routes.js read).
fn netscape(cookies: &[Cookie<'static>]) -> String {
    let mut out = String::from("# Netscape HTTP Cookie File\n# Written by Pulse (in-app YouTube sign-in).\n\n");
    for c in cookies {
        let domain = c.domain().unwrap_or("").trim_start_matches('.').to_ascii_lowercase();
        if !exportable(&domain, c.name()) || c.value().contains(['\t', '\n']) {
            continue;
        }
        // `__Host-` cookies must stay host-only; everything else Google sets is a domain cookie.
        let host_only = c.name().starts_with("__Host-");
        let domain_field = if host_only { domain.clone() } else { format!(".{domain}") };
        let expires = c
            .expires()
            .and_then(|e| e.datetime())
            .map(|d| d.unix_timestamp().max(0))
            .unwrap_or(0);
        out.push_str(&format!(
            "{}{}\t{}\t{}\t{}\t{}\t{}\t{}\n",
            if c.http_only().unwrap_or(false) { "#HttpOnly_" } else { "" },
            domain_field,
            if host_only { "FALSE" } else { "TRUE" },
            c.path().unwrap_or("/"),
            if c.secure().unwrap_or(false) { "TRUE" } else { "FALSE" },
            expires,
            c.name(),
            c.value()
        ));
    }
    out
}

/// Reads the window's cookies (off the main thread: WebView2 cookie calls deadlock on it).
fn read_cookies(w: &WebviewWindow) -> Option<Vec<Cookie<'static>>> {
    w.cookies().ok()
}

fn finish(w: &WebviewWindow, cookies: &[Cookie<'static>]) -> Result<(), String> {
    paths::write_atomic(&cookies_file(), netscape(cookies).as_bytes()).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(logout_flag());
    let _ = w.close();
    Ok(())
}

/// Opens (or focuses) the sign-in window and resolves once the session cookies were exported,
/// or with `loggedIn: false` when the user closes the window / it times out.
#[tauri::command]
pub async fn google_login(app: AppHandle) -> Result<serde_json::Value, String> {
    if let Some(existing) = app.get_webview_window(LABEL) {
        let _ = existing.show();
        let _ = existing.set_focus();
        return Ok(serde_json::json!({ "success": false, "loggedIn": false, "error": "sign-in already in progress" }));
    }
    let window = WebviewWindowBuilder::new(&app, LABEL, WebviewUrl::External(LOGIN_URL.parse().unwrap()))
        .title("Pulse — Entrar no YouTube")
        .inner_size(480.0, 720.0)
        .center()
        .visible(false)
        .data_directory(profile_dir())
        .additional_browser_args("--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --disable-sync")
        .on_navigation(allowed_host)
        .build()
        .map_err(|e| e.to_string())?;

    let w = window.clone();
    let result: Result<bool, String> = tauri::async_runtime::spawn_blocking(move || {
        let started = Instant::now();
        let mut shown = false;
        loop {
            std::thread::sleep(Duration::from_millis(700));
            // The window is gone once the user closed it.
            let Some(win) = w.app_handle().get_webview_window(LABEL) else {
                return Ok(false);
            };
            let on_youtube = win.url().ok().and_then(|u| u.host_str().map(|h| h.ends_with("youtube.com"))).unwrap_or(false);
            if on_youtube {
                if let Some(cookies) = read_cookies(&win) {
                    if is_signed_in(&cookies) {
                        finish(&win, &cookies)?;
                        return Ok(true);
                    }
                }
            }
            if !shown && started.elapsed() >= SILENT_GRACE {
                shown = true;
                let _ = win.show();
                let _ = win.set_focus();
            }
            if started.elapsed() >= TIMEOUT {
                let _ = win.close();
                return Ok(false);
            }
        }
    })
    .await
    .map_err(|e| e.to_string())?;

    match result {
        Ok(logged_in) => Ok(serde_json::json!({ "success": logged_in, "loggedIn": logged_in })),
        Err(e) => {
            let _ = window.close();
            Ok(serde_json::json!({ "success": false, "loggedIn": false, "error": e }))
        }
    }
}

/// Forgets the in-app session so the next sign-in starts fresh (the Node side removes the cookie
/// file and sets its logged-out flag).
#[tauri::command]
pub async fn google_logout(app: AppHandle) -> bool {
    if let Some(w) = app.get_webview_window(LABEL) {
        let _ = w.close();
    }
    tauri::async_runtime::spawn_blocking(|| {
        // WebView2 may still hold the profile briefly after its window closed.
        for _ in 0..10 {
            if std::fs::remove_dir_all(profile_dir()).is_ok() || !profile_dir().exists() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(300));
        }
        false
    })
    .await
    .unwrap_or(false)
}
