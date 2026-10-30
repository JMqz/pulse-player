//! Lifecycle of the Node media server (src/host/server-entry.js -> src/server/server.js).
//!
//! The port and auth token are chosen here, before the UI loads, so the page gets them
//! synchronously through the init script. The child is put in a kill-on-close Job Object so it
//! can never outlive Pulse, and it is restarted (same port/token) if it crashes.

use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use crate::paths;

const PREFERRED_PORT: u16 = 38472;
const MAX_RESTARTS: u32 = 3;
/// A run that lasted this long counts as healthy: the restart budget starts over after it.
const STABLE_RUN: Duration = Duration::from_secs(60);

#[derive(Clone, Copy, PartialEq)]
enum Phase {
    Starting,
    Ready,
    Failed,
}

struct Shared {
    phase: Phase,
    error: String,
    child: Option<Child>,
    stopping: bool,
}

pub struct MediaServer {
    pub port: u16,
    pub token: String,
    shared: Arc<(Mutex<Shared>, Condvar)>,
}

impl MediaServer {
    pub fn new() -> Self {
        Self {
            port: pick_port(),
            token: random_token(),
            shared: Arc::new((
                Mutex::new(Shared { phase: Phase::Starting, error: String::new(), child: None, stopping: false }),
                Condvar::new(),
            )),
        }
    }

    /// Spawns the server on a supervisor thread and returns immediately.
    pub fn start(&self, root: PathBuf) {
        let shared = self.shared.clone();
        let (port, token) = (self.port, self.token.clone());
        std::thread::spawn(move || supervise(&root, port, &token, &shared));
    }

    /// Blocks until the server printed its ready line (or failed / timed out).
    pub fn wait_ready(&self, timeout: Duration) -> Result<u16, String> {
        let (lock, cvar) = &*self.shared;
        let guard = lock.lock().unwrap();
        let (guard, _) = cvar
            .wait_timeout_while(guard, timeout, |s| s.phase == Phase::Starting)
            .unwrap();
        match guard.phase {
            Phase::Ready => Ok(self.port),
            Phase::Failed => Err(guard.error.clone()),
            Phase::Starting => Err("media server did not start in time".into()),
        }
    }

    pub fn stop(&self) {
        let (lock, _) = &*self.shared;
        let mut s = lock.lock().unwrap();
        s.stopping = true;
        if let Some(mut child) = s.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

fn supervise(root: &Path, port: u16, token: &str, shared: &Arc<(Mutex<Shared>, Condvar)>) {
    let (lock, cvar) = &**shared;
    let fail = |msg: String| {
        let mut s = lock.lock().unwrap();
        s.phase = Phase::Failed;
        s.error = msg;
        cvar.notify_all();
    };
    let Some((runtime, electron)) = resolve_runtime(root) else {
        return fail("no JavaScript runtime found (runtime\\node.exe, node on PATH or Riff.exe)".into());
    };
    let entry = root.join("src").join("host").join("server-entry.js");
    let log_dir = paths::user_data().join("logs");
    let _ = std::fs::create_dir_all(&log_dir);
    let log_path = log_dir.join("server.log");

    // Bundled/managed tool folders go first on the server's PATH so yt-dlp also finds ffmpeg.
    let tool_path = {
        let mut dirs = paths::tool_dirs(root);
        if let Some(p) = std::env::var_os("PATH") {
            dirs.extend(std::env::split_paths(&p));
        }
        std::env::join_paths(dirs).unwrap_or_default()
    };

    let mut restarts: u32 = 0;
    for attempt in 0u32.. {
        let mut cmd = Command::new(&runtime);
        if !electron {
            cmd.arg("--max-old-space-size=96");
        }
        cmd.arg(&entry)
            .current_dir(root)
            .env("PULSE_PORT", port.to_string())
            .env("PULSE_SERVER_TOKEN", token)
            .env("PULSE_USER_DATA", paths::user_data())
            .env("PULSE_PARENT_PID", std::process::id().to_string())
            .env("PULSE_ROOT", root)
            .env("PULSE_BIN_DIR", paths::pulse_bin_dir())
            .env("PATH", &tool_path)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if electron {
            cmd.env("ELECTRON_RUN_AS_NODE", "1");
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => return fail(format!("failed to spawn {}: {e}", runtime.display())),
        };
        job::assign(&child);
        let started = Instant::now();

        let log = Arc::new(Mutex::new(
            std::fs::OpenOptions::new().create(true).append(true).open(&log_path).ok(),
        ));
        let write_log = {
            let log = log.clone();
            move |line: &str| {
                if let Some(f) = log.lock().unwrap().as_mut() {
                    let _ = writeln!(f, "{line}");
                }
            }
        };
        write_log(&format!("--- start #{attempt} {} (port {port})", runtime.display()));
        if let Some(err) = child.stderr.take() {
            let write_log = write_log.clone();
            std::thread::spawn(move || {
                for line in BufReader::new(err).lines().map_while(Result::ok) {
                    write_log(&line);
                }
            });
        }
        let stdout = child.stdout.take();
        {
            let mut s = lock.lock().unwrap();
            if s.stopping {
                let _ = child.kill();
                return;
            }
            s.child = Some(child);
        }
        if let Some(out) = stdout {
            for line in BufReader::new(out).lines().map_while(Result::ok) {
                if line.starts_with("PULSE_READY") {
                    let mut s = lock.lock().unwrap();
                    s.phase = Phase::Ready;
                    cvar.notify_all();
                }
                write_log(&line);
            }
        }
        // stdout closed: the process exited.
        let mut s = lock.lock().unwrap();
        if let Some(mut c) = s.child.take() {
            let _ = c.wait();
        }
        if s.stopping {
            return;
        }
        write_log("--- media server exited");
        if started.elapsed() >= STABLE_RUN {
            restarts = 0;
        }
        if restarts >= MAX_RESTARTS {
            break;
        }
        restarts += 1;
        if s.phase == Phase::Ready {
            s.phase = Phase::Starting;
        }
        drop(s);
        std::thread::sleep(Duration::from_millis(500));
    }
    fail("media server keeps exiting; see %APPDATA%\\Pulse\\logs\\server.log".into());
}

/// JS runtime for the media server, most specific first:
/// PULSE_NODE, <root>\runtime\node.exe, node.exe on PATH, the installed Riff.exe (as Node).
/// The bool says whether the runtime is an Electron binary that needs ELECTRON_RUN_AS_NODE.
fn resolve_runtime(root: &Path) -> Option<(PathBuf, bool)> {
    let is_electron = |p: &Path| {
        p.file_name().map(|n| !n.eq_ignore_ascii_case("node.exe")).unwrap_or(false)
    };
    if let Some(p) = std::env::var_os("PULSE_NODE").map(PathBuf::from).filter(|p| p.is_file()) {
        let e = is_electron(&p);
        return Some((p, e));
    }
    let bundled = root.join("runtime").join("node.exe");
    if bundled.is_file() {
        return Some((bundled, false));
    }
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            let candidate = dir.join("node.exe");
            if candidate.is_file() {
                return Some((candidate, false));
            }
        }
    }
    let riff = std::env::var_os("LOCALAPPDATA")
        .map(|l| PathBuf::from(l).join("Programs").join("riff").join("Riff.exe"))
        .filter(|p| p.is_file())?;
    Some((riff, true))
}

fn pick_port() -> u16 {
    if TcpListener::bind(("127.0.0.1", PREFERRED_PORT)).is_ok() {
        return PREFERRED_PORT;
    }
    TcpListener::bind(("127.0.0.1", 0))
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .unwrap_or(PREFERRED_PORT)
}

/// 24 random bytes as 48 hex chars (the format server.js accepts from PULSE_SERVER_TOKEN).
fn random_token() -> String {
    let mut bytes = [0u8; 24];
    getrandom::getrandom(&mut bytes).expect("OS random generator unavailable");
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(windows)]
mod job {
    use std::os::windows::io::AsRawHandle;
    use std::process::Child;
    use std::sync::OnceLock;

    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    struct Job(HANDLE);
    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}

    /// One job for the life of the process; its handle closes when Pulse exits, killing the children.
    fn job() -> Option<HANDLE> {
        static JOB: OnceLock<Option<Job>> = OnceLock::new();
        JOB.get_or_init(|| unsafe {
            let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if handle.is_null() {
                return None;
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const _,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            Some(Job(handle))
        })
        .as_ref()
        .map(|j| j.0)
    }

    pub fn assign(child: &Child) {
        if let Some(job) = job() {
            unsafe {
                AssignProcessToJobObject(job, child.as_raw_handle() as HANDLE);
            }
        }
    }
}

#[cfg(not(windows))]
mod job {
    pub fn assign(_child: &std::process::Child) {}
}
