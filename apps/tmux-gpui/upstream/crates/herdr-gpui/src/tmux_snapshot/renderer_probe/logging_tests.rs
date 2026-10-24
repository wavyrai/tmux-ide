#![allow(clippy::unwrap_used)]
use super::*;
use std::time::{SystemTime, UNIX_EPOCH};
fn receipt() -> Receipt {
    let scope = Scope {
        pane: "pane".into(),
        generation: "g".into(),
        incarnation: "i".into(),
        request: 1,
        cols: 110,
        rows: 32,
        viewport_offset: 0,
    };
    Receipt {
        id: "trial".into(),
        nonce: "a".repeat(32),
        kind: Kind::Input,
        marker: "PROBE-OUTPUT:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into(),
        source: scope.clone(),
        expected: scope,
        witness: None,
        admitted_at_micros: 100,
        at_micros: 200,
        duration_micros: None,
        outcome: Outcome::Failed(Failure::InputRejected),
    }
}
fn path() -> PathBuf {
    std::env::temp_dir().join(format!(
        "native-renderer-probe-{}-{}.jsonl",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ))
}
#[test]
fn worker_persists_exact_failure_identity_without_success_duration() {
    let path = path();
    let (sink, worker) =
        LogSink::spawn(FixtureOptIn::enabled(true).unwrap(), path.clone()).unwrap();
    let status = Arc::clone(&sink.status);
    sink.try_submit(receipt()).unwrap();
    drop(sink);
    worker.join().unwrap().unwrap();
    let output = std::fs::read_to_string(&path).unwrap();
    let json: serde_json::Value = serde_json::from_str(output.trim()).unwrap();
    assert_eq!(json["endpoint"], ENDPOINT);
    assert_eq!(json["status"], "failed");
    assert_eq!(json["reason"], "input-rejected");
    assert_eq!(json["source"]["pane"], "pane");
    assert_eq!(json["admittedAtMicros"], 100);
    assert!(json["durationMicros"].is_null());
    assert_eq!(status.written.load(Ordering::Relaxed), 1);
    std::fs::remove_file(path).unwrap();
}
#[test]
fn full_or_disconnected_log_queue_invalidates_run_without_blocking() {
    let (sender, receiver) = mpsc::sync_channel(1);
    let sink = LogSink {
        sender,
        status: Arc::new(Status::default()),
    };
    sink.try_submit(receipt()).unwrap();
    assert_eq!(sink.try_submit(receipt()), Err(SubmitError::Full));
    drop(receiver);
    assert_eq!(sink.try_submit(receipt()), Err(SubmitError::Stopped));
    assert_eq!(sink.status().dropped, 2);
}
#[test]
fn existing_artifact_is_never_overwritten_and_worker_failure_is_observable() {
    let path = path();
    std::fs::write(&path, b"existing").unwrap();
    let (sink, worker) =
        LogSink::spawn(FixtureOptIn::enabled(true).unwrap(), path.clone()).unwrap();
    assert_eq!(
        worker.join().unwrap().unwrap_err().kind(),
        io::ErrorKind::AlreadyExists
    );
    assert_eq!(sink.status().failure, Some(io::ErrorKind::AlreadyExists));
    assert_eq!(sink.try_submit(receipt()), Err(SubmitError::Stopped));
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "existing");
    std::fs::remove_file(path).unwrap();
}
