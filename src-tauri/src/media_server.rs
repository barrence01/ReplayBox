use crate::state::AppState;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use parking_lot::Mutex;
use std::sync::Arc;
use std::thread;
use tiny_http::{Header, Method, Response, Server, StatusCode};

const RANGE_CHUNK_SIZE: usize = 256 * 1024;
const MEDIA_SERVER_THREADS: usize = 8;

pub fn start(state: Arc<AppState>) -> Result<String, String> {
    let server = Server::http("127.0.0.1:0").map_err(|e| e.to_string())?;
    let ip_port = server
        .server_addr()
        .to_ip()
        .ok_or_else(|| "media server did not bind to an inet address".to_string())?;
    let base_url = format!("http://{ip_port}");

    let (tx, rx) = std::sync::mpsc::channel::<tiny_http::Request>();
    let rx = Arc::new(Mutex::new(rx));
    for _ in 0..MEDIA_SERVER_THREADS {
        let rx = rx.clone();
        let state = state.clone();
        thread::spawn(move || loop {
            let request = rx.lock().recv();
            match request {
                Ok(request) => {
                    if let Err(e) = handle_request(&state, request) {
                        tracing::error!("media server error: {e}");
                    }
                }
                Err(_) => break,
            }
        });
    }

    thread::spawn(move || {
        for request in server.incoming_requests() {
            if tx.send(request).is_err() {
                break;
            }
        }
    });

    Ok(base_url)
}

fn handle_request(
    state: &AppState,
    request: tiny_http::Request,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    if *request.method() != Method::Get {
        let _ = request.respond(Response::empty(StatusCode(405)));
        return Ok(());
    }

    let url = request.url().to_string();
    let (path_part, query) = split_url(&url);
    match path_part {
        "/media" => handle_media(state, request, query),
        _ => {
            let _ = request.respond(Response::empty(StatusCode(404)));
            Ok(())
        }
    }
}

fn handle_media(
    state: &AppState,
    request: tiny_http::Request,
    query: Option<&str>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let Some(raw_path) = query_param(query, "path") else {
        let _ = request.respond(Response::from_string("missing path").with_status_code(400));
        return Ok(());
    };

    let decoded = urlencoding::decode(&raw_path)
        .map(|s| s.into_owned())
        .unwrap_or(raw_path);

    let allowed = match resolve_allowed_path(state, &decoded) {
        Ok(p) => p,
        Err(msg) => {
            let _ = request.respond(Response::from_string(msg).with_status_code(403));
            return Ok(());
        }
    };

    if is_playback_cache_path(state, &allowed) {
        tracing::debug!(path = %allowed.display(), "serving playback cache");
    }

    serve_file(request, &allowed)
}

fn split_url(url: &str) -> (&str, Option<&str>) {
    match url.split_once('?') {
        Some((path, query)) => (path, Some(query)),
        None => (url, None),
    }
}

fn query_param(query: Option<&str>, key: &str) -> Option<String> {
    let q = query?;
    for pair in q.split('&') {
        let mut it = pair.splitn(2, '=');
        let k = it.next()?;
        let v = it.next().unwrap_or("");
        if k == key {
            return Some(v.to_string());
        }
    }
    None
}

fn is_playback_cache_path(state: &AppState, path: &Path) -> bool {
    let cache_dir = state.paths.playback_cache_dir();
    cache_dir
        .canonicalize()
        .ok()
        .is_some_and(|root| path.starts_with(&root))
}

/// Canonicalize and ensure the file is under watch_dir, thumbnails, or playback cache.
fn resolve_allowed_path(state: &AppState, raw: &str) -> Result<PathBuf, String> {
    let candidate = PathBuf::from(raw);
    if !candidate.is_absolute() {
        return Err("path must be absolute".into());
    }
    let canonical = candidate
        .canonicalize()
        .map_err(|_| "file not found".to_string())?;
    if !canonical.is_file() {
        return Err("not a file".into());
    }

    let watch = PathBuf::from(&state.settings.lock().watch_dir);
    let watch_canon = watch.canonicalize().ok();
    let thumbs = state.paths.thumbs_dir();
    let thumbs_canon = thumbs.canonicalize().ok();
    let playback = state.paths.playback_cache_dir();
    let playback_canon = playback.canonicalize().ok();

    let under_watch = watch_canon
        .as_ref()
        .map(|root| canonical.starts_with(root))
        .unwrap_or(false);
    let under_thumbs = thumbs_canon
        .as_ref()
        .map(|root| canonical.starts_with(root))
        .unwrap_or(false);
    let under_playback = playback_canon
        .as_ref()
        .map(|root| canonical.starts_with(root))
        .unwrap_or(false);

    if under_watch || under_thumbs || under_playback {
        Ok(canonical)
    } else {
        Err("path outside allowed roots".into())
    }
}

fn content_type(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .as_deref()
    {
        Some("mp4") | Some("m4v") => "video/mp4",
        Some("webm") => "video/webm",
        Some("mkv") => "video/x-matroska",
        Some("mov") => "video/quicktime",
        Some("avi") => "video/x-msvideo",
        Some("ts") => "video/mp2t",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("png") => "image/png",
        Some("webp") => "image/webp",
        _ => "application/octet-stream",
    }
}

struct RangeFileReader {
    file: File,
    remaining: u64,
}

impl Read for RangeFileReader {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if self.remaining == 0 {
            return Ok(0);
        }
        let max_read = buf.len().min(self.remaining as usize).min(RANGE_CHUNK_SIZE);
        let n = self.file.read(&mut buf[..max_read])?;
        self.remaining -= n as u64;
        Ok(n)
    }
}

fn serve_file(
    request: tiny_http::Request,
    path: &Path,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let file = File::open(path)?;
    let file_len = file.metadata()?.len();
    let ctype = content_type(path);
    let range_header = request
        .headers()
        .iter()
        .find(|h| h.field.equiv("Range"))
        .map(|h| h.value.as_str().to_string());

    if let Some(range_val) = range_header {
        if let Some((start, end)) = parse_bytes_range(&range_val, file_len) {
            let len = end - start + 1;
            let mut file = file;
            file.seek(SeekFrom::Start(start))?;
            let reader = RangeFileReader {
                file,
                remaining: len,
            };

            let response = Response::new(
                StatusCode(206),
                vec![
                    Header::from_bytes(&b"Content-Type"[..], ctype.as_bytes()).unwrap(),
                    Header::from_bytes(&b"Accept-Ranges"[..], &b"bytes"[..]).unwrap(),
                    Header::from_bytes(&b"Content-Length"[..], len.to_string().as_bytes())
                        .unwrap(),
                    Header::from_bytes(
                        &b"Content-Range"[..],
                        format!("bytes {start}-{end}/{file_len}").as_bytes(),
                    )
                    .unwrap(),
                    Header::from_bytes(&b"Access-Control-Allow-Origin"[..], &b"*"[..]).unwrap(),
                ],
                reader,
                Some(len as usize),
                None,
            );
            request.respond(response)?;
            return Ok(());
        }
    }

    let mut response = Response::from_file(file).with_status_code(StatusCode(200));
    response.add_header(Header::from_bytes(&b"Content-Type"[..], ctype.as_bytes()).unwrap());
    response.add_header(Header::from_bytes(&b"Accept-Ranges"[..], &b"bytes"[..]).unwrap());
    response.add_header(
        Header::from_bytes(&b"Access-Control-Allow-Origin"[..], &b"*"[..]).unwrap(),
    );
    request.respond(response)?;
    Ok(())
}

fn parse_bytes_range(header: &str, file_len: u64) -> Option<(u64, u64)> {
    let header = header.trim();
    let rest = header.strip_prefix("bytes=")?;
    let (start_s, end_s) = rest.split_once('-')?;
    if start_s.is_empty() {
        let n: u64 = end_s.parse().ok()?;
        if n == 0 || file_len == 0 {
            return None;
        }
        let start = file_len.saturating_sub(n);
        return Some((start, file_len - 1));
    }
    let start: u64 = start_s.parse().ok()?;
    let end = if end_s.is_empty() {
        file_len.saturating_sub(1)
    } else {
        end_s.parse::<u64>().ok()?.min(file_len.saturating_sub(1))
    };
    if start > end || start >= file_len {
        return None;
    }
    Some((start, end))
}

#[cfg(test)]
mod tests {
    use super::{parse_bytes_range, RangeFileReader};
    use std::io::{Read, Write};
    use tempfile::NamedTempFile;

    #[test]
    fn range_start_end() {
        assert_eq!(parse_bytes_range("bytes=0-9", 100), Some((0, 9)));
    }

    #[test]
    fn range_open_end() {
        assert_eq!(parse_bytes_range("bytes=50-", 100), Some((50, 99)));
    }

    #[test]
    fn range_suffix() {
        assert_eq!(parse_bytes_range("bytes=-10", 100), Some((90, 99)));
    }

    #[test]
    fn range_reader_streams_in_chunks() {
        let mut tmp = NamedTempFile::new().unwrap();
        let data: Vec<u8> = (0..10_000).map(|i| (i % 256) as u8).collect();
        tmp.write_all(&data).unwrap();

        let file = tmp.reopen().unwrap();
        let mut reader = RangeFileReader {
            file,
            remaining: 8_000,
        };

        let mut out = Vec::new();
        reader.read_to_end(&mut out).unwrap();
        assert_eq!(out.len(), 8_000);
        assert_eq!(&out[..10], &data[..10]);
    }
}
