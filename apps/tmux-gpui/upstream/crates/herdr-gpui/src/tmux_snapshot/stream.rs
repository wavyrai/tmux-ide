//! tmux-ide addition: bounded helper-to-GPUI transport. No daemon credentials cross it.
use super::{Error, decode};
use herdr_client::protocol::FrameData;
use serde::Deserialize;
use std::{
    io::{BufRead, BufReader, Read},
    sync::{Arc, Mutex},
};

pub(super) type Mailbox = Arc<Mutex<Option<Option<Arc<FrameData>>>>>;
const MAX_LINE: u64 = 8 * 1024 * 1024;
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Publication {
    connection: String,
    sequence: u64,
    snapshot: Option<serde_json::Value>,
}

#[derive(Default)]
struct Reader {
    connection: Option<String>,
    sequence: u64,
    retired: bool,
}
impl Reader {
    fn accept(&mut self, line: &[u8]) -> Result<Option<Arc<FrameData>>, Error> {
        if self.retired {
            return Err(Error::Invalid("connection retired"));
        }
        let event: Publication = serde_json::from_slice(line)?;
        if event.connection.is_empty()
            || event.connection.len() > 128
            || event.sequence <= self.sequence
            || self
                .connection
                .as_ref()
                .is_some_and(|id| *id != event.connection)
        {
            return Err(Error::Invalid("stale or replaced helper connection"));
        }
        let frame = event
            .snapshot
            .map(|snapshot| decode::frame(&serde_json::to_vec(&snapshot)?).map(Arc::new))
            .transpose()?;
        self.connection = Some(event.connection);
        self.sequence = event.sequence;
        self.retired = frame.is_none();
        Ok(frame)
    }
}

pub(super) fn start() -> Mailbox {
    let mailbox = Arc::new(Mutex::new(None));
    let writer = mailbox.clone();
    std::thread::spawn(move || {
        let mut input = BufReader::new(std::io::stdin().lock());
        let mut reader = Reader::default();
        loop {
            let mut line = Vec::new();
            let count = input
                .by_ref()
                .take(MAX_LINE + 1)
                .read_until(b'\n', &mut line);
            let frame = match count {
                Ok(n) if n > 0 && n as u64 <= MAX_LINE && line.last() == Some(&b'\n') => {
                    reader.accept(&line)
                }
                _ => Err(Error::Invalid("helper closed or oversized publication")),
            };
            let done = !matches!(&frame, Ok(Some(_)));
            // Decode and allocate outside the lock; at most one complete pending frame.
            if let Ok(mut slot) = writer.lock() {
                *slot = Some(frame.unwrap_or(None));
            }
            if done {
                eprintln!("tmux-preview: stream retired");
                break;
            }
        }
    });
    mailbox
}

#[cfg(test)]
#[path = "stream_tests.rs"]
mod tests;
