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

/// Media data folder shared with the Node server (src/shared/platform.js DEFAULT_DATA_DIR).
pub fn media_data_dir() -> PathBuf {
    let base = std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
    base.join("Riff")
}

/// Pulse-managed tools folder (yt-dlp/ffmpeg auto-downloaded on first run when nothing is bundled).
pub fn pulse_bin_dir() -> PathBuf {
    let base = std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
    base.join("Pulse").join("bin")
}

/// Folders searched for yt-dlp.exe / ffmpeg.exe / ffprobe.exe, in priority order:
/// `<root>\bin` (shipped with the installer), `%LOCALAPPDATA%\Pulse\bin`, `%LOCALAPPDATA%\Riff\bin`.
pub fn tool_dirs(root: &Path) -> Vec<PathBuf> {
    vec![root.join("bin"), pulse_bin_dir(), media_data_dir().join("bin")]
}

/// Writes `bytes` to `path` through a temp file + rename so readers never see a torn file.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path)
}
