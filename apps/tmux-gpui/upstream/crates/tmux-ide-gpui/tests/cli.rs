//! Informational and usage-error paths must not reach GPUI or require a desktop/daemon.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::{
    process::{Command, Output, Stdio},
    thread,
    time::{Duration, Instant},
};

fn cli(args: &[&str]) -> Output {
    cli_in(args, None)
}

/// Runs with `state` as the only state directory, and without the variables
/// a Herdr pane would set, so no running app or daemon is ever reached.
fn cli_in(args: &[&str], state: Option<&std::path::Path>) -> Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_herdr-gpui"));
    if let Some(state) = state {
        command
            .env("XDG_STATE_HOME", state)
            .env_remove("HERDR_SOCKET_PATH")
            .env_remove("HERDR_CLIENT_SOCKET_PATH")
            .env_remove("HERDR_WORKSPACE_ID")
            .env_remove("HERDR_PANE_ID");
    }
    let mut child = command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("launch the Cargo-built GUI binary");
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if child.try_wait().unwrap().is_some() {
            return child.wait_with_output().unwrap();
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let output = child.wait_with_output().unwrap();
            panic!("CLI {args:?} did not exit before timeout: {output:?}");
        }
        thread::sleep(Duration::from_millis(10));
    }
}

fn usage_error(args: &[&str], message: &str) {
    let output = cli(args);
    // An abort or native-window failure is not a successful parser rejection.
    assert_eq!(output.status.code(), Some(2), "{args:?}: {output:?}");
    assert!(output.stdout.is_empty(), "{args:?}: {output:?}");
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(stderr.contains(message), "{args:?}: {stderr}");
    assert!(stderr.contains("Usage: herdr-gpui"), "{stderr}");
}

#[test]
fn help_succeeds_and_documents_connection_options() {
    for flag in ["--help", "-h"] {
        let output = cli(&[flag]);
        assert!(output.status.success(), "{output:?}");
        assert!(output.stderr.is_empty(), "{output:?}");
        let help = String::from_utf8(output.stdout).unwrap();
        for option in [
            "--socket CLIENT_SOCKET",
            "--session NAME",
            "--dev",
            "--build-info",
        ] {
            assert!(help.contains(option), "missing {option}: {help}");
        }
        assert_eq!(
            help.contains("--integration-test"),
            cfg!(feature = "integration-test"),
            "{help}"
        );
    }
}

#[test]
fn build_info_is_pure_and_matches_compile_identity() {
    let output = cli(&["--build-info"]);
    assert!(output.status.success(), "{output:?}");
    assert!(output.stderr.is_empty(), "{output:?}");
    assert_eq!(
        String::from_utf8(output.stdout).unwrap(),
        format!(
            "worktree={}\nbranch={}\npr={}\n",
            env!("HERDR_BUILD_WORKTREE"),
            env!("HERDR_BUILD_BRANCH"),
            env!("HERDR_BUILD_PR")
        )
    );
}

#[test]
fn missing_option_values_are_usage_errors() {
    usage_error(&["--socket"], "--socket requires a path");
    usage_error(&["--session"], "--session requires a name");
    usage_error(&["--dev", "--session"], "--session requires a name");
    usage_error(&["--socket", "--help"], "--socket requires a path");
    usage_error(&["--session", "--dev"], "--session requires a name");
}

#[test]
fn duplicate_options_are_usage_errors() {
    usage_error(
        &["--socket", "a", "--socket", "b"],
        "--socket may only be specified once",
    );
    usage_error(
        &["--session", "a", "--session", "b"],
        "--session may only be specified once",
    );
}

#[test]
fn unknown_flags_and_positional_arguments_are_usage_errors() {
    for arg in ["--unknown", "--socket=/unused.sock", "unexpected", "--"] {
        usage_error(&[arg], &format!("Unknown option: {arg}"));
    }
}

#[test]
fn explicit_socket_conflicts_with_session_and_development() {
    for args in [
        vec!["--socket", "/unused.sock", "--session", "test"],
        vec!["--session", "test", "--socket", "/unused.sock"],
        vec!["--socket", "/unused.sock", "--dev"],
        vec!["--dev", "--socket", "/unused.sock"],
    ] {
        usage_error(&args, "--socket cannot be combined with --session or --dev");
    }
}

#[cfg(not(feature = "integration-test"))]
#[test]
fn native_test_flag_is_rejected_in_normal_builds() {
    usage_error(
        &["--integration-test"],
        "Unknown option: --integration-test",
    );
    usage_error(
        &["--socket", "/unused.sock", "--integration-test"],
        "Unknown option: --integration-test",
    );
}

#[cfg(feature = "integration-test")]
#[test]
fn native_test_flag_requires_explicit_socket_not_session_discovery() {
    for args in [
        vec!["--integration-test"],
        vec!["--integration-test", "--session", "test"],
        vec!["--dev", "--integration-test"],
        vec!["--session", "test", "--dev", "--integration-test"],
    ] {
        usage_error(&args, "--integration-test requires an explicit --socket");
    }
}

#[test]
fn browser_commands_answer_without_a_window() {
    let output = cli(&["browser", "--help"]);
    assert!(output.status.success(), "{output:?}");
    let help = String::from_utf8(output.stdout).unwrap();
    assert!(help.contains("browser open URL"), "{help}");
    assert!(help.contains("3 Herdr GPUI not running"), "{help}");

    let output = cli(&["browser", "skill"]);
    assert!(output.status.success(), "{output:?}");
    let skill = String::from_utf8(output.stdout).unwrap();
    assert!(
        skill.starts_with("---\nname: herdr-gpui-browser\n"),
        "{skill}"
    );
    // The skill names this very executable, which need not be on PATH. The
    // path may be shell-quoted, as Windows paths always are.
    let exe = std::path::Path::new(env!("CARGO_BIN_EXE_herdr-gpui"));
    let name = exe.file_name().unwrap().to_str().unwrap();
    let command = skill
        .lines()
        .find(|line| line.contains(" browser open http"))
        .unwrap_or_else(|| panic!("{skill}"));
    assert!(
        command.contains(&format!("{name} browser open"))
            || command.contains(&format!("{name}' browser open")),
        "{command}"
    );
    assert!(!command.starts_with("herdr-gpui browser"), "{command}");

    usage_error(&["browser", "open"], "browser open requires one URL");
    usage_error(&["browser", "eval"], "Unknown browser command: eval");
}

#[test]
fn browser_open_reports_a_missing_app_and_a_refused_address() {
    // Short, because the control socket inside must fit a Unix socket path.
    let parent = if cfg!(unix) {
        std::path::PathBuf::from("/tmp")
    } else {
        std::env::temp_dir()
    };
    let state = tempfile::Builder::new()
        .prefix("hgs")
        .tempdir_in(parent)
        .unwrap();
    let output = cli_in(
        &["browser", "open", "file:///etc/passwd"],
        Some(state.path()),
    );
    assert_eq!(output.status.code(), Some(2), "{output:?}");
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("http and https"),
        "{output:?}"
    );
    let output = cli_in(&["browser", "open", "localhost:3000"], Some(state.path()));
    if cfg!(unix) {
        assert_eq!(output.status.code(), Some(3), "{output:?}");
        assert!(
            String::from_utf8_lossy(&output.stderr).contains("not running"),
            "{output:?}"
        );
    } else {
        assert_eq!(output.status.code(), Some(1), "{output:?}");
    }
    assert!(output.stdout.is_empty(), "{output:?}");
}

#[test]
fn local_pages_and_feedback_need_the_app_and_a_plain_folder() {
    let parent = if cfg!(unix) {
        std::path::PathBuf::from("/tmp")
    } else {
        std::env::temp_dir()
    };
    let state = tempfile::Builder::new()
        .prefix("hgs")
        .tempdir_in(&parent)
        .unwrap();
    let site = tempfile::Builder::new()
        .prefix("hgp")
        .tempdir_in(&parent)
        .unwrap();
    let page = site.path().join("mockup.html");
    std::fs::write(&page, "<h1>draft</h1>").unwrap();
    let hidden = site.path().join(".drafts");
    std::fs::create_dir(&hidden).unwrap();
    std::fs::write(hidden.join("secret.html"), "x").unwrap();
    let page = page.to_str().unwrap();
    let hidden_page = hidden.join("secret.html");

    // A plain file is accepted and only the missing app stops it.
    let output = cli_in(&["browser", "open", page], Some(state.path()));
    let expected = if cfg!(unix) { 3 } else { 1 };
    assert_eq!(output.status.code(), Some(expected), "{output:?}");

    // A file in a hidden folder is never served.
    let output = cli_in(
        &["browser", "open", hidden_page.to_str().unwrap()],
        Some(state.path()),
    );
    assert_eq!(output.status.code(), Some(2), "{output:?}");

    // Feedback belongs to the pane that opened the page.
    let output = cli_in(&["browser", "feedback"], Some(state.path()));
    assert_eq!(output.status.code(), Some(1), "{output:?}");
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("runs in the Herdr pane"),
        "{output:?}"
    );
    usage_error(
        &["browser", "feedback", "--wait", "soon"],
        "--wait requires a number of seconds",
    );
}
