//! Product CLI paths must exit before any native window or upstream discovery.
#![allow(clippy::unwrap_used, clippy::expect_used)]
use std::{
    process::{Command, Output, Stdio},
    thread,
    time::{Duration, Instant},
};

fn cli(args: &[&str]) -> Output {
    cli_env(args, &[])
}

fn cli_env(args: &[&str], env: &[(&str, &str)]) -> Output {
    let home = tempfile::tempdir().unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_tmux-ide-gpui"))
        .args(args)
        .env_clear()
        .env("HOME", home.path())
        .envs(env.iter().copied())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if child.try_wait().unwrap().is_some() {
            let output = child.wait_with_output().unwrap();
            assert_eq!(
                std::fs::read_dir(home.path()).unwrap().count(),
                0,
                "informational/invalid paths must not initialize personal state"
            );
            return output;
        }
        if Instant::now() >= deadline {
            child.kill().unwrap();
            let output = child.wait_with_output().unwrap();
            panic!("preview CLI did not exit: {output:?}");
        }
        thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn identifies_preview_without_advertising_upstream_product_commands() {
    for flag in ["--help", "-h", "--version"] {
        let out = cli(&[flag]);
        assert!(out.status.success(), "{out:?}");
        assert!(out.stderr.is_empty());
        let text = String::from_utf8(out.stdout).unwrap();
        assert!(text.contains("tmux-ide"));
        assert!(!text.contains("--socket"));
        assert!(!text.contains("--dev"));
    }
}

#[test]
fn rejects_upstream_options_and_extra_arguments() {
    for args in [
        vec!["--socket", "/private/should-not-connect"],
        vec!["--dev"],
        vec!["--help", "extra"],
        vec!["--tmux-live-stdin", "extra"],
        vec!["--tmux-browser-helper"],
        vec!["--tmux-native-daemon"],
        vec!["--tmux-native-local", "extra"],
        vec!["--tmux-native-ssh"],
        vec!["--tmux-native-ssh", "host", "bad"],
        vec!["--tmux-native-ssh", "host", "--other", "bad"],
        vec!["--tmux-native-daemon", "/private/daemon.json", "extra"],
        vec!["--tmux-browser-helper", "node", "broker"],
        vec!["--tmux-browser-helper", "node", "broker", "host", "extra"],
        vec!["--tmux-snapshot"],
        vec!["--tmux-snapshot", "file", "bad"],
    ] {
        let out = cli(&args);
        assert_eq!(out.status.code(), Some(2), "{out:?}");
        assert!(out.stdout.is_empty());
    }
}

#[test]
fn validates_snapshot_through_dedicated_executable() {
    let fixture =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../fixtures/snapshot.json");
    let out = cli(&[
        "--tmux-snapshot",
        fixture.to_str().unwrap(),
        "--validate-only",
    ]);
    assert!(out.status.success(), "{out:?}");
    assert!(
        String::from_utf8(out.stdout)
            .unwrap()
            .contains("Validated tmux snapshot")
    );
}

#[test]
fn missing_broker_runtime_exits_before_opening_a_window() {
    let out = cli(&[
        "--tmux-browser-helper",
        "/missing-tmux-test-node",
        "broker",
        "--local",
    ]);
    assert!(!out.status.success(), "{out:?}");
    assert!(out.stdout.is_empty());
}

#[test]
fn shipped_app_without_node_names_the_dev_only_helper_route_once() {
    // The shipped launcher passes Contents/Resources/node, which is absent there;
    // a directory stands in for any path that is not a runnable file.
    let dir = tempfile::tempdir().unwrap();
    let missing = dir.path().join("Contents/Resources/node");
    for node in [missing.to_str().unwrap(), dir.path().to_str().unwrap()] {
        let out = cli(&["--tmux-browser-helper", node, "broker", "--local"]);
        assert_eq!(out.status.code(), Some(1), "{out:?}");
        assert!(out.stdout.is_empty());
        let stderr = String::from_utf8(out.stderr).unwrap();
        let message = format!(
            "the legacy helper route needs a Node.js runtime at {node}, which this app does not \
             bundle; it is available only in development bundles assembled with --node\n"
        );
        assert_eq!(stderr, message);
    }
}

#[test]
#[cfg(unix)]
fn invalid_native_ssh_input_exits_without_gui_or_discovery() {
    for args in [
        vec!["--tmux-native-ssh", "-bad"],
        vec!["--tmux-native-ssh", "host", "--environment", "bad"],
        vec![
            "--tmux-native-ssh",
            "host",
            "--local-daemon",
            "relative.json",
        ],
    ] {
        let out = cli(&args);
        assert!(!out.status.success());
        assert!(out.stdout.is_empty());
    }
}

#[test]
fn invalid_native_local_namespace_exits_before_window_or_personal_state() {
    for mode in ["invalid", "test", "development"] {
        let out = cli_env(&["--tmux-native-local"], &[("TMUX_IDE_RUNTIME_MODE", mode)]);
        assert_eq!(out.status.code(), Some(1));
        assert!(out.stdout.is_empty());
        assert!(
            String::from_utf8(out.stderr)
                .unwrap()
                .contains("invalid local runtime namespace")
        );
    }
}
