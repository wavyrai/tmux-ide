//! Product CLI paths must exit before any native window or upstream discovery.
#![allow(clippy::unwrap_used, clippy::expect_used)]
use std::{
    process::{Command, Output, Stdio},
    thread,
    time::{Duration, Instant},
};

fn cli(args: &[&str]) -> Output {
    let home = tempfile::tempdir().unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_tmux-ide-gpui"))
        .args(args)
        .env_clear()
        .env("HOME", home.path())
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
