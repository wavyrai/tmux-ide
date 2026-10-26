#![allow(clippy::unwrap_used)]
use super::*;
fn shell(script: &str) -> Command {
    let mut command = Command::new("/bin/sh");
    command.args(["-c", script]);
    command
}
fn wait_exit(tunnel: &Tunnel) -> TunnelError {
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        if let Err(error) = tunnel.check() {
            return error;
        }
        assert!(Instant::now() < deadline);
        thread::sleep(Duration::from_millis(5));
    }
}
#[test]
fn failures_are_classified_without_remote_diagnostics() {
    for (script, host_key) in [
        (
            "printf 'Host key verification failed secret' >&2; exit 255",
            true,
        ),
        (
            "printf 'Permission denied (publickey). secret' >&2; exit 255",
            false,
        ),
    ] {
        let tunnel = Tunnel::spawn_command(shell(script), 1234).unwrap();
        let error = wait_exit(&tunnel);
        if host_key {
            assert!(matches!(error, TunnelError::HostKey));
        } else {
            assert!(matches!(error, TunnelError::Authentication));
        }
        assert!(!format!("{error:?}").contains("secret"));
        tunnel.shutdown().unwrap();
    }
}
#[test]
fn retirement_is_immediate_and_busy_stderr_cannot_block_cleanup() {
    let tunnel = Tunnel::spawn_command(
        shell("trap '' TERM; while :; do printf ignored >&2; done"),
        1234,
    )
    .unwrap();
    let start = Instant::now();
    tunnel.retire();
    assert!(matches!(tunnel.check(), Err(TunnelError::Retired)));
    assert!(start.elapsed() < Duration::from_millis(100));
    tunnel.shutdown().unwrap();
    assert!(start.elapsed() < Duration::from_secs(3));
}
#[test]
fn dropping_guard_disconnects_worker_and_reaps_child() {
    let tunnel = Tunnel::spawn_command(shell("exec /bin/sleep 60"), 1234).unwrap();
    let Tunnel { stop, worker, .. } = tunnel;
    drop(stop);
    worker.join().unwrap();
}
