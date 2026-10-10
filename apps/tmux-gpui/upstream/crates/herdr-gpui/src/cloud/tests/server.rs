//! A scripted HTTP API on loopback, for exercising a provider's real HTTP
//! path: each request is recorded and answered by the test's handler.
#![allow(clippy::unwrap_used)]

use std::{
    io::{Read, Write},
    net::TcpListener,
    sync::{Arc, Mutex},
    thread,
};

#[derive(Debug, Clone)]
pub(crate) struct Request {
    pub(crate) method: String,
    pub(crate) target: String,
    pub(crate) authorization: Option<String>,
    /// The raw request head, for checks on headers other than `Authorization`.
    #[cfg_attr(not(feature = "daytona"), allow(dead_code))]
    pub(crate) headers: String,
    pub(crate) body: String,
}

/// Serve `handler` until the test ends, recording every request. Returns the
/// server's base URL.
pub(crate) fn serve(
    handler: impl Fn(&Request) -> (u16, String) + Send + 'static,
) -> (String, Arc<Mutex<Vec<Request>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let log = Arc::new(Mutex::new(Vec::new()));
    let seen = log.clone();
    thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { return };
            let mut bytes = Vec::new();
            let mut chunk = [0; 4096];
            let header_end = loop {
                let read = stream.read(&mut chunk).unwrap();
                if read == 0 {
                    break None;
                }
                bytes.extend_from_slice(&chunk[..read]);
                if let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                    break Some(end + 4);
                }
            };
            let Some(header_end) = header_end else {
                continue;
            };
            let head = String::from_utf8_lossy(&bytes[..header_end]).to_string();
            let length = head
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse::<usize>().ok())?
                })
                .unwrap_or(0);
            while bytes.len() < header_end + length {
                let read = stream.read(&mut chunk).unwrap();
                bytes.extend_from_slice(&chunk[..read]);
            }
            let mut words = head.split(' ');
            let request = Request {
                method: words.next().unwrap().into(),
                target: words.next().unwrap().into(),
                authorization: head.lines().find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("authorization")
                        .then(|| value.trim().to_owned())
                }),
                headers: head.clone(),
                body: String::from_utf8_lossy(&bytes[header_end..]).to_string(),
            };
            let (status, body) = handler(&request);
            seen.lock().unwrap().push(request);
            write!(
                stream,
                "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            )
            .unwrap();
        }
    });
    (base, log)
}
