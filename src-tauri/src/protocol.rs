//! `pulse://` protocol (served as http://pulse.localhost on Windows).
//!
//!   /src/renderer/**, /assets/**   UI files read from disk at request time (no rebuild for UI edits)
//!   /__pulse/storage               GET snapshot / POST save (`?debounce=1` for batched saves)
//!   /__pulse/cache                 GET / POST cache.json
//!   /__pulse/file?p=<abs path>     local audio / image / video with Range support

use std::io::{Read, Seek, SeekFrom};
use std::path::{Component, Path, PathBuf};

use tauri::http::{header, Request, Response, StatusCode};

use crate::storage::Storage;

/// Largest slice returned for one Range request; the media element asks again for the rest.
const MAX_RANGE: u64 = 4 * 1024 * 1024;

pub fn handle(root: &Path, storage: &Storage, req: Request<Vec<u8>>) -> Response<Vec<u8>> {
    let path = percent_decode(req.uri().path());
    let query = req.uri().query().unwrap_or("").to_string();
    let is_post = req.method() == tauri::http::Method::POST;
    match path.as_str() {
        "/__pulse/storage" if is_post => {
            let debounce = query.split('&').any(|kv| kv == "debounce=1");
            let ok = storage.save_storage(req.into_body(), debounce);
            json(if ok { b"true".to_vec() } else { b"false".to_vec() })
        }
        "/__pulse/storage" => json(storage.read_storage()),
        "/__pulse/cache" if is_post => json(if storage.write_cache(req.body()) { b"true".to_vec() } else { b"false".to_vec() }),
        "/__pulse/cache" => json(storage.read_cache()),
        "/__pulse/file" => {
            let file = query_param(&query, "p").map(PathBuf::from);
            let range = req.headers().get(header::RANGE).and_then(|v| v.to_str().ok()).map(str::to_string);
            match file {
                Some(f) if f.is_absolute() && media_mime(&f).is_some() => serve_file(&f, range.as_deref(), true),
                _ => status(StatusCode::FORBIDDEN),
            }
        }
        "/" | "" => redirect("/src/renderer/index.html"),
        p => match resolve_ui_path(root, p) {
            Some(f) => serve_file(&f, None, false),
            None => status(StatusCode::NOT_FOUND),
        },
    }
}

/// Maps a request path to a file under src/renderer or assets, refusing anything else.
fn resolve_ui_path(root: &Path, request_path: &str) -> Option<PathBuf> {
    let rel = Path::new(request_path.trim_start_matches('/'));
    if rel.components().any(|c| !matches!(c, Component::Normal(_))) {
        return None;
    }
    let allowed = rel.starts_with("src/renderer") || rel.starts_with("assets");
    let full = root.join(rel);
    (allowed && full.is_file()).then_some(full)
}

fn serve_file(path: &Path, range: Option<&str>, media: bool) -> Response<Vec<u8>> {
    let Ok(mut file) = std::fs::File::open(path) else { return status(StatusCode::NOT_FOUND) };
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    let mime = media_mime(path).or_else(|| ui_mime(path)).unwrap_or("application/octet-stream");

    if let Some((start, end)) = range.and_then(|r| parse_range(r, len)) {
        let end = end.min(start + MAX_RANGE - 1);
        let mut buf = vec![0u8; (end - start + 1) as usize];
        if file.seek(SeekFrom::Start(start)).and_then(|_| file.read_exact(&mut buf)).is_err() {
            return status(StatusCode::RANGE_NOT_SATISFIABLE);
        }
        return Response::builder()
            .status(StatusCode::PARTIAL_CONTENT)
            .header(header::CONTENT_TYPE, mime)
            .header(header::ACCEPT_RANGES, "bytes")
            .header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{len}"))
            .header(header::CACHE_CONTROL, "no-cache")
            .body(buf)
            .unwrap();
    }

    let mut buf = Vec::with_capacity(len as usize);
    if file.read_to_end(&mut buf).is_err() {
        return status(StatusCode::INTERNAL_SERVER_ERROR);
    }
    let mut res = Response::builder()
        .header(header::CONTENT_TYPE, mime)
        .header(header::CACHE_CONTROL, "no-cache");
    if media {
        res = res.header(header::ACCEPT_RANGES, "bytes");
    }
    res.body(buf).unwrap()
}

fn parse_range(value: &str, len: u64) -> Option<(u64, u64)> {
    let spec = value.strip_prefix("bytes=")?.split(',').next()?.trim();
    let (a, b) = spec.split_once('-')?;
    if len == 0 {
        return None;
    }
    let (start, end) = match (a.parse::<u64>().ok(), b.parse::<u64>().ok()) {
        (Some(s), Some(e)) => (s, e.min(len - 1)),
        (Some(s), None) => (s, len - 1),
        (None, Some(suffix)) => (len.saturating_sub(suffix), len - 1),
        (None, None) => return None,
    };
    (start <= end && start < len).then_some((start, end))
}

fn media_mime(path: &Path) -> Option<&'static str> {
    Some(match ext(path).as_str() {
        "mp3" => "audio/mpeg",
        "flac" => "audio/flac",
        "wav" => "audio/wav",
        "ogg" | "oga" | "opus" => "audio/ogg",
        "m4a" => "audio/mp4",
        "aac" => "audio/aac",
        "wma" => "audio/x-ms-wma",
        "webm" | "weba" => "audio/webm",
        "mp4" => "video/mp4",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        _ => return None,
    })
}

fn ui_mime(path: &Path) -> Option<&'static str> {
    Some(match ext(path).as_str() {
        "html" => "text/html; charset=utf-8",
        "js" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "svg" => "image/svg+xml",
        "json" => "application/json",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        _ => return None,
    })
}

fn ext(path: &Path) -> String {
    path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase()
}

fn query_param(query: &str, key: &str) -> Option<String> {
    query.split('&').find_map(|kv| {
        let (k, v) = kv.split_once('=')?;
        (k == key).then(|| percent_decode(&v.replace('+', " ")))
    })
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok();
            if let Some(v) = hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn json(body: Vec<u8>) -> Response<Vec<u8>> {
    Response::builder()
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::CACHE_CONTROL, "no-store")
        .body(body)
        .unwrap()
}

fn status(code: StatusCode) -> Response<Vec<u8>> {
    Response::builder().status(code).body(Vec::new()).unwrap()
}

fn redirect(location: &str) -> Response<Vec<u8>> {
    Response::builder()
        .status(StatusCode::FOUND)
        .header(header::LOCATION, location)
        .body(Vec::new())
        .unwrap()
}
