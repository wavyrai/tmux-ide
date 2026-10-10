use super::*;

#[test]
fn worktree_registry_requires_unique_exact_branch_and_absolute_checkout() {
    let checkout = std::env::temp_dir().join("repo with spaces\nline");
    let checkout = checkout.to_str().unwrap();
    let entry = format!("worktree {checkout}\0HEAD abc\0branch refs/heads/feature\0\0");
    assert_eq!(worktree_checkout(&entry, "feature").unwrap(), checkout);
    assert!(worktree_checkout(&entry, "feat").is_err());
    assert!(
        worktree_checkout(&entry.repeat(2), "feature")
            .unwrap_err()
            .to_string()
            .contains("Multiple")
    );
    for invalid in [
        "worktree relative\0branch refs/heads/feature\0\0".to_owned(),
        format!("worktree {checkout}\0HEAD abc\0detached\0\0"),
        format!("worktree {checkout}\0branch refs/remotes/feature\0\0"),
        format!("worktree {checkout}\0bare\0\0"),
    ] {
        assert!(worktree_checkout(&invalid, "feature").is_err());
    }
}

#[cfg(unix)]
#[test]
fn subprocess_success_errors_limits_timeout_and_cancellation() {
    let deadline = || Instant::now() + Duration::from_secs(5);
    let mut command = Command::new("/bin/sh");
    command.args([
        "-c",
        "printf '%s' \"$GH_HOST:$GH_PROMPT_DISABLED:$GIT_TERMINAL_PROMPT\"",
    ]);
    assert_eq!(
        run(&mut command, deadline(), &|| false).unwrap(),
        (true, "github.com:1:0".into())
    );
    let mut command = Command::new("/bin/sh");
    command.args(["-c", "printf failure >&2; exit 1"]);
    assert_eq!(
        run(&mut command, deadline(), &|| false).unwrap(),
        (false, "failure".into())
    );
    let mut command = Command::new("/bin/sh");
    command.args(["-c", "printf '\\377'"]);
    assert!(
        run(&mut command, deadline(), &|| false).is_err(),
        "non-UTF8 Git paths must fail closed, not be lossily mapped"
    );
    // Draining OUTPUT_LIMIT costs one 10ms sleep per WouldBlock, so the wall
    // time scales with the host's socketpair buffer size. Give the limit its
    // own generous deadline: this asserts that oversized output is rejected,
    // not how fast the host refills a socket. Timeouts are asserted below.
    assert!(
        run(
            &mut Command::new("/usr/bin/yes"),
            Instant::now() + Duration::from_secs(60),
            &|| false
        )
        .unwrap_err()
        .to_string()
        .contains("size limit")
    );
    let mut sleep = Command::new("/bin/sleep");
    sleep.arg("5");
    assert!(
        run(
            &mut sleep,
            Instant::now() + Duration::from_millis(30),
            &|| false
        )
        .unwrap_err()
        .to_string()
        .contains("timed out")
    );
    assert!(
        run(&mut Command::new("/not/an/executable"), deadline(), &|| {
            true
        })
        .unwrap_err()
        .to_string()
        .contains("cancelled")
    );
    assert!(
        run(&mut Command::new("/not/an/executable"), deadline(), &|| {
            false
        })
        .unwrap_err()
        .to_string()
        .contains("install git")
    );
    let calls = std::cell::Cell::new(0);
    let mut sleep = Command::new("/bin/sleep");
    sleep.arg("5");
    assert!(
        run(&mut sleep, deadline(), &|| {
            calls.set(calls.get() + 1);
            calls.get() > 1
        })
        .unwrap_err()
        .to_string()
        .contains("cancelled")
    );
}

#[test]
fn local_git_verification_rejects_wrong_checkout_branch_and_remote_before_gh() {
    struct Directory(std::path::PathBuf);
    impl Drop for Directory {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    let suffix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let name = format!("herdr-pr-{}-{suffix}", std::process::id());
    let directory = Directory(std::env::temp_dir().join(name));
    std::fs::create_dir(&directory.0).unwrap();
    let git = |args: &[&str]| {
        let mut command = Command::new("git");
        command.arg("-C").arg(&directory.0).args(args);
        let (ok, text) = run(&mut command, Instant::now() + TIMEOUT, &|| false).unwrap();
        assert!(ok, "fixture git failed: {text}");
    };
    git(&["init", "--quiet", "--template=", "-b", "feature"]);
    git(&[
        "config",
        "--local",
        "remote.origin.url",
        "https://unsupported.invalid/example/project.git",
    ]);
    let mut input = Input {
        checkout: Some(directory.0.to_str().unwrap().into()),
        repo_key: Some(directory.0.join(".git").to_str().unwrap().into()),
        branch: "feature".into(),
    };
    assert!(
        fetch(&input, &"fixture".into(), || false)
            .unwrap_err()
            .to_string()
            .contains("GitHub.com origins only")
    );
    let mut registry_input = input.clone();
    registry_input.checkout = None;
    assert!(
        fetch(&registry_input, &"fixture".into(), || false)
            .unwrap_err()
            .to_string()
            .contains("GitHub.com origins only")
    );
    git(&[
        "config",
        "--local",
        "remote.origin.url",
        "https://github.com/example/project.git",
    ]);
    assert_eq!(
        local_repository(&registry_input, Instant::now() + TIMEOUT, &|| false).unwrap(),
        ("example".into(), "project".into())
    );
    registry_input.branch = "missing".into();
    assert!(
        local_repository(&registry_input, Instant::now() + TIMEOUT, &|| false)
            .unwrap_err()
            .to_string()
            .contains("No local worktree")
    );
    input.branch = "other".into();
    assert!(
        fetch(&input, &"fixture".into(), || false)
            .unwrap_err()
            .to_string()
            .contains("branch changed")
    );
    input.repo_key = Some(directory.0.to_str().unwrap().into());
    assert!(
        fetch(&input, &"fixture".into(), || false)
            .unwrap_err()
            .to_string()
            .contains("does not match daemon metadata")
    );
    input.checkout = Some("relative".into());
    assert!(
        fetch(&input, &"fixture".into(), || false)
            .unwrap_err()
            .to_string()
            .contains("absolute checkout")
    );
}

#[test]
fn remote_host_drops_credentials_and_path() {
    for (remote, host) in [
        ("git@github.com:owner/repo.git", "github.com"),
        ("github-work:owner_shortcode/repo", "github-work"),
        (
            "https://user:secret@github.example.com/owner/repo",
            "github.example.com",
        ),
        ("ssh://git@gitlab.com:22/owner/repo", "gitlab.com:22"),
    ] {
        assert_eq!(remote_host(remote), host, "{remote}");
    }
}

#[test]
fn github_origins_are_strictly_validated() {
    assert_eq!(
        crate::avatars::github_repo("git@github.com:Some-Owner/repo.git"),
        Some(("some-owner".into(), "repo".into()))
    );
    // Enterprise managed users own repositories under an `_shortcode` login.
    assert_eq!(
        crate::avatars::github_repo("https://github.com/fabienpenso_microsoft/repo"),
        Some(("fabienpenso_microsoft".into(), "repo".into()))
    );
    for remote in [
        "https://github.com/a/b/c",
        "https://github.com@evil.test/a/b",
        "https://other.test/a/b",
        "https://github.com/a/b?x",
    ] {
        assert!(crate::avatars::github_repo(remote).is_none());
    }
}
