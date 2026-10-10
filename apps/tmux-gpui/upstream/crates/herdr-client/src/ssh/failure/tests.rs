#![allow(clippy::unwrap_used)]
use super::*;
use std::process::{Command, Stdio};

#[test]
fn ssh_failures_are_classified_from_exit_code_and_stderr() {
    let cases: [(Option<i32>, &str, SshFailure); 10] = [
        (
            Some(255),
            "Host key verification failed.\r\n",
            SshFailure::HostKey,
        ),
        (
            Some(255),
            "@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@\n",
            SshFailure::HostKey,
        ),
        (
            Some(255),
            "me@host: Permission denied (publickey).\n",
            SshFailure::Auth,
        ),
        (
            Some(255),
            "Received disconnect: Too many authentication failures\n",
            SshFailure::Auth,
        ),
        (
            Some(255),
            "ssh: Could not resolve hostname nope: nodename nor servname provided\n",
            SshFailure::Unreachable,
        ),
        (
            Some(255),
            "ssh: connect to host h port 22: Operation timed out\n",
            SshFailure::Unreachable,
        ),
        (Some(255), "something new\n", SshFailure::Other),
        (Some(127), "", SshFailure::HerdrMissing),
        // The remote's own failures are never read as ssh's.
        (Some(1), "Permission denied\n", SshFailure::Other),
        (None, "Host key verification failed.\n", SshFailure::Other),
    ];
    for (code, stderr, expected) in cases {
        assert_eq!(
            SshFailure::classify(code, stderr.as_bytes()),
            expected,
            "{stderr}"
        );
    }
}

#[test]
fn only_failures_the_user_must_fix_wait_for_them() {
    assert!(SshFailure::HostKey.needs_user());
    assert!(SshFailure::Auth.needs_user());
    assert!(SshFailure::HerdrMissing.needs_user());
    assert!(!SshFailure::Unreachable.needs_user());
    assert!(!SshFailure::Other.needs_user());
}

#[test]
fn the_stderr_tail_is_bounded_to_the_latest_output() {
    let mut input = vec![b'x'; STDERR_TAIL * 3];
    input.extend_from_slice(b"Permission denied");
    let kept = tail(input.as_slice());
    assert_eq!(kept.len(), STDERR_TAIL);
    assert!(kept.ends_with(b"Permission denied"));
}

#[test]
fn a_closed_child_is_diagnosed_from_its_real_exit_and_stderr() {
    let mut child = Command::new("/bin/sh")
        .args([
            "-c",
            "printf 'me@host: Permission denied (publickey).\\n' >&2; exit 255",
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let stderr = drain(child.stderr.take().unwrap()).unwrap();
    let stop = AtomicBool::new(false);
    assert_eq!(diagnose(&mut child, &stderr, &stop), SshFailure::Auth);
}

#[test]
fn a_child_that_will_not_exit_is_not_waited_on_past_cancellation() {
    let mut child = Command::new("/bin/sh")
        .args(["-c", "exec sleep 30"])
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let stderr = drain(child.stderr.take().unwrap()).unwrap();
    let stop = AtomicBool::new(true);
    let started = Instant::now();
    assert_eq!(diagnose(&mut child, &stderr, &stop), SshFailure::Other);
    assert!(started.elapsed() < DIAGNOSE_TIMEOUT);
    child.kill().unwrap();
    child.wait().unwrap();
}

#[test]
fn a_refused_bridge_reports_its_class_through_the_error() {
    let error = crate::Error::SshRefused(SshFailure::Auth);
    assert_eq!(error.kind(), ErrorKind::PermissionDenied);
    assert!(
        error
            .to_string()
            .starts_with("SSH bridge closed: authentication failed")
    );
    let source = std::error::Error::source(&error).unwrap();
    assert_eq!(source.downcast_ref::<SshFailure>(), Some(&SshFailure::Auth));
}
