//! Filesystem layout used by the Pulse host.

use std::path::{Path, PathBuf};

/// Root of the Pulse checkout (contains `src\renderer\index.html` and `assets\`).
/// `PULSE_ROOT` wins; otherwise walk up from the executable (dist\Pulse.exe, src-tauri\target\*\Pulse.exe).
pub fn app_root() -> PathBuf {
    if let Some(root) = std::env::var_os("PULSE_ROOT").map(PathBuf::from) {
        if is_root(&root) {
            return root;
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        for dir in exe.ancestors().skip(1).take(5) {
            if is_root(dir) {
                return dir.to_path_buf();
            }
        }
    }
    std::env::current_dir().unwrap_or_default()
}

fn is_root(dir: &Path) -> bool {
    dir.join("src").join("renderer").join("index.html").is_file()
}

/// Per-user host state: storage.json, cache.json, window-state.json, logs, local covers.
pub fn user_data() -> PathBuf {
    let base = std::env::var_os("APPDATA").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
    base.join("Pulse")
}

/// Electron Riff's userData folder, used once to migrate the existing library into Pulse.
pub fn legacy_riff_user_data() -> Option<PathBuf> {
    std::env::var_os("APPDATA").map(|a| PathBuf::from(a).join("riff"))
}

fn local_app_data() -> PathBuf {
    std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(std::env::temp_dir)
}

/// Media data folder shared with the Node server (src/shared/platform.js DEFAULT_DATA_DIR):
/// `%LOCALAPPDATA%\Pulse`.
pub fn media_data_dir() -> PathBuf {
    local_app_data().join("Pulse")
}

/// Electron Riff's media folder (`%LOCALAPPDATA%\Riff`): migrated once, then only searched for tools.
pub fn legacy_media_data_dir() -> PathBuf {
    local_app_data().join("Riff")
}

/// Pulse-managed tools folder (yt-dlp/ffmpeg auto-downloaded on first run when nothing is bundled).
pub fn pulse_bin_dir() -> PathBuf {
    media_data_dir().join("bin")
}

/// Folders searched for yt-dlp.exe / ffmpeg.exe / ffprobe.exe, in priority order:
/// `<root>\bin` (shipped with the installer), `%LOCALAPPDATA%\Pulse\bin`, `%LOCALAPPDATA%\Riff\bin`.
pub fn tool_dirs(root: &Path) -> Vec<PathBuf> {
    vec![root.join("bin"), pulse_bin_dir(), legacy_media_data_dir().join("bin")]
}

/// Written once the legacy Riff folder has been merged into `%LOCALAPPDATA%\Pulse`
/// (src/shared/platform.js checks the same marker).
const MIGRATION_MARKER: &str = ".migrated-from-riff";
/// Not migrated: tools stay where they are (still searched, see `tool_dirs`) and old logs are noise.
const MIGRATION_SKIP: &[&str] = &["bin", "logs", "plugins", MIGRATION_MARKER];
/// Files above this size (cached audio, downloads) are hard-linked instead of copied: instant, no
/// extra disk space, and the Riff copy stays untouched because media files are never edited in place.
const LINK_THRESHOLD: u64 = 1024 * 1024;

/// One-time, non-destructive migration of `%LOCALAPPDATA%\Riff` into `%LOCALAPPDATA%\Pulse`.
/// Files already present in Pulse are never overwritten and the Riff folder is left as it was.
/// Runs before the Node server starts; the marker is only written when every file made it, so an
/// interrupted run simply resumes next launch.
pub fn migrate_legacy_media_data() {
    let from = legacy_media_data_dir();
    let to = media_data_dir();
    if to.join(MIGRATION_MARKER).exists() {
        return;
    }
    if from.is_dir() && std::fs::create_dir_all(&to).is_ok() && !merge_dir(&from, &to, true) {
        return;
    }
    let _ = std::fs::write(to.join(MIGRATION_MARKER), b"1");
}

fn merge_dir(from: &Path, to: &Path, top: bool) -> bool {
    let Ok(entries) = std::fs::read_dir(from) else { return false };
    let mut ok = true;
    for entry in entries.flatten() {
        let name = entry.file_name();
        if top && name.to_str().is_some_and(|n| MIGRATION_SKIP.iter().any(|s| s.eq_ignore_ascii_case(n))) {
            continue;
        }
        let (src, dst) = (entry.path(), to.join(&name));
        let Ok(ft) = entry.file_type() else { ok = false; continue };
        if ft.is_dir() {
            ok &= std::fs::create_dir_all(&dst).is_ok() && merge_dir(&src, &dst, false);
        } else if ft.is_file() && !dst.exists() {
            let big = entry.metadata().map(|m| m.len() > LINK_THRESHOLD).unwrap_or(false);
            let linked = big && std::fs::hard_link(&src, &dst).is_ok();
            ok &= linked || std::fs::copy(&src, &dst).is_ok();
        }
    }
    ok
}

/// Writes `bytes` to `path` through a temp file + rename so readers never see a torn file.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = write_temp(path, bytes)?;
    std::fs::rename(&tmp, path).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })
}

/// Writes `bytes` to a uniquely named, fsynced sibling of `path` and returns its path, so
/// concurrent writers never share a temp file and a crash never leaves a half-written target.
pub fn write_temp(path: &Path, bytes: &[u8]) -> std::io::Result<PathBuf> {
    use std::io::Write;
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(0);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("file");
    let tmp = path.with_file_name(format!(
        "{name}.{}.{}.tmp",
        std::process::id(),
        SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()
    })();
    match result {
        Ok(()) => Ok(tmp),
        Err(e) => {
            let _ = std::fs::remove_file(&tmp);
            Err(e)
        }
    }
}
