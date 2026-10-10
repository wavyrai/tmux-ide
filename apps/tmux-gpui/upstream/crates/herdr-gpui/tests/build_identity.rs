#![allow(clippy::unwrap_used, clippy::expect_used)]

// `lookup_pr` is exercised through a POSIX mock executable, so it has no caller
// in this binary elsewhere.
#[cfg_attr(not(unix), allow(dead_code))]
#[path = "../build_identity.rs"]
mod build_identity;

#[cfg_attr(not(unix), allow(unused_imports))]
use build_identity::*;
#[cfg(unix)]
use std::time::{Duration, Instant};
use std::{
    fs,
    path::PathBuf,
    process::Command,
    sync::atomic::{AtomicUsize, Ordering},
};

struct Sandbox(PathBuf);
impl Sandbox {
    fn new() -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let path = std::env::temp_dir().join(format!(
            "herdr-build-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        // Git cannot create worktrees through Windows verbatim (\\?\) paths.
        // Canonicalize only when comparing existing paths, not before passing args.
        Self(path)
    }

    fn git(&self, args: &[&str]) {
        let output = Command::new("git")
            .current_dir(&self.0)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .args(args)
            .output()
            .unwrap();
        assert!(output.status.success(), "{output:?}");
    }

    fn init(&self) {
        self.git(&["init", "-b", "main"]);
        self.git(&[
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.invalid",
            "-c",
            "commit.gpgsign=false",
            "commit",
            "--allow-empty",
            "-m",
            "initial",
        ]);
    }
}
impl Drop for Sandbox {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn watches(identity: &Identity, path: &std::path::Path) -> bool {
    // Git output and canonical paths use different Windows path prefixes.
    let path = path.canonicalize().unwrap();
    identity
        .watched
        .iter()
        .any(|p| p.canonicalize().unwrap() == path)
}

#[test]
fn real_linked_worktree_branch_detached_and_metadata() {
    let repo = Sandbox::new();
    assert!(!detect(&repo.0).worktree);
    assert!(detect(&repo.0).watched.is_empty());
    repo.init();
    assert!(!detect(&repo.0).worktree);
    assert_eq!(detect(&repo.0).branch, "");
    let linked = repo.0.join("linked");
    repo.git(&[
        "worktree",
        "add",
        "-b",
        "feature/test",
        linked.to_str().unwrap(),
    ]);
    let manifest = linked.join("crates/gui");
    fs::create_dir_all(&manifest).unwrap();
    let identity = detect(&manifest);
    assert!(identity.worktree);
    assert!(!identity.detached);
    assert_eq!(identity.branch, "feature/test");
    assert!(
        identity
            .watched
            .iter()
            .any(|p| p.ends_with("refs/heads/feature/test"))
    );
    assert!(identity.watched.iter().all(|p| p.is_file()));
    assert!(watches(&identity, &linked.join(".git")));
    assert!(!identity.watched.iter().any(|p| p.ends_with("packed-refs")));
    assert!(!watches(&detect(&repo.0), &repo.0.join(".git")));
    assert!(
        identity
            .watched
            .iter()
            .any(|p| p.ends_with("HEAD") && p.is_file())
    );
    repo.git(&["-C", linked.to_str().unwrap(), "checkout", "-b", "other"]);
    assert_eq!(detect(&manifest).branch, "other");
    repo.git(&["-C", linked.to_str().unwrap(), "checkout", "--detach"]);
    let identity = detect(&manifest);
    assert!(identity.worktree && identity.detached);
    assert!(identity.branch.len() >= 7 && identity.branch.bytes().all(|b| b.is_ascii_hexdigit()));
}

#[test]
fn packed_refs_watch_existing_parent_for_loose_ref_creation() {
    let repo = Sandbox::new();
    repo.init();
    let linked = repo.0.join("linked");
    repo.git(&[
        "worktree",
        "add",
        "-b",
        "feature/nested/test",
        linked.to_str().unwrap(),
    ]);
    repo.git(&["pack-refs", "--all", "--prune"]);
    let identity = detect(&linked);
    assert_eq!(identity.branch, "feature/nested/test");
    assert!(identity.watched.iter().all(|p| p.exists()));
    assert!(watches(&identity, &repo.0.join(".git/packed-refs")));
    let loose = repo.0.join(".git/refs/heads/feature/nested/test");
    assert!(!loose.exists());
    assert!(
        !identity
            .watched
            .iter()
            .any(|p| p.ends_with("refs/heads/feature/nested/test"))
    );
    let parent = loose.ancestors().skip(1).find(|p| p.is_dir()).unwrap();
    assert!(watches(&identity, parent));
    repo.git(&[
        "-C",
        linked.to_str().unwrap(),
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "--allow-empty",
        "-m",
        "loose",
    ]);
    assert!(loose.is_file());
    assert!(watches(&detect(&linked), &loose));
}

#[test]
fn branch_unicode_whitespace_is_preserved_and_controls_fall_back_to_sha() {
    let repo = Sandbox::new();
    repo.init();
    let linked = repo.0.join("linked");
    let branch = "feature/caf\u{e9}\u{2003}";
    repo.git(&["worktree", "add", "-b", branch, linked.to_str().unwrap()]);
    let identity = detect(&linked);
    assert_eq!(identity.branch, branch);
    assert!(watches(
        &identity,
        &repo.0.join(".git/refs/heads").join(branch)
    ));
    repo.git(&[
        "-C",
        linked.to_str().unwrap(),
        "checkout",
        "-b",
        "feature/control-\u{85}",
    ]);
    let identity = detect(&linked);
    assert!(identity.worktree && !identity.detached);
    let sha = Command::new("git")
        .current_dir(&linked)
        .args(["rev-parse", "--short", "HEAD"])
        .output()
        .unwrap();
    assert_eq!(format!("{}\n", identity.branch).as_bytes(), sha.stdout);
}

#[test]
fn second_cargo_build_is_fresh_for_archive_ordinary_and_linked_checkouts() {
    let repo = Sandbox::new();
    let build_twice = |path: &std::path::Path| {
        fs::create_dir_all(path.join("src")).unwrap();
        fs::write(path.join("Cargo.toml"), "[package]\nname = \"identity-fixture\"\nversion = \"0.0.0\"\nedition = \"2024\"\n[workspace]\n").unwrap();
        fs::write(
            path.join("src/main.rs"),
            "fn main() { println!(\"{}\", env!(\"HERDR_BUILD_BRANCH\")); }\n",
        )
        .unwrap();
        fs::write(path.join("build.rs"), include_str!("../build.rs")).unwrap();
        fs::write(
            path.join("build_identity.rs"),
            include_str!("../build_identity.rs"),
        )
        .unwrap();
        for attempt in 0..2 {
            let mut command = Command::new(env!("CARGO"));
            command
                .current_dir(path)
                .args(["build", "--offline", "--message-format=json"])
                .env("CARGO_TARGET_DIR", path.join("target"))
                .env("HERDR_BUILD_PR_NUMBER", "");
            if attempt == 1 {
                command.arg("--locked");
            }
            let output = command.output().unwrap();
            assert!(output.status.success(), "{output:?}");
            if attempt == 1 {
                let stdout = String::from_utf8(output.stdout).unwrap();
                let artifacts: Vec<_> = stdout
                    .lines()
                    .filter(|line| line.contains("\"reason\":\"compiler-artifact\""))
                    .collect();
                assert!(!artifacts.is_empty(), "{stdout}");
                assert!(
                    artifacts.iter().all(|line| line.contains("\"fresh\":true")),
                    "{stdout}"
                );
            }
        }
    };
    build_twice(&repo.0);
    repo.init();
    build_twice(&repo.0);
    let linked = repo.0.join("linked");
    repo.git(&[
        "worktree",
        "add",
        "-b",
        "feature/test",
        linked.to_str().unwrap(),
    ]);
    build_twice(&linked);
    repo.git(&["pack-refs", "--all", "--prune"]);
    build_twice(&linked);
}

#[test]
fn pr_validation() {
    for value in ["", "1", "123", "001"] {
        assert_eq!(validate_pr(value), Some(value));
    }
    for value in ["0", "000", "-1", "+1", " 1", "1\n", "abc", "1;id"] {
        assert_eq!(validate_pr(value), None);
    }
}

#[test]
fn separate_git_directory_is_not_a_linked_worktree() {
    let repo = Sandbox::new();
    let metadata = repo.0.join("metadata");
    let checkout = repo.0.join("checkout");
    repo.git(&[
        "init",
        "--separate-git-dir",
        metadata.to_str().unwrap(),
        checkout.to_str().unwrap(),
    ]);
    let identity = detect(&checkout);
    assert!(!identity.worktree);
    assert_eq!(identity.branch, "");
}

#[test]
fn missing_git_is_stable() {
    if std::env::var_os("HERDR_TEST_WITHOUT_GIT").is_some() {
        let repo = Sandbox::new();
        let identity = detect(&repo.0);
        assert!(!identity.worktree);
        assert_eq!(identity.branch, "");
        return;
    }
    let output = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "missing_git_is_stable"])
        .env("PATH", "")
        .env("HERDR_TEST_WITHOUT_GIT", "1")
        .output()
        .unwrap();
    assert!(output.status.success(), "{output:?}");
}

#[cfg(unix)]
#[test]
fn mock_gh_is_anchored_explicit_validated_and_bounded() {
    use std::os::unix::fs::PermissionsExt;
    // A sibling test thread that forks while a mock is being written keeps a
    // write descriptor on it until its own exec, and Linux then refuses to run
    // the mock with ETXTBSY; lookup_pr reports that unusable command as None.
    // Run the checks where nothing else forks between writing and running.
    if std::env::var_os("HERDR_TEST_MOCK_GH").is_none() {
        let output = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "mock_gh_is_anchored_explicit_validated_and_bounded",
                "--nocapture",
            ])
            .env("HERDR_TEST_MOCK_GH", "1")
            .output()
            .unwrap();
        assert!(output.status.success(), "{output:?}");
        return;
    }
    let repo = Sandbox::new();
    let gh = repo.0.join("gh");
    fs::write(&gh, format!("#!/bin/sh\n[ \"$PWD\" = '{}' ] || exit 1\n[ \"$#\" = 12 ] || exit 2\n[ \"$1 $2 $3\" = 'pr list --head' ] || exit 3\ncase \"$4\" in feature/test|123|'#123') ;; *) exit 4 ;; esac\nshift 4\n[ \"$*\" = '--state open --limit 1 --json number --jq .[0].number' ] || exit 5\nprintf '42\\n'\n", repo.0.canonicalize().unwrap().display())).unwrap();
    fs::set_permissions(&gh, fs::Permissions::from_mode(0o755)).unwrap();
    // These cases assert argument anchoring, validation, and output bounds, not
    // how fast a loaded runner spawns /bin/sh; the deadline is exercised below.
    let ample = Duration::from_secs(30);
    for branch in ["feature/test", "123", "#123"] {
        assert_eq!(lookup_pr(&repo.0, branch, &gh, ample), Some("42".into()));
    }
    for body in [
        "printf 'null\\n'",
        "printf '\\n'",
        "printf '0\\n'",
        "exit 1",
        "printf '42\\n99\\n'",
    ] {
        fs::write(&gh, format!("#!/bin/sh\n{body}\n")).unwrap();
        assert_eq!(lookup_pr(&repo.0, "feature/test", &gh, ample), None);
    }
    fs::write(&gh, "#!/bin/sh\nexec sleep 30\n").unwrap();
    let start = Instant::now();
    assert_eq!(
        lookup_pr(&repo.0, "feature/test", &gh, Duration::from_millis(30)),
        None
    );
    assert!(start.elapsed() < Duration::from_secs(2));
    assert_eq!(
        lookup_pr(&repo.0, "feature/test", &repo.0.join("missing"), ample),
        None
    );
}
