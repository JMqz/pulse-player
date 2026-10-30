//! localStorage persistence for the renderer (Electron's storage-* / cache-* IPC).
//!
//! The renderer keeps its whole localStorage map in memory and pushes snapshots here:
//! debounced saves are flushed 250 ms after the last one, sync saves are written at once,
//! and whatever is pending is flushed when the app exits.
//!
//! storage.json holds the whole library, so every write goes through a fsynced temp file and the
//! previous version is kept as storage.json.bak. At startup an unreadable storage.json is moved
//! aside (storage.json.corrupt-<unix time>) and the backup restored, so a damaged file is never
//! read as "no data" and then overwritten with an empty library.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::paths;

const DEBOUNCE: Duration = Duration::from_millis(250);

#[derive(Default)]
struct Inner {
    latest: Option<Arc<Vec<u8>>>,
    dirty: bool,
    generation: u64,
}

pub struct Storage {
    storage_file: PathBuf,
    cache_file: PathBuf,
    inner: Arc<Mutex<Inner>>,
    /// Serializes the backup rotation + replace of storage.json across save threads.
    write_lock: Arc<Mutex<()>>,
}

impl Storage {
    pub fn new() -> Self {
        let dir = paths::user_data();
        let storage = Self {
            storage_file: dir.join("storage.json"),
            cache_file: dir.join("cache.json"),
            inner: Arc::default(),
            write_lock: Arc::default(),
        };
        storage.migrate_from_riff();
        storage.recover();
        storage
    }

    /// Restores storage.json from its backup when it is missing or not valid JSON.
    fn recover(&self) {
        let main = &self.storage_file;
        let main_ok = match std::fs::read(main) {
            Ok(bytes) => is_json_object(&bytes),
            Err(_) => false,
        };
        if main_ok {
            return;
        }
        if main.exists() {
            let stamp = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
            let _ = std::fs::rename(main, main.with_file_name(format!("storage.json.corrupt-{stamp}")));
        }
        let bak = backup_path(main);
        if let Ok(bytes) = std::fs::read(&bak) {
            if is_json_object(&bytes) {
                let _ = paths::write_atomic(main, &bytes);
            }
        }
    }

    /// First run: copy the Electron Riff library (playlists, settings) instead of starting empty.
    fn migrate_from_riff(&self) {
        let Some(legacy) = paths::legacy_riff_user_data() else { return };
        for (name, target) in [("storage.json", &self.storage_file), ("cache.json", &self.cache_file)] {
            let src = legacy.join(name);
            if !target.exists() && src.is_file() {
                if let Ok(bytes) = std::fs::read(&src) {
                    let _ = paths::write_atomic(target, &bytes);
                }
            }
        }
    }

    pub fn read_storage(&self) -> Vec<u8> {
        if let Some(latest) = self.inner.lock().unwrap().latest.clone() {
            return latest.to_vec();
        }
        for file in [self.storage_file.clone(), backup_path(&self.storage_file)] {
            if let Ok(bytes) = std::fs::read(&file) {
                if is_json_object(&bytes) {
                    return bytes;
                }
            }
        }
        b"null".to_vec()
    }

    pub fn save_storage(&self, body: Vec<u8>, debounce: bool) -> bool {
        if !is_json_object(&body) {
            return false;
        }
        let body = Arc::new(body);
        let generation = {
            let mut inner = self.inner.lock().unwrap();
            inner.latest = Some(body.clone());
            inner.generation += 1;
            inner.dirty = debounce;
            inner.generation
        };
        if !debounce {
            let _ = write_storage_file(&self.storage_file, &body, &self.write_lock);
            return true;
        }
        let inner = self.inner.clone();
        let file = self.storage_file.clone();
        let write_lock = self.write_lock.clone();
        std::thread::spawn(move || {
            std::thread::sleep(DEBOUNCE);
            let snapshot = {
                let mut guard = inner.lock().unwrap();
                if guard.generation != generation || !guard.dirty {
                    return;
                }
                guard.dirty = false;
                guard.latest.clone()
            };
            if let Some(bytes) = snapshot {
                let _ = write_storage_file(&file, &bytes, &write_lock);
            }
        });
        true
    }

    pub fn flush(&self) {
        let snapshot = {
            let mut inner = self.inner.lock().unwrap();
            if !inner.dirty {
                return;
            }
            inner.dirty = false;
            inner.latest.clone()
        };
        if let Some(bytes) = snapshot {
            let _ = write_storage_file(&self.storage_file, &bytes, &self.write_lock);
        }
    }

    pub fn read_cache(&self) -> Vec<u8> {
        match std::fs::read(&self.cache_file) {
            Ok(bytes) if is_json_object(&bytes) => bytes,
            _ => b"null".to_vec(),
        }
    }

    pub fn write_cache(&self, body: &[u8]) -> bool {
        is_json_object(body) && paths::write_atomic(&self.cache_file, body).is_ok()
    }
}

fn backup_path(file: &Path) -> PathBuf {
    file.with_file_name("storage.json.bak")
}

/// temp file (fsynced) -> current storage.json becomes .bak -> temp becomes storage.json.
/// A crash between the two renames leaves only the .bak, which `read_storage`/`recover` use.
fn write_storage_file(file: &Path, bytes: &[u8], lock: &Mutex<()>) -> std::io::Result<()> {
    let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());
    let tmp = paths::write_temp(file, bytes)?;
    if file.is_file() {
        let _ = std::fs::rename(file, backup_path(file));
    }
    std::fs::rename(&tmp, file).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })
}

/// A complete, parseable JSON object (a truncated file fails here, not just a wrong first byte).
fn is_json_object(bytes: &[u8]) -> bool {
    bytes.iter().find(|b| !b.is_ascii_whitespace()) == Some(&b'{')
        && serde_json::from_slice::<serde::de::IgnoredAny>(bytes).is_ok()
}
