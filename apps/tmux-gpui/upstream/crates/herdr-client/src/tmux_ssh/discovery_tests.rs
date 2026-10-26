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
