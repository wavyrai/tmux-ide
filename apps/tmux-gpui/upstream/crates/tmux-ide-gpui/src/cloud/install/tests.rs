#![allow(clippy::unwrap_used)]
use super::*;

/// Stand in for `coder ssh`: run the appended remote command locally.
fn local(home: &std::path::Path) -> Command {
    let mut command = Command::new("/bin/sh");
    command
        .arg("-c")
        .arg(r#"eval "$1""#)
        .arg("sh")
        .env_clear()
        .env("HOME", home)
        .env("PATH", "/usr/bin:/bin");
    command
}

#[test]
fn the_probe_finds_herdr_where_the_bridge_looks() {
    use std::os::unix::fs::PermissionsExt;
    let home = tempfile::tempdir().unwrap();
    // The fixed roots are system-wide; this host may already have Herdr there.
    let system = [
        "/opt/homebrew/bin/herdr",
        "/usr/local/bin/herdr",
        "/home/linuxbrew/.linuxbrew/bin/herdr",
        "/nix/var/nix/profiles/default/bin/herdr",
        "/run/current-system/sw/bin/herdr",
    ]
    .iter()
    .any(|path| std::path::Path::new(path).exists());
    if !system {
        assert!(!installed(local(home.path()), &|| false).unwrap());
    }
    let bin = home.path().join(".local/bin");
    std::fs::create_dir_all(&bin).unwrap();
    std::fs::write(bin.join("herdr"), "#!/bin/sh\n").unwrap();
    std::fs::set_permissions(bin.join("herdr"), std::fs::Permissions::from_mode(0o755)).unwrap();
    assert!(installed(local(home.path()), &|| false).unwrap());
}

#[test]
fn failures_report_the_output_tail_without_terminal_escapes() {
    // One stream: stdout and stderr drain on separate threads, so their
    // interleaving is not ordered.
    let mut failing = Command::new("/bin/sh");
    failing.args([
        "-c",
        r#"{ for i in 1 2 3 4 5 6 7 8; do echo "line $i"; done; printf '\033[31mboom\033[0m\n'; } >&2; exit 9; #"#,
    ]);
    let Err(Error::Install(text)) = install(failing, &|| false) else {
        panic!("expected an install failure");
    };
    assert!(text.ends_with("boom"), "{text}");
    assert!(!text.contains('\u{1b}'));
    assert_eq!(text.lines().count(), TAIL_LINES);
    assert!(!text.contains("line 1\n"));
}

#[test]
fn a_missing_curl_is_named_and_cancellation_kills_the_child() {
    let mut no_curl = Command::new("/bin/sh");
    no_curl.args(["-c", "exit 4; #"]);
    let Err(Error::Install(text)) = install(no_curl, &|| false) else {
        panic!("expected an install failure");
    };
    assert!(text.contains("curl"));
    // `sleep` is not the script's last command, so every shell forks it: a
    // grandchild that still holds the output pipes after the child is
    // killed. Cancelling only once it has had time to start makes that so.
    let mut slow = Command::new("/bin/sh");
    slow.args(["-c", "sleep 30; exit 0; #"]);
    let started = Instant::now();
    let cancelled = || started.elapsed() >= Duration::from_millis(500);
    assert!(matches!(install(slow, &cancelled), Err(Error::Cancelled)));
    assert!(started.elapsed() < Duration::from_secs(5));
}

#[test]
fn output_is_bounded() {
    let mut chatty = Command::new("/bin/sh");
    chatty.args(["-c", "yes | head -c 1000000; exit 1; #"]);
    let Err(Error::Install(text)) = install(chatty, &|| false) else {
        panic!("expected an install failure");
    };
    assert!(text.len() <= OUTPUT_LIMIT);
}
