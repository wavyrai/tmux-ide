//! Only this worker opens, serializes, or writes the fixture artifact.
use super::ledger::{ENDPOINT, Failure, FixtureOptIn, Kind, MAX_TRIALS, Outcome, Receipt, Scope};
use std::{
    fs::OpenOptions,
    io::{self, BufWriter, Write},
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
        mpsc::{self, SyncSender, TrySendError},
    },
    thread::{self, JoinHandle},
};
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SubmitError {
    Full,
    Stopped,
}
#[derive(Debug, Default)]
struct Status {
    written: AtomicUsize,
    dropped: AtomicUsize,
    failure: Mutex<Option<io::ErrorKind>>,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct LogStatus {
    pub written: usize,
    pub dropped: usize,
    pub failure: Option<io::ErrorKind>,
}
pub(crate) struct LogSink {
    sender: SyncSender<Receipt>,
    status: Arc<Status>,
}
impl LogSink {
    /// No filesystem operations here. The caller must never join this handle on the UI thread.
    pub fn spawn(
        _fixture: FixtureOptIn,
        path: PathBuf,
    ) -> io::Result<(Self, JoinHandle<io::Result<()>>)> {
        let (sender, receiver) = mpsc::sync_channel::<Receipt>(MAX_TRIALS);
        let status = Arc::new(Status::default());
        let worker_status = Arc::clone(&status);
        let worker = thread::Builder::new()
            .name("renderer-probe-log".into())
            .spawn(move || {
                let result = (|| {
                    let mut options = OpenOptions::new();
                    options.write(true).create_new(true);
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::OpenOptionsExt;
                        options.mode(0o600);
                    }
                    let mut output = BufWriter::new(options.open(path)?);
                    for receipt in receiver {
                        serde_json::to_writer(&mut output, &record(&receipt))
                            .map_err(io::Error::other)?;
                        output.write_all(b"\n")?;
                        // Keep completed evidence durable in the artifact, never on the paint thread.
                        output.flush()?;
                        worker_status.written.fetch_add(1, Ordering::Relaxed);
                    }
                    output.flush()
                })();
                if let Err(error) = &result {
                    *worker_status
                        .failure
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(error.kind());
                }
                result
            })?;
        Ok((Self { sender, status }, worker))
    }
    /// Constant bounded enqueue; a dropped record invalidates the comparative run.
    pub fn try_submit(&self, receipt: Receipt) -> Result<(), SubmitError> {
        self.sender.try_send(receipt).map_err(|error| {
            self.status.dropped.fetch_add(1, Ordering::Relaxed);
            match error {
                TrySendError::Full(_) => SubmitError::Full,
                TrySendError::Disconnected(_) => SubmitError::Stopped,
            }
        })
    }
    pub fn status(&self) -> LogStatus {
        LogStatus {
            written: self.status.written.load(Ordering::Relaxed),
            dropped: self.status.dropped.load(Ordering::Relaxed),
            failure: *self
                .status
                .failure
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner),
        }
    }
}
fn scope(value: &Scope) -> serde_json::Value {
    serde_json::json!({"pane":value.pane,"generation":value.generation,"incarnation":value.incarnation,"request":value.request,"cols":value.cols,"rows":value.rows,"viewportOffset":value.viewport_offset})
}
fn failure(value: Failure) -> &'static str {
    match value {
        Failure::ClockInvalid => "clock-invalid",
        Failure::Timeout => "timeout",
        Failure::ScopeChanged => "scope-changed",
        Failure::MarkerAlreadyPresent => "marker-already-present",
        Failure::NegativeControlIncomplete => "negative-control-incomplete",
        Failure::InvalidWitness => "invalid-witness",
        Failure::InputRejected => "input-rejected",
        Failure::TransportFailed => "transport-failed",
        Failure::FixtureStopped => "fixture-stop",
    }
}
fn record(value: &Receipt) -> serde_json::Value {
    let (status, reason) = match value.outcome {
        Outcome::Completed => ("completed", None),
        Outcome::Failed(reason) => ("failed", Some(failure(reason))),
    };
    serde_json::json!({"id":value.id,"nonce":value.nonce,"kind":match value.kind{Kind::Input=>"input",Kind::Scroll=>"scroll",Kind::Output=>"output"},"side":"gui","status":status,"reason":reason,"endpoint":ENDPOINT,"marker":value.marker,"source":scope(&value.source),"expected":scope(&value.expected),"witness":value.witness.as_ref().map(|w|serde_json::json!({"scope":scope(&w.scope),"paintSequence":w.paint_sequence,"row":w.row,"column":w.column})),"admittedAtMicros":value.admitted_at_micros,"atMicros":value.at_micros,"durationMicros":value.duration_micros})
}
#[cfg(test)]
#[path = "logging_tests.rs"]
mod tests;
