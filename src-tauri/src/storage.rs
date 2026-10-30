//! localStorage persistence for the renderer (Electron's storage-* / cache-* IPC).
//!
//! The renderer keeps its whole localStorage map in memory and pushes snapshots here:
//! debounced saves are flushed 250 ms after the last one, sync saves are written at once,
//! and whatever is pending is flushed when the app exits.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

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
}

impl Storage {
    pub fn new() -> Self {
        let dir = paths::user_data();
        let storage = Self {
            storage_file: dir.join("storage.json"),
            cache_file: dir.join("cache.json"),
            inner: Arc::default(),
        };
        storage.migrate_from_riff();
        storage
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
        match std::fs::read(&self.storage_file) {
            Ok(bytes) if is_json_object(&bytes) => bytes,
            _ => b"null".to_vec(),
        }
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
            let _ = paths::write_atomic(&self.storage_file, &body);
            return true;
        }
        let inner = self.inner.clone();
        let file = self.storage_file.clone();
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
                let _ = paths::write_atomic(&file, &bytes);
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
            let _ = paths::write_atomic(&self.storage_file, &bytes);
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

fn is_json_object(bytes: &[u8]) -> bool {
    bytes.iter().find(|b| !b.is_ascii_whitespace()) == Some(&b'{')
}
