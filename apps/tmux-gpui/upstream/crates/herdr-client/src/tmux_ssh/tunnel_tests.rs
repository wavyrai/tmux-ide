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

/// Children of `pid`, by `pgrep -P` (read-only).
fn children(pid: u32) -> Vec<u32> {
    let out = Command::new("/usr/bin/pgrep")
        .args(["-P", &pid.to_string()])
        .output()
        .unwrap();
    String::from_utf8_lossy(&out.stdout)
        .split_whitespace()
        .filter_map(|p| p.parse().ok())
        .collect()
}
fn alive(pid: u32) -> bool {
    rustix::process::test_kill_process(rustix::process::Pid::from_raw(pid as i32).unwrap()).is_ok()
}
fn gone_within(pid: u32, limit: Duration) -> bool {
    let deadline = Instant::now() + limit;
    while Instant::now() < deadline {
        if !alive(pid) {
            return true;
        }
        thread::sleep(Duration::from_millis(20));
    }
    false
}
/// The forward (`sleep` stands in for ssh) under the guard, with its lifeline
/// held by `holder`, a separate process that plays the app.
fn guarded_under(holder: &mut Child, forward: &str) -> (Child, u32) {
    let (reader, writer) = io::pipe().unwrap();
    // The app's writer goes to the holder; this test keeps no copy.
    let mut app = Command::new("/bin/sleep");
    app.arg("600").stdout(Stdio::from(writer));
    *holder = app.spawn().unwrap();
    let mut guard = guarded(&shell(forward))
        .stdin(Stdio::from(reader))
        .spawn()
        .unwrap();
    drop(app);
    let deadline = Instant::now() + Duration::from_secs(3);
    let forward = loop {
        if let Some(pid) = children(guard.id()).into_iter().find(|pid| {
            // The watcher is a subshell; the forward is the `sh -c` we passed.
            let out = Command::new("/bin/ps")
                .args(["-o", "command=", "-p", &pid.to_string()])
                .output()
                .unwrap();
            String::from_utf8_lossy(&out.stdout).contains("sleep")
                || String::from_utf8_lossy(&out.stdout).contains("trap")
        }) {
            break pid;
        }
        assert!(Instant::now() < deadline, "the forward did not start");
        thread::sleep(Duration::from_millis(20));
    };
    let _ = guard.try_wait();
    (guard, forward)
}

/// 16 Nov: three forwards outlived the app by two weeks. When the app dies in
/// any way (here: SIGKILL of the process that holds the lifeline), its forward
/// ends with it.
#[test]
fn a_forward_ends_when_the_app_that_started_it_dies() {
    let mut holder = Command::new("/usr/bin/true").spawn().unwrap();
    let _ = holder.wait();
    let (mut guard, forward) = guarded_under(&mut holder, "exec /bin/sleep 60");
    assert!(alive(forward));
    holder.kill().unwrap();
    holder.wait().unwrap();
    assert!(
        gone_within(forward, Duration::from_secs(3)),
        "the forward outlived the app"
    );
    let deadline = Instant::now() + Duration::from_secs(3);
    while guard.try_wait().unwrap().is_none() {
        assert!(
            Instant::now() < deadline,
            "the guard shell outlived the app"
        );
        thread::sleep(Duration::from_millis(20));
    }
}

/// A forward that ignores TERM is killed a second later.
#[test]
fn a_forward_that_ignores_term_is_killed_after_the_app_dies() {
    let mut holder = Command::new("/usr/bin/true").spawn().unwrap();
    let _ = holder.wait();
    let (mut guard, forward) =
        guarded_under(&mut holder, "trap '' TERM; while :; do sleep 1; done");
    holder.kill().unwrap();
    holder.wait().unwrap();
    assert!(gone_within(forward, Duration::from_secs(4)));
    let _ = guard.kill();
    let _ = guard.wait();
}

/// Retiring and dropping a tunnel (the app's own clean path) also ends the
/// forward, and nothing is left under the guard.
#[test]
fn shutting_a_tunnel_down_ends_its_forward() {
    let tunnel = Tunnel::spawn_command(shell("exec /bin/sleep 60"), 1234).unwrap();
    let forward = {
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            let pids = Command::new("/usr/bin/pgrep")
                .args(["-f", "^/bin/sleep 60$"])
                .output()
                .unwrap();
            let mut found: Vec<u32> = String::from_utf8_lossy(&pids.stdout)
                .split_whitespace()
                .filter_map(|p| p.parse().ok())
                .collect();
            found.retain(|pid| {
                let parent = Command::new("/bin/ps")
                    .args(["-o", "ppid=", "-p", &pid.to_string()])
                    .output()
                    .unwrap();
                let parent: u32 = String::from_utf8_lossy(&parent.stdout)
                    .trim()
                    .parse()
                    .unwrap_or(0);
                let command = Command::new("/bin/ps")
                    .args(["-o", "command=", "-p", &parent.to_string()])
                    .output()
                    .unwrap();
                String::from_utf8_lossy(&command.stdout).contains(GUARD_NAME)
            });
            if let Some(pid) = found.first() {
                break *pid;
            }
            assert!(Instant::now() < deadline, "the forward did not start");
            thread::sleep(Duration::from_millis(20));
        }
    };
    tunnel.shutdown().unwrap();
    assert!(gone_within(forward, Duration::from_secs(3)));
}

/// The forward's exit and its stderr still reach the tunnel through the guard.
#[test]
fn the_guard_passes_on_the_forwards_exit_and_stderr() {
    let tunnel = Tunnel::spawn_command(
        shell("printf 'Host key verification failed' >&2; exit 255"),
        1234,
    )
    .unwrap();
    assert!(matches!(wait_exit(&tunnel), TunnelError::HostKey));
    tunnel.shutdown().unwrap();
}
