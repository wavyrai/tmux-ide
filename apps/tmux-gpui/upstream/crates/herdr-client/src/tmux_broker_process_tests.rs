#![allow(clippy::unwrap_used)]
use super::*;
use std::io::{BufRead, BufReader, Write};

fn fixture(script: &str) -> Broker {
    let mut command = Command::new("/bin/sh");
    command
        .args(["-c", script])
        .env_clear()
        .env("PATH", "/usr/bin:/bin");
    spawn_command(command).unwrap()
}

// Keep protocol failures bounded, including a broker that never writes a line.
fn lines(reader: ChildStdout) -> mpsc::Receiver<String> {
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        for line in BufReader::new(reader).lines() {
            if sender.send(line.unwrap()).is_err() {
                break;
            }
        }
    });
    receiver
}

fn reaped(worker: JoinHandle<()>) {
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        let _ = sender.send(worker.join());
    });
    receiver
        .recv_timeout(Duration::from_secs(5))
        .unwrap()
        .unwrap();
}

#[test]
fn broker_pipes_are_direct_and_eof_is_reaped() {
    let Broker {
        reader,
        mut writer,
        owner,
    } = fixture("read line; printf '%s\\n' \"$line\"");
    writeln!(writer, "metadata-roundtrip").unwrap();
    let reader = lines(reader);
    assert_eq!(
        reader.recv_timeout(Duration::from_secs(5)).unwrap(),
        "metadata-roundtrip"
    );
    drop(writer);
    reaped(owner._worker);
}

#[test]
fn retiring_owner_allows_graceful_cleanup_even_with_open_pipes() {
    let Broker {
        reader,
        writer,
        owner,
    } = fixture("trap 'echo retired; exit 0' TERM; echo ready; while :; do read line; done");
    let reader = lines(reader);
    assert_eq!(
        reader.recv_timeout(Duration::from_secs(5)).unwrap(),
        "ready"
    );
    drop(owner._stop);
    // Wake shell's read so its trapped signal is delivered promptly.
    drop(writer);
    assert_eq!(
        reader.recv_timeout(Duration::from_secs(5)).unwrap(),
        "retired"
    );
    reaped(owner._worker);
}

#[test]
fn retiring_owner_escalates_unresponsive_child_without_waiting_on_caller() {
    let Broker {
        reader,
        writer,
        owner,
    } = fixture("trap '' TERM; echo ready; while :; do read line; done");
    let reader = lines(reader);
    assert_eq!(
        reader.recv_timeout(Duration::from_secs(5)).unwrap(),
        "ready"
    );
    let start = Instant::now();
    drop(owner._stop);
    reaped(owner._worker);
    assert!(start.elapsed() >= GRACE);
    assert!(start.elapsed() < Duration::from_secs(5));
    drop(writer);
    assert_eq!(
        reader.recv_timeout(Duration::from_secs(5)),
        Err(RecvTimeoutError::Disconnected)
    );
}

#[test]
fn missing_executable_fails_before_a_window_is_started() {
    assert!(
        spawn(
            OsStr::new("/missing-tmux-test-node"),
            OsStr::new("broker"),
            OsStr::new("--local")
        )
        .is_err()
    );
}
