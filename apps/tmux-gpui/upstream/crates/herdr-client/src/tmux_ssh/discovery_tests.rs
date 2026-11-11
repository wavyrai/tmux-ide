#![allow(clippy::unwrap_used)]
use super::*;
fn shell(script: &str) -> Command {
    let mut command = Command::new("/bin/sh");
    command.args(["-c", script]);
    command
}
fn run(script: &str) -> Result<Vec<u8>, DiscoveryError> {
    execute(
        shell(script),
        &AtomicBool::new(false),
        Instant::now() + Duration::from_secs(2),
    )
}
#[test]
fn exit_success_is_required_and_diagnostics_are_not_returned() {
    assert_eq!(run("printf result; printf private >&2").unwrap(), b"result");
    assert!(matches!(
        run("printf result; exit 127"),
        Err(DiscoveryError::MissingCli)
    ));
    let error = run("printf secret >&2; exit 1").unwrap_err();
    assert!(matches!(error, DiscoveryError::Exit));
    assert!(!format!("{error:?}").contains("secret"));
}
#[test]
fn output_and_stalled_process_are_bounded() {
    assert!(matches!(
        run("while :; do printf '01234567890123456789012345678901'; done"),
        Err(DiscoveryError::OutputLimit)
    ));
    let start = Instant::now();
    let result = execute(
        shell("while :; do :; done"),
        &AtomicBool::new(false),
        start + Duration::from_millis(50),
    );
    assert!(matches!(result, Err(DiscoveryError::Timeout)));
    assert!(start.elapsed() < Duration::from_secs(2));
}
#[test]
fn cancellation_precedes_spawn_and_interrupts_busy_stderr() {
    assert!(matches!(
        execute(
            Command::new("/nonexistent"),
            &AtomicBool::new(true),
            Instant::now() + Duration::from_secs(1)
        ),
        Err(DiscoveryError::Cancelled)
    ));
    let cancelled = AtomicBool::new(false);
    thread::scope(|scope| {
        scope.spawn(|| {
            thread::sleep(Duration::from_millis(50));
            cancelled.store(true, Ordering::Release);
        });
        let result = execute(
            shell("while :; do printf private >&2; done"),
            &cancelled,
            Instant::now() + Duration::from_secs(2),
        );
        assert!(matches!(result, Err(DiscoveryError::Cancelled)));
    });
}

#[test]
fn ssh_failure_classification_is_bounded_and_redacted() {
    assert!(matches!(
        run("printf 'Permission denied (publickey). secret' >&2; exit 255"),
        Err(DiscoveryError::Authentication)
    ));
    assert!(matches!(
        run("printf 'Host key verification failed. secret' >&2; exit 255"),
        Err(DiscoveryError::HostKey)
    ));
    let mut diagnostics = Diagnostics::default();
    diagnostics.observe(b"REMOTE HOST IDENT");
    diagnostics.observe(b"IFICATION HAS CHANGED");
    diagnostics.observe(&[b'x'; 8192]);
    assert!(diagnostics.tail.len() <= 4096);
    assert!(matches!(diagnostics.failure(), DiscoveryError::HostKey));
}

/// r4 review (owner decision): a machine that is off or away is retried, but
/// only when ssh says so in these words; auth and host-key failures are read
/// first and stay final, and anything unrecognised stays a failure.
#[test]
fn ssh_saying_the_machine_cant_be_reached_is_unreachable_and_nothing_else_is() {
    let failure = |stderr: &str| {
        let mut diagnostics = Diagnostics::default();
        diagnostics.observe(stderr.as_bytes());
        diagnostics.failure()
    };
    for stderr in [
        "ssh: connect to host spark port 22: No route to host",
        "ssh: connect to host spark port 22: Connection refused",
        "ssh: connect to host spark port 22: Network is unreachable",
        "ssh: Could not resolve hostname spark: nodename nor servname provided",
        "ssh: connect to host spark port 22: Operation timed out",
    ] {
        assert!(
            matches!(failure(stderr), DiscoveryError::Unreachable),
            "{stderr}"
        );
    }
    for stderr in [
        "Connection closed by 10.0.0.2 port 22",
        "kex_exchange_identification: read: Connection reset by peer",
        "",
        // The remote command's own stderr, not ssh's (review-chrome on #360):
        // reached, ran and failed, so not retried.
        "curl: (7) Failed to connect to localhost port 8080: Connection refused",
        "Error: getaddrinfo: Could not resolve hostname db",
        "connect to host db port 5432: Operation timed out",
    ] {
        assert!(matches!(failure(stderr), DiscoveryError::Exit), "{stderr}");
    }
    // Auth and host-key failures are read first and stay final, even beside
    // a line that alone would be retried.
    assert!(matches!(
        failure(
            "ssh: connect to host spark port 22: Connection refused\n\
             user@spark: Permission denied (publickey)."
        ),
        DiscoveryError::Authentication
    ));
    assert!(matches!(
        failure(
            "ssh: connect to host spark port 22: No route to host\n\
             Host key verification failed."
        ),
        DiscoveryError::HostKey
    ));
    assert!(matches!(
        failure(
            "channel 0: open failed: connect failed: Connection refused\n\
             Host key verification failed."
        ),
        DiscoveryError::HostKey
    ));
    // ssh's line still counts after the remote's output, and when it arrives
    // in two reads.
    assert!(matches!(
        failure("remote noise\nssh: connect to host spark port 22: No route to host\n"),
        DiscoveryError::Unreachable
    ));
    let mut diagnostics = Diagnostics::default();
    diagnostics.observe(b"ssh: connect to host spark port 22: Connec");
    diagnostics.observe(b"tion refused\r\n");
    assert!(matches!(diagnostics.failure(), DiscoveryError::Unreachable));
}

/// #368 review: through a jump host that is reachable, the target being away
/// is reported by the jump host, not as an "ssh: " line. OpenSSH's own form
/// (channels.c channel_input_open_failure, V_9_9_P2):
/// `channel %d: open failed: %s%s%s` with reason "connect failed" and the
/// jump host's strerror; ssh -W then exits with "stdio forwarding failed".
#[test]
fn a_jump_host_that_cannot_reach_the_target_is_unreachable() {
    let failure = |stderr: &str| {
        let mut diagnostics = Diagnostics::default();
        diagnostics.observe(stderr.as_bytes());
        diagnostics.failure()
    };
    for error in [
        "Connection refused",
        "No route to host",
        "Network is unreachable",
        "Operation timed out",
        "Connection timed out",
    ] {
        let stderr = format!(
            "channel 0: open failed: connect failed: {error}\r\n\
             stdio forwarding failed\r\n\
             Connection closed by UNKNOWN port 65535\r\n"
        );
        assert!(
            matches!(failure(&stderr), DiscoveryError::Unreachable),
            "{error}"
        );
    }
    assert!(matches!(
        failure("channel 12: open failed: connect failed: No route to host"),
        DiscoveryError::Unreachable
    ));
    // Only ssh's exact form: anchored at the line start, a numeric channel,
    // "connect failed", one of the phrases. A remote command's output, or
    // another open failure, stays a failure.
    for stderr in [
        "  channel 0: open failed: connect failed: Connection refused",
        "log: channel 0: open failed: connect failed: Connection refused",
        "channel x: open failed: connect failed: Connection refused",
        "channel : open failed: connect failed: Connection refused",
        "channel 0: open failed: administratively prohibited: Connection refused",
        "channel 0: open failed: connect failed: Name or service not known",
        "  ssh: connect to host spark port 22: Connection refused",
        "stdio forwarding failed\nConnection closed by UNKNOWN port 65535",
    ] {
        assert!(matches!(failure(stderr), DiscoveryError::Exit), "{stderr}");
    }
}
