//! Client logs, stored on disk rather than in memory. Capture never blocks the
//! emitting thread: each event is serialized to one JSON line of at most 4096
//! bytes and offered to a bounded queue drained by a dedicated writer thread,
//! which appends to `<state>/herdr/gpui/logs/herdr-gpui.jsonl` and rotates it to
//! `herdr-gpui.1.jsonl` beyond 16 MiB. A full queue or failed write drops lines
//! and counts them. No uploads, environment filters, or stderr. Span context
//! includes names, not fields; arbitrary field Debug implementations must
//! cooperate with fmt errors.
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::{
    cell::Cell,
    collections::VecDeque,
    fmt::{self, Write as _},
    fs::{self, File, OpenOptions},
    io::{self, Read, Seek, SeekFrom, Write as _},
    path::{Path, PathBuf},
    sync::{
        Arc, OnceLock,
        atomic::{AtomicU64, Ordering},
        mpsc::{self, Receiver, SyncSender},
    },
    thread,
};
use tracing::{
    Event, Level, Subscriber,
    field::{Field, Visit},
};
use tracing_subscriber::{Layer, layer::Context, prelude::*, registry::LookupSpan};

const MAX_BYTES: usize = 4096;
const TIMESTAMP_FORMAT: &str = "[%Y-%m-%d %H:%M:%S]";
const FILE_NAME: &str = "herdr-gpui.jsonl";
const PREVIOUS_FILE_NAME: &str = "herdr-gpui.1.jsonl";
/// Lines waiting for the writer; beyond this, capture drops rather than blocks.
const QUEUE: usize = 4096;
const MAX_FILE_BYTES: u64 = 16 * 1024 * 1024;
/// The writer issues one write per batch of at most this many bytes.
const BATCH_BYTES: usize = 256 * 1024;
/// Newest records a reader keeps; older ones remain only on disk.
pub(crate) const TAIL_RECORDS: usize = 5000;
/// A reader opening an existing file starts this far from its end.
const TAIL_BYTES: u64 = 4 * 1024 * 1024;
const READ_CHUNK: usize = 64 * 1024;
/// Longer lines are not ours; skip them without buffering.
const MAX_LINE: usize = 64 * 1024;
static SINK: OnceLock<Sink> = OnceLock::new();
thread_local! { static FORMATTING: Cell<bool> = const { Cell::new(false) }; }

#[derive(Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename = "event")]
pub(crate) struct Record {
    #[serde(with = "level_json")]
    pub(crate) level: Level,
    /// Local wall time at capture, retained unchanged for display and export.
    pub(crate) timestamp: String,
    pub(crate) target: String,
    pub(crate) namespace: String,
    pub(crate) message: String,
    pub(crate) fields: Map<String, Value>,
    /// Leaf first, names only. Never retain raw span fields.
    pub(crate) spans: Vec<String>,
    pub(crate) truncated: bool,
}

impl Record {
    pub(crate) fn body(&self) -> String {
        let mut text = self.target.clone();
        for span in &self.spans {
            let _ = write!(text, " [{span}]");
        }
        if !self.message.is_empty() {
            let _ = write!(text, " {}", self.message);
        }
        for (key, value) in &self.fields {
            let _ = write!(text, " {key}={value}");
        }
        if self.truncated {
            text.push_str(" [truncated]");
        }
        text
    }

    pub(crate) fn line(&self) -> String {
        format!(
            "{} {:<5} {}",
            self.timestamp,
            self.level.as_str(),
            self.body()
        )
    }

    #[cfg(test)]
    pub(crate) fn fixture(level: Level, message: impl Into<String>) -> Self {
        Self {
            level,
            timestamp: "[2025-09-26 15:03:45]".into(),
            target: String::new(),
            namespace: String::new(),
            message: message.into(),
            fields: Map::new(),
            spans: Vec::new(),
            truncated: false,
        }
    }
}

mod level_json {
    use super::*;

    pub(super) fn serialize<S: serde::Serializer>(
        level: &Level,
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(level.as_str())
    }

    pub(super) fn deserialize<'de, D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> Result<Level, D::Error> {
        let value = String::deserialize(deserializer)?;
        value.parse().map_err(serde::de::Error::custom)
    }
}

/// Install once, before starting workers. An existing global subscriber is an
/// error, never silently replaced. No tracing-log bridge is installed. Without a
/// state directory or writer thread, every event counts as dropped.
pub(crate) fn init() -> Result<(), tracing::subscriber::SetGlobalDefaultError> {
    let (lines, queued) = mpsc::sync_channel(QUEUE);
    let counters = Arc::new(Counters::default());
    let path = crate::preferences::state_dir()
        .map(|dir| dir.join("logs").join(FILE_NAME))
        .and_then(|path| {
            let writer_path = path.clone();
            let writer_counters = counters.clone();
            thread::Builder::new()
                .name("gpui-log-writer".into())
                .spawn(move || write_lines(writer_path, queued, &writer_counters))
                .ok()
                .map(|_| path)
        });
    let _ = SINK.set(Sink {
        counters: counters.clone(),
        path,
    });
    tracing::subscriber::set_global_default(subscriber(Capture { lines, counters }))
}

struct Sink {
    counters: Arc<Counters>,
    path: Option<PathBuf>,
}

/// The file the writer appends to, when one could be started.
pub(crate) fn path() -> Option<&'static Path> {
    SINK.get()?.path.as_deref()
}

/// A change hint: advances after each written batch and each dropped line.
pub(crate) fn generation() -> u64 {
    SINK.get()
        .map_or(0, |sink| sink.counters.generation.load(Ordering::Acquire))
}

/// Lines this process failed to queue or write.
pub(crate) fn dropped() -> u64 {
    SINK.get()
        .map_or(0, |sink| sink.counters.dropped.load(Ordering::Relaxed))
}

#[derive(Default)]
struct Counters {
    generation: AtomicU64,
    dropped: AtomicU64,
}

impl Counters {
    fn lose(&self, lines: u64) {
        self.dropped.fetch_add(lines, Ordering::Relaxed);
        self.generation.fetch_add(1, Ordering::Release);
    }
}

fn write_lines(path: PathBuf, queued: Receiver<Vec<u8>>, counters: &Counters) {
    let mut log = LogFile {
        path,
        file: None,
        limit: MAX_FILE_BYTES,
    };
    let mut batch = Vec::new();
    while let Ok(first) = queued.recv() {
        batch.extend_from_slice(&first);
        let mut lines = 1;
        while batch.len() < BATCH_BYTES
            && let Ok(line) = queued.try_recv()
        {
            batch.extend_from_slice(&line);
            lines += 1;
        }
        if log.append(&batch).is_err() {
            counters.lose(lines);
        } else {
            counters.generation.fetch_add(1, Ordering::Release);
        }
        batch.clear();
    }
}

struct LogFile {
    path: PathBuf,
    /// The open file and its length; closed after a failure so the next batch reopens it.
    file: Option<(File, u64)>,
    limit: u64,
}

impl LogFile {
    /// Appends whole lines, rotating first when they would overflow a non-empty file.
    fn append(&mut self, lines: &[u8]) -> io::Result<()> {
        let incoming = lines.len() as u64;
        let (mut file, mut len) = match self.file.take() {
            Some(open) => open,
            None => {
                let file = self.open()?;
                let len = file.metadata()?.len();
                (file, len)
            }
        };
        if len > 0 && len.saturating_add(incoming) > self.limit {
            // Windows cannot rename an open file.
            drop(file);
            self.rotate()?;
            file = self.open()?;
            len = 0;
        }
        file.write_all(lines)?;
        self.file = Some((file, len + incoming));
        Ok(())
    }

    fn rotate(&self) -> io::Result<()> {
        fs::rename(&self.path, self.path.with_file_name(PREVIOUS_FILE_NAME))
    }

    fn open(&self) -> io::Result<File> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut options = OpenOptions::new();
        options.create(true).append(true);
        // Logs can name local paths and hosts; keep them private to the user.
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        options.open(&self.path)
    }
}

/// Incrementally reads the newest records of a log file, keeping at most
/// [`TAIL_RECORDS`]. Unparseable lines are skipped. A file shorter than the
/// read position was rotated or truncated and is read again from its start.
pub(crate) struct Tail {
    path: PathBuf,
    offset: Option<u64>,
    partial: Vec<u8>,
    /// Skipping to the next newline: a line started before the read position or ran too long.
    discarding: bool,
    records: VecDeque<Arc<Record>>,
}

impl Tail {
    pub(crate) fn new(path: impl Into<PathBuf>) -> Self {
        Self {
            path: path.into(),
            offset: None,
            partial: Vec::new(),
            discarding: false,
            records: VecDeque::new(),
        }
    }

    /// Reads whatever was appended since the last call. A missing file is empty.
    pub(crate) fn read(&mut self) -> io::Result<()> {
        let mut file = match File::open(&self.path) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error),
        };
        let len = file.metadata()?.len();
        let mut offset = match self.offset {
            Some(offset) if offset <= len => offset,
            Some(_) => {
                self.partial.clear();
                self.discarding = false;
                0
            }
            None => {
                let start = len.saturating_sub(TAIL_BYTES);
                self.discarding = start > 0;
                start
            }
        };
        file.seek(SeekFrom::Start(offset))?;
        let mut chunk = vec![0; READ_CHUNK];
        // Stop at the length observed above; later appends are read next time.
        while offset < len {
            let limit =
                usize::try_from(len - offset).map_or(READ_CHUNK, |rest| rest.min(READ_CHUNK));
            let read = file.read(&mut chunk[..limit])?;
            if read == 0 {
                break;
            }
            offset += read as u64;
            self.consume(&chunk[..read]);
        }
        self.offset = Some(offset);
        Ok(())
    }

    fn consume(&mut self, mut bytes: &[u8]) {
        while !bytes.is_empty() {
            let (line, complete, rest) = match bytes.iter().position(|byte| *byte == b'\n') {
                Some(end) => (&bytes[..end], true, &bytes[end + 1..]),
                None => (bytes, false, &[][..]),
            };
            bytes = rest;
            if !self.discarding {
                if self.partial.len() + line.len() > MAX_LINE {
                    self.partial.clear();
                    self.discarding = true;
                } else {
                    self.partial.extend_from_slice(line);
                }
            }
            if !complete {
                continue;
            }
            if !self.discarding
                && let Ok(record) = serde_json::from_slice::<Record>(&self.partial)
            {
                if self.records.len() == TAIL_RECORDS {
                    self.records.pop_front();
                }
                self.records.push_back(Arc::new(record));
            }
            self.partial.clear();
            self.discarding = false;
        }
    }

    /// Oldest first.
    pub(crate) fn records(&self) -> Vec<Arc<Record>> {
        self.records.iter().cloned().collect()
    }
}

fn app_target(target: &str) -> bool {
    ["herdr_gpui", "herdr_client", "herdr_protocol"]
        .iter()
        .any(|root| {
            target == *root
                || target
                    .strip_prefix(root)
                    .is_some_and(|rest| rest.starts_with("::"))
        })
}

fn subscriber(capture: Capture) -> impl Subscriber + Send + Sync {
    tracing_subscriber::registry().with(capture.with_filter(tracing_subscriber::filter::filter_fn(
        |meta| app_target(meta.target()),
    )))
}

struct Capture {
    lines: SyncSender<Vec<u8>>,
    counters: Arc<Counters>,
}
struct FormattingGuard;
impl Drop for FormattingGuard {
    fn drop(&mut self) {
        FORMATTING.set(false);
    }
}

impl<S: Subscriber + for<'a> LookupSpan<'a>> Layer<S> for Capture {
    fn on_event(&self, event: &Event<'_>, ctx: Context<'_, S>) {
        if FORMATTING.replace(true) {
            self.counters.lose(1);
            return;
        }
        let _guard = FormattingGuard;
        let timestamp = chrono::Local::now().format(TIMESTAMP_FORMAT).to_string();
        let meta = event.metadata();
        let mut target = Bounded::new(256);
        let _ = target.write_str(meta.target());
        let mut record = Record {
            level: *meta.level(),
            timestamp,
            target: target.text,
            namespace: meta.target().split("::").next().unwrap_or_default().into(),
            message: String::new(),
            fields: Map::new(),
            spans: Vec::new(),
            truncated: target.truncated,
        };
        if let Some(scope) = ctx.event_scope(event) {
            // Leaf first avoids allocating/reversing an arbitrarily deep scope.
            for (index, span) in scope.take(17).enumerate() {
                if index == 16 {
                    record.truncated = true;
                    break;
                }
                let mut name = Bounded::new(64);
                let _ = name.write_str(span.name());
                record.truncated |= name.truncated;
                record.spans.push(name.text);
            }
        }
        let Ok(base) = serde_json::to_vec(&record) else {
            self.counters.lose(1);
            return;
        };
        let mut visitor = Fields {
            record: &mut record,
            remaining: MAX_BYTES.saturating_sub(base.len()),
            count: 0,
        };
        event.record(&mut visitor);
        let Ok(mut line) = serde_json::to_vec(&record) else {
            self.counters.lose(1);
            return;
        };
        line.push(b'\n');
        if self.lines.try_send(line).is_err() {
            self.counters.lose(1);
        }
    }
}

struct Bounded {
    text: String,
    truncated: bool,
    remaining: usize,
}

impl Bounded {
    fn new(remaining: usize) -> Self {
        Self {
            text: String::new(),
            truncated: false,
            remaining,
        }
    }
}

impl fmt::Write for Bounded {
    fn write_str(&mut self, value: &str) -> fmt::Result {
        if self.truncated {
            return Err(fmt::Error);
        }
        // Sanitize while copying, never allocate a full formatted field. Stop
        // scanning once full, even for megabytes of untrusted UTF-8/control data.
        for ch in value.chars() {
            let ch = if ch.is_control() { ' ' } else { ch };
            let bytes = if ch == '"' || ch == '\\' {
                2
            } else {
                ch.len_utf8()
            };
            if bytes > self.remaining {
                self.truncated = true;
                return Err(fmt::Error);
            }
            self.text.push(ch);
            self.remaining -= bytes;
        }
        Ok(())
    }
}

struct Fields<'a> {
    record: &'a mut Record,
    remaining: usize,
    count: usize,
}

impl Fields<'_> {
    fn budget(&mut self, field: &Field) -> Option<usize> {
        // Field names are static but may still be very long. Reject rather than
        // truncate keys, which could merge unrelated fields.
        let overhead = field.name().len().saturating_mul(6).saturating_add(8);
        if self.count >= 32 || field.name().len() > 128 || overhead >= self.remaining {
            self.record.truncated = true;
            return None;
        }
        self.count += 1;
        self.remaining -= overhead;
        Some(self.remaining)
    }

    fn insert(&mut self, field: &Field, value: Value) {
        let Ok(encoded) = serde_json::to_vec(&value) else {
            return;
        };
        if encoded.len() > self.remaining {
            self.record.truncated = true;
            return;
        }
        self.remaining -= encoded.len();
        if field.name() == "message" {
            self.record.message = match value {
                Value::String(text) => text,
                other => other.to_string(),
            };
        } else {
            self.record.fields.insert(field.name().into(), value);
        }
    }

    fn scalar(&mut self, field: &Field, value: Value) {
        if self.budget(field).is_some() {
            self.insert(field, value);
        }
    }
}

impl Visit for Fields<'_> {
    fn record_debug(&mut self, field: &Field, value: &dyn fmt::Debug) {
        let Some(budget) = self.budget(field) else {
            return;
        };
        let mut text = Bounded::new(budget.saturating_sub(2));
        let _ = write!(text, "{value:?}");
        self.record.truncated |= text.truncated;
        self.insert(field, Value::String(text.text));
    }

    fn record_str(&mut self, field: &Field, value: &str) {
        let Some(budget) = self.budget(field) else {
            return;
        };
        let mut text = Bounded::new(budget.saturating_sub(2));
        let _ = text.write_str(value);
        self.record.truncated |= text.truncated;
        self.insert(field, Value::String(text.text));
    }

    fn record_bool(&mut self, field: &Field, value: bool) {
        self.scalar(field, value.into());
    }
    fn record_i64(&mut self, field: &Field, value: i64) {
        self.scalar(field, value.into());
    }
    fn record_u64(&mut self, field: &Field, value: u64) {
        self.scalar(field, value.into());
    }
    fn record_i128(&mut self, field: &Field, value: i128) {
        if let Some(number) = serde_json::Number::from_i128(value) {
            self.scalar(field, Value::Number(number));
        } else {
            self.record_debug(field, &value);
        }
    }
    fn record_u128(&mut self, field: &Field, value: u128) {
        if let Some(number) = serde_json::Number::from_u128(value) {
            self.scalar(field, Value::Number(number));
        } else {
            self.record_debug(field, &value);
        }
    }
    fn record_f64(&mut self, field: &Field, value: f64) {
        if value.is_finite() {
            self.scalar(field, value.into());
        } else {
            self.record_debug(field, &value);
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests;
