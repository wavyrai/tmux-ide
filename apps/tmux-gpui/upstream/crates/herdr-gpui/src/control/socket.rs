//! The Unix socket behind `herdr-gpui browser`. A worker accepts
//! connections and serves each on a thread of its own, up to a bound: it
//! reads one bounded request, hands it to the UI through a bounded queue,
//! and writes back the answer the UI gives it. A feedback request may wait
//! minutes for the user, so connections cannot share one thread.
use super::protocol::{ErrorCode, MAX_MESSAGE, MAX_WAIT_SECONDS, Request, Response};
use std::{
    io::{self, BufRead, BufReader, Read, Write},
    os::unix::{
        fs::PermissionsExt,
        net::{UnixListener, UnixStream},
    },
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
        mpsc::{self, Receiver, SyncSender, TrySendError},
    },
    thread,
    time::Duration,
};

const IO_TIMEOUT: Duration = Duration::from_secs(2);
/// How long a caller waits for the UI, which may be busy or have no window.
const ANSWER_TIMEOUT: Duration = Duration::from_secs(10);
/// Requests waiting for the UI. Each connection holds one, so this bounds
/// how many callers are answered `busy` rather than queued.
const QUEUE: usize = 4;
/// Connections served at once, waiting ones included.
const CONNECTIONS: usize = 8;

/// How long the UI may take to answer `request`: a feedback request waits
/// for the user as long as it asked to.
fn answer_timeout(request: &Request) -> Duration {
    match request {
        Request::Feedback(feedback) => {
            ANSWER_TIMEOUT + Duration::from_secs(feedback.wait_seconds.min(MAX_WAIT_SECONDS))
        }
        _ => ANSWER_TIMEOUT,
    }
}

/// A request waiting for the UI's answer.
pub(crate) struct Incoming {
    pub request: Request,
    reply: SyncSender<Response>,
}

impl Incoming {
    pub(crate) fn respond(self, response: Response) {
        // The caller may have given up already; there is no one to tell.
        let _ = self.reply.try_send(response);
    }
}

pub(crate) struct Server {
    path: PathBuf,
    requests: Receiver<Incoming>,
}

impl Server {
    /// Binds `path`, replacing a socket no process answers on. Another live
    /// server keeps its socket and this one does not start.
    pub(crate) fn bind(path: &Path) -> crate::Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
            std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700))?;
        }
        let listener = match UnixListener::bind(path) {
            Ok(listener) => listener,
            Err(error) if error.kind() == io::ErrorKind::AddrInUse => {
                if UnixStream::connect(path).is_ok() {
                    return Err(crate::Error::ControlSocketInUse {
                        path: path.to_owned(),
                    });
                }
                std::fs::remove_file(path)?;
                UnixListener::bind(path)?
            }
            Err(error) => return Err(error.into()),
        };
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
        let (sender, requests) = mpsc::sync_channel(QUEUE);
        // The worker blocks in accept for the life of the process. Nothing
        // joins it: the UI must never wait on it, and exit reclaims it.
        thread::Builder::new()
            .name("browser-control".into())
            .spawn(move || {
                let open = Arc::new(AtomicUsize::new(0));
                for stream in listener.incoming() {
                    let stream = match stream {
                        Ok(stream) => stream,
                        Err(error) => {
                            tracing::debug!(%error, "Control accept failed");
                            continue;
                        }
                    };
                    if open.fetch_add(1, Ordering::AcqRel) >= CONNECTIONS {
                        open.fetch_sub(1, Ordering::AcqRel);
                        refuse(&stream);
                        continue;
                    }
                    let (queue, done) = (sender.clone(), open.clone());
                    let spawned = thread::Builder::new()
                        .name("browser-control-connection".into())
                        .spawn(move || {
                            serve(stream, &queue);
                            done.fetch_sub(1, Ordering::AcqRel);
                        });
                    if let Err(error) = spawned {
                        tracing::debug!(%error, "Control connection thread failed");
                        open.fetch_sub(1, Ordering::AcqRel);
                    }
                }
            })?;
        Ok(Self {
            path: path.to_owned(),
            requests,
        })
    }

    pub(crate) fn path(&self) -> &Path {
        &self.path
    }

    /// Requests that arrived since the last call.
    pub(crate) fn drain(&self) -> impl Iterator<Item = Incoming> + '_ {
        self.requests.try_iter()
    }

    #[cfg(test)]
    fn next(&self) -> Option<Incoming> {
        self.requests.recv_timeout(Duration::from_secs(5)).ok()
    }
}

/// Reads one line of at most `MAX_MESSAGE` bytes, without its newline.
fn read_line(reader: impl Read) -> crate::Result<Vec<u8>> {
    let mut line = Vec::new();
    BufReader::new(reader.take(MAX_MESSAGE as u64 + 1)).read_until(b'\n', &mut line)?;
    if line.last() == Some(&b'\n') {
        line.pop();
    } else if line.len() > MAX_MESSAGE {
        return Err(crate::Error::ControlMessageSize { limit: MAX_MESSAGE });
    }
    Ok(line)
}

fn write_line(mut writer: impl Write, message: &impl serde::Serialize) -> crate::Result<()> {
    let mut bytes = serde_json::to_vec(message)?;
    bytes.push(b'\n');
    writer.write_all(&bytes)?;
    writer.flush()?;
    Ok(())
}

fn answer(line: crate::Result<Vec<u8>>, queue: &SyncSender<Incoming>) -> Response {
    let request = match line.and_then(|line| Ok(serde_json::from_slice::<Request>(&line)?)) {
        Ok(request) => request,
        Err(error) => return Response::error(ErrorCode::InvalidRequest, error.to_string()),
    };
    let timeout = answer_timeout(&request);
    let (reply, answer) = mpsc::sync_channel(1);
    match queue.try_send(Incoming { request, reply }) {
        Ok(()) => {}
        Err(TrySendError::Full(_)) => {
            return Response::error(ErrorCode::Busy, "Herdr GPUI is handling other requests");
        }
        Err(TrySendError::Disconnected(_)) => {
            return Response::error(ErrorCode::NoWindow, "Herdr GPUI is shutting down");
        }
    }
    answer.recv_timeout(timeout).unwrap_or_else(|_| {
        Response::error(ErrorCode::Timeout, "Herdr GPUI did not answer in time")
    })
}

/// Answers a connection over the bound without reading it.
fn refuse(stream: &UnixStream) {
    let _ = stream.set_write_timeout(Some(IO_TIMEOUT));
    let busy = Response::error(ErrorCode::Busy, "Herdr GPUI is handling other requests");
    if let Err(error) = write_line(stream, &busy) {
        tracing::debug!(%error, "Control refusal failed");
    }
}

fn serve(stream: UnixStream, queue: &SyncSender<Incoming>) {
    let prepared = stream
        .set_read_timeout(Some(IO_TIMEOUT))
        .and_then(|()| stream.set_write_timeout(Some(IO_TIMEOUT)));
    if let Err(error) = prepared {
        tracing::debug!(%error, "Control connection setup failed");
        return;
    }
    let response = answer(read_line(&stream), queue);
    if let Err(error) = write_line(&stream, &response) {
        tracing::debug!(%error, "Control response failed");
    }
}

/// Sends one request to the server at `path` and returns its answer.
pub(crate) fn call(path: &Path, request: &Request) -> crate::Result<Response> {
    let stream = UnixStream::connect(path).map_err(|source| crate::Error::ControlUnavailable {
        path: path.to_owned(),
        source,
    })?;
    stream.set_write_timeout(Some(IO_TIMEOUT))?;
    // The server waits this long for the UI before answering.
    stream.set_read_timeout(Some(answer_timeout(request) + IO_TIMEOUT))?;
    write_line(&stream, request)?;
    let line = read_line(&stream)?;
    if line.is_empty() {
        return Err(crate::Error::ControlNoResponse);
    }
    Ok(serde_json::from_slice(&line)?)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::super::protocol::{BrowserOpen, Caller, FeedbackRequest, OpenedIn, Page};
    use super::*;

    fn open(url: &str) -> Request {
        Request::Open(BrowserOpen {
            page: Page::Url(url.into()),
            caller: Caller::default(),
            focus: true,
        })
    }

    /// A short private directory: socket paths are limited to about 100 bytes.
    fn socket_dir() -> tempfile::TempDir {
        tempfile::Builder::new()
            .prefix("hgc")
            .tempdir_in("/tmp")
            .unwrap()
    }

    #[test]
    fn a_request_reaches_the_ui_and_its_answer_reaches_the_caller() {
        let dir = socket_dir();
        let path = dir.path().join("control.sock");
        let server = Server::bind(&path).unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
        let caller = thread::spawn({
            let path = path.clone();
            move || call(&path, &open("https://a.test/"))
        });
        let incoming = server.next().unwrap();
        assert_eq!(incoming.request, open("https://a.test/"));
        let expected = Response::Opened {
            opened_in: OpenedIn::Tab,
            workspace_id: Some("w_1".into()),
        };
        incoming.respond(expected.clone());
        assert_eq!(caller.join().unwrap().unwrap(), expected);
    }

    #[test]
    fn malformed_and_oversized_requests_are_answered_without_the_ui() {
        let dir = socket_dir();
        let path = dir.path().join("control.sock");
        let server = Server::bind(&path).unwrap();
        // Exactly one byte over, so the server reads all of it and closing
        // never discards unread input, which some kernels answer with a reset.
        for request in [b"not json\n".to_vec(), vec![b'x'; MAX_MESSAGE + 1]] {
            let mut stream = UnixStream::connect(&path).unwrap();
            stream.write_all(&request).unwrap();
            let response: Response = serde_json::from_slice(&read_line(&stream).unwrap()).unwrap();
            assert!(
                matches!(
                    response,
                    Response::Error {
                        code: ErrorCode::InvalidRequest,
                        ..
                    }
                ),
                "{response:?}"
            );
        }
        assert!(server.drain().next().is_none());
    }

    #[test]
    fn a_live_server_keeps_its_socket_and_a_stale_one_is_replaced() {
        let dir = socket_dir();
        let path = dir.path().join("control.sock");
        let server = Server::bind(&path).unwrap();
        assert!(matches!(
            Server::bind(&path),
            Err(crate::Error::ControlSocketInUse { .. })
        ));
        drop(server);
        // A socket file nobody listens on, as a crashed app leaves behind.
        let stale = dir.path().join("stale.sock");
        drop(UnixListener::bind(&stale).unwrap());
        assert!(Server::bind(&stale).is_ok());
    }

    #[test]
    fn a_waiting_caller_does_not_hold_up_the_next_one() {
        let dir = socket_dir();
        let path = dir.path().join("control.sock");
        let server = Server::bind(&path).unwrap();
        let waiting = thread::spawn({
            let path = path.clone();
            move || {
                call(
                    &path,
                    &Request::Feedback(FeedbackRequest {
                        pane_id: "w_1:p1".into(),
                        wait_seconds: 30,
                    }),
                )
            }
        });
        let parked = server.next().unwrap();
        assert!(matches!(parked.request, Request::Feedback(_)));
        // While the first caller waits for the user, another is answered.
        let next = thread::spawn({
            let path = path.clone();
            move || call(&path, &open("https://a.test/"))
        });
        server
            .next()
            .unwrap()
            .respond(Response::Reloaded { tabs: 0 });
        assert_eq!(
            next.join().unwrap().unwrap(),
            Response::Reloaded { tabs: 0 }
        );
        parked.respond(Response::Feedback { text: None });
        assert_eq!(
            waiting.join().unwrap().unwrap(),
            Response::Feedback { text: None }
        );
    }

    #[test]
    fn feedback_waits_are_bounded() {
        let wait = |wait_seconds| {
            answer_timeout(&Request::Feedback(FeedbackRequest {
                pane_id: "p".into(),
                wait_seconds,
            }))
        };
        assert_eq!(wait(5), ANSWER_TIMEOUT + Duration::from_secs(5));
        assert_eq!(
            wait(u64::MAX),
            ANSWER_TIMEOUT + Duration::from_secs(MAX_WAIT_SECONDS)
        );
        assert_eq!(answer_timeout(&open("https://a.test/")), ANSWER_TIMEOUT);
    }

    #[test]
    fn a_missing_server_is_reported_as_unavailable() {
        let dir = socket_dir();
        let path = dir.path().join("missing.sock");
        assert!(matches!(
            call(&path, &open("https://a.test/")),
            Err(crate::Error::ControlUnavailable { .. })
        ));
    }
}
