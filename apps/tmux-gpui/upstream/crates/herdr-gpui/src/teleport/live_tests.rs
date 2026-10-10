//! Opt-in: a real teleport between two isolated Herdr daemons on this
//! machine. Requires `HERDR_TEST_BINARY` (see AGENTS.md); SSH is not used,
//! each "host" is a local host whose scripts address its own daemon.

use super::{
    error::Step,
    host::Host,
    job::{self, Destination, HostRepositories, Place, Repository, Retired, Source},
    remote::MatchReason,
    snapshot::{HostSnapshot, ProcessInfoResult, SnapshotResult},
};
use herdr_client::ConnectTarget;
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::atomic::AtomicBool,
    thread,
    time::{Duration, Instant},
};

struct Daemon {
    dir: PathBuf,
    child: Option<Child>,
    host: Host,
}

impl Daemon {
    fn start(binary: &Path, name: &str) -> Self {
        let parent = std::env::var_os("HERDR_TEST_TMPDIR")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        let dir = parent.join(format!("tp{}{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let dir = dir.canonicalize().unwrap();
        fs::write(
            dir.join("config.toml"),
            "onboarding = false\n[terminal]\ndefault_shell = \"/bin/sh\"\nshell_mode = \"non_login\"\n",
        )
        .unwrap();
        let env: Vec<(String, String)> = [
            ("HOME", dir.clone()),
            ("XDG_CONFIG_HOME", dir.join("config")),
            ("XDG_STATE_HOME", dir.join("state")),
            ("XDG_DATA_HOME", dir.join("data")),
            ("XDG_CACHE_HOME", dir.join("cache")),
            ("XDG_RUNTIME_DIR", dir.clone()),
            ("TMPDIR", dir.clone()),
            ("HERDR_CONFIG_PATH", dir.join("config.toml")),
            ("HERDR_SOCKET_PATH", dir.join("a.sock")),
            ("HERDR_CLIENT_SOCKET_PATH", dir.join("a-client.sock")),
            ("SHELL", "/bin/sh".into()),
            // The prelude prepends user tool directories; this keeps `herdr`
            // resolving to the binary under test.
            (
                "PATH",
                PathBuf::from(format!(
                    "{}:/usr/bin:/bin",
                    binary.parent().unwrap().display()
                )),
            ),
        ]
        .into_iter()
        .map(|(key, value)| (key.to_owned(), value.to_string_lossy().into_owned()))
        .collect();
        let child = Command::new(binary)
            .arg("server")
            .env_clear()
            .envs(env.iter().map(|(k, v)| (k, v)))
            .env("TERM", "xterm-256color")
            .current_dir(&dir)
            .stdin(Stdio::null())
            .stdout(fs::File::create(dir.join("server.log")).unwrap())
            .stderr(fs::File::create(dir.join("server.err")).unwrap())
            .spawn()
            .unwrap();
        let mut host = Host::new(&ConnectTarget::Local).unwrap();
        host.env = env;
        // Own the child before waiting, so a failed startup still stops it.
        let daemon = Self {
            dir,
            child: Some(child),
            host,
        };
        let deadline = Instant::now() + Duration::from_secs(20);
        while !daemon.dir.join("a.sock").exists() {
            assert!(
                Instant::now() < deadline,
                "daemon startup timed out: {}",
                fs::read_to_string(daemon.dir.join("server.err")).unwrap_or_default()
            );
            thread::sleep(Duration::from_millis(20));
        }
        daemon
    }

    fn herdr(&self, args: &[&str]) -> serde_json::Value {
        self.host
            .herdr(Step::Review, args, &AtomicBool::new(false))
            .unwrap()
    }

    fn snapshot(&self) -> HostSnapshot {
        let result: SnapshotResult = self
            .host
            .herdr(Step::Review, &["api", "snapshot"], &AtomicBool::new(false))
            .unwrap();
        result.snapshot
    }
}

impl Drop for Daemon {
    fn drop(&mut self) {
        // Only the exact child this test started; never discovery or `server stop`.
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        let _ = fs::remove_dir_all(&self.dir);
    }
}

fn git(dir: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_AUTHOR_NAME", "t")
        .env("GIT_AUTHOR_EMAIL", "t@t")
        .env("GIT_COMMITTER_NAME", "t")
        .env("GIT_COMMITTER_EMAIL", "t@t")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).into_owned()
}

fn wait_for(what: &str, mut ready: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(20);
    while !ready() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        thread::sleep(Duration::from_millis(100));
    }
}

fn running(daemon: &Daemon, pane: &str) -> Option<Vec<String>> {
    let info: ProcessInfoResult = daemon
        .host
        .herdr(
            Step::Review,
            &["pane", "process-info", "--pane", pane],
            &AtomicBool::new(false),
        )
        .ok()?;
    info.process_info
        .foreground_job()
        .map(|job| job.argv.clone())
}

#[test]
#[ignore = "requires HERDR_TEST_BINARY and starts two isolated daemons"]
fn teleport_between_two_daemons() {
    let binary =
        PathBuf::from(std::env::var_os("HERDR_TEST_BINARY").expect("set HERDR_TEST_BINARY"));
    assert!(binary.is_absolute() && binary.is_file());
    let a = Daemon::start(&binary, "a");
    let b = Daemon::start(&binary, "b");

    // One upstream, cloned on both hosts with the same origin URL.
    let upstream = a.dir.join("upstream");
    fs::create_dir(&upstream).unwrap();
    git(&upstream, &["init", "-q", "-b", "main"]);
    fs::write(upstream.join("README"), "base\n").unwrap();
    git(&upstream, &["add", "-A"]);
    git(&upstream, &["commit", "-q", "-m", "base"]);
    let clone = |daemon: &Daemon| {
        let repo = daemon.dir.join("app");
        git(
            &daemon.dir,
            &["clone", "-q", upstream.to_str().unwrap(), "app"],
        );
        git(
            &repo,
            &["remote", "set-url", "origin", "git@example.com:me/app.git"],
        );
        repo
    };
    let (repo_a, repo_b) = (clone(&a), clone(&b));
    let main_a = a.herdr(&[
        "workspace",
        "create",
        "--cwd",
        repo_a.to_str().unwrap(),
        "--no-focus",
    ]);
    let main_b = b.herdr(&[
        "workspace",
        "create",
        "--cwd",
        repo_b.to_str().unwrap(),
        "--no-focus",
    ]);
    let main_a = main_a["workspace"]["workspace_id"]
        .as_str()
        .unwrap()
        .to_owned();
    let main_b = main_b["workspace"]["workspace_id"]
        .as_str()
        .unwrap()
        .to_owned();

    // The source worktree: a commit, uncommitted work, two tabs, a split,
    // and a long-running command in a subdirectory.
    let created = a.herdr(&[
        "worktree",
        "create",
        "--workspace",
        &main_a,
        "--branch",
        "feat",
        "--no-focus",
    ]);
    let source_ws = created["workspace"]["workspace_id"]
        .as_str()
        .unwrap()
        .to_owned();
    let checkout = PathBuf::from(created["worktree"]["path"].as_str().unwrap());
    let root_pane = created["root_pane"]["pane_id"].as_str().unwrap().to_owned();
    fs::write(checkout.join("feature.txt"), "committed\n").unwrap();
    git(&checkout, &["add", "-A"]);
    git(&checkout, &["commit", "-q", "-m", "feature"]);
    fs::write(checkout.join("README"), "base\nedited\n").unwrap();
    fs::create_dir(checkout.join("sub")).unwrap();
    fs::write(checkout.join("sub/new.txt"), "untracked\n").unwrap();
    let sub = checkout.join("sub");
    a.herdr(&[
        "pane",
        "split",
        &root_pane,
        "--direction",
        "right",
        "--ratio",
        "0.7",
        "--cwd",
        sub.to_str().unwrap(),
        "--no-focus",
    ]);
    let tab = a.herdr(&[
        "tab",
        "create",
        "--workspace",
        &source_ws,
        "--cwd",
        checkout.to_str().unwrap(),
        "--no-focus",
    ]);
    let second_root = tab["root_pane"]["pane_id"].as_str().unwrap().to_owned();
    a.host
        .herdr_ok(
            Step::Launch,
            &["pane", "run", &second_root, "cd sub && sleep 3600"],
            &AtomicBool::new(false),
        )
        .unwrap();
    wait_for("the source command", || {
        running(&a, &second_root).is_some_and(|argv| argv.first().is_some_and(|p| p == "sleep"))
    });

    let place = |daemon: &Daemon, id: &str| Place {
        endpoint_id: id.into(),
        label: id.into(),
        host: daemon.host.clone(),
    };
    let key = |repo: &Path| repo.join(".git").to_string_lossy().into_owned();
    let source = Source {
        place: place(&a, "a"),
        workspace_id: source_ws.clone(),
        custom_label: None,
        repo_key: key(&repo_a),
        repo_label: "app".into(),
        branch: Some("feat".into()),
        tab_labels: HashMap::from([(
            tab["tab"]["tab_id"].as_str().unwrap().to_owned(),
            "server".to_owned(),
        )]),
    };
    let cancelled = AtomicBool::new(false);
    let resolved = job::resolve(
        &source,
        &HostRepositories {
            place: place(&b, "b"),
            repositories: Some(vec![Repository {
                key: key(&repo_b),
                label: "app".into(),
                workspace_id: main_b.clone(),
            }]),
            retired: Vec::new(),
        },
        &cancelled,
    )
    .unwrap();
    let candidate = &resolved;
    assert!(matches!(
        candidate.destination,
        Destination::Open {
            reason: MatchReason::Origin,
            ..
        }
    ));

    let review = job::review(&source, candidate, &cancelled).unwrap();
    assert_eq!(review.branch, "feat");
    assert_eq!(review.tabs.len(), 2);
    let source_status = git(
        &checkout,
        &["status", "--porcelain=v1", "--untracked-files=all"],
    );

    let mut steps = Vec::new();
    let outcome = job::run(
        &source,
        candidate,
        &review,
        |step| steps.push(step),
        &cancelled,
    )
    .unwrap();
    assert!(outcome.warnings.is_empty(), "{:?}", outcome.warnings);
    assert!(steps.contains(&Step::Launch));

    // Source: the workspace stays with one idle "teleported" tab; the
    // programs it ran are gone and the checkout is untouched.
    let tabs = a.snapshot().tabs_of(&source_ws).len();
    assert_eq!(tabs, 1);
    let kept = a.herdr(&["tab", "list", "--workspace", &source_ws]);
    assert_eq!(kept["tabs"][0]["label"], "teleported");
    assert!(checkout.join("sub/new.txt").exists());

    // Destination: same commit, same uncommitted state, same tabs and layout.
    let snapshot = b.snapshot();
    let moved = snapshot.workspace(&outcome.workspace_id).unwrap();
    let moved_checkout = PathBuf::from(&moved.worktree.as_ref().unwrap().checkout_path);
    assert_eq!(
        git(&moved_checkout, &["rev-parse", "HEAD"]),
        git(&checkout, &["rev-parse", "HEAD"])
    );
    assert_eq!(
        git(
            &moved_checkout,
            &["status", "--porcelain=v1", "--untracked-files=all"]
        ),
        source_status
    );
    let tabs = snapshot.tabs_of(&outcome.workspace_id);
    assert_eq!(tabs.len(), 2);
    let first = snapshot.layout(&tabs[0].tab_id).unwrap();
    assert_eq!(first.panes.len(), 2);
    assert!((first.splits[0].ratio - 0.7).abs() < 0.01);
    let split_pane = first.panes.iter().find(|p| p.rect.x > 0).unwrap();
    assert_eq!(
        snapshot.pane(&split_pane.pane_id).unwrap().cwd.as_deref(),
        Some(moved_checkout.join("sub").to_str().unwrap())
    );
    // The command runs again, in the same relative directory.
    let second = &snapshot
        .panes
        .iter()
        .find(|p| p.tab_id == tabs[1].tab_id)
        .unwrap()
        .pane_id;
    wait_for("the destination command", || {
        running(&b, second).is_some_and(|argv| argv == ["sleep", "3600"])
    });
    let tab_list = b.herdr(&["tab", "list", "--workspace", &outcome.workspace_id]);
    assert_eq!(tab_list["tabs"][1]["label"], "server");

    // Teleport back: the checkout the work left is reused, not duplicated.
    fs::write(moved_checkout.join("more.txt"), "from b\n").unwrap();
    let back = Source {
        place: place(&b, "b"),
        workspace_id: outcome.workspace_id.clone(),
        custom_label: None,
        repo_key: key(&repo_b),
        repo_label: "app".into(),
        branch: Some("feat".into()),
        tab_labels: HashMap::new(),
    };
    let resolved = job::resolve(
        &back,
        &HostRepositories {
            place: place(&a, "a"),
            repositories: Some(vec![Repository {
                key: key(&repo_a),
                label: "app".into(),
                workspace_id: main_a.clone(),
            }]),
            retired: vec![Retired {
                repo_key: key(&repo_a),
                branch: "feat".into(),
                workspace_id: source_ws.clone(),
            }],
        },
        &cancelled,
    )
    .unwrap();
    let home = &resolved;
    assert!(matches!(home.destination, Destination::Reclaim { .. }));
    let review = job::review(&back, home, &cancelled).unwrap();
    let returned = job::run(&back, home, &review, |_| {}, &cancelled).unwrap();
    assert!(returned.warnings.is_empty(), "{:?}", returned.warnings);
    assert_eq!(returned.workspace_id, source_ws);
    assert_eq!(
        fs::read_to_string(checkout.join("more.txt")).unwrap(),
        "from b\n"
    );
    assert_eq!(
        git(&checkout, &["rev-parse", "HEAD"]),
        git(&moved_checkout, &["rev-parse", "HEAD"])
    );
    // Its tabs are rebuilt and the "teleported" tab is gone.
    let snapshot = a.snapshot();
    assert_eq!(snapshot.tabs_of(&source_ws).len(), 2);
    let tabs = a.herdr(&["tab", "list", "--workspace", &source_ws]);
    assert_ne!(tabs["tabs"][0]["label"], "teleported");
    assert!(!git(&repo_a, &["for-each-ref", "refs/herdr-teleport/backup"]).is_empty());
}

#[test]
#[ignore = "requires HERDR_TEST_BINARY and starts two isolated daemons"]
fn teleport_copies_the_repository_where_it_is_missing() {
    let binary =
        PathBuf::from(std::env::var_os("HERDR_TEST_BINARY").expect("set HERDR_TEST_BINARY"));
    let a = Daemon::start(&binary, "c");
    let b = Daemon::start(&binary, "d");

    let repo = a.dir.join("code/app");
    fs::create_dir_all(&repo).unwrap();
    git(&repo, &["init", "-q", "-b", "main"]);
    fs::write(repo.join("README"), "base\n").unwrap();
    git(&repo, &["add", "-A"]);
    git(&repo, &["commit", "-q", "-m", "base"]);
    // Unresolvable, so the destination cannot clone from origin and the
    // repository is copied from the source instead.
    git(
        &repo,
        &[
            "remote",
            "add",
            "origin",
            "https://example.invalid/me/app.git",
        ],
    );
    let main = a.herdr(&[
        "workspace",
        "create",
        "--cwd",
        repo.to_str().unwrap(),
        "--no-focus",
    ]);
    let main = main["workspace"]["workspace_id"]
        .as_str()
        .unwrap()
        .to_owned();
    let created = a.herdr(&[
        "worktree",
        "create",
        "--workspace",
        &main,
        "--branch",
        "feat",
        "--no-focus",
    ]);
    let source_ws = created["workspace"]["workspace_id"]
        .as_str()
        .unwrap()
        .to_owned();
    let checkout = PathBuf::from(created["worktree"]["path"].as_str().unwrap());
    fs::write(checkout.join("feature.txt"), "committed\n").unwrap();
    git(&checkout, &["add", "-A"]);
    git(&checkout, &["commit", "-q", "-m", "feature"]);
    fs::write(checkout.join("notes.txt"), "untracked\n").unwrap();

    let source = Source {
        place: Place {
            endpoint_id: "c".into(),
            label: "c".into(),
            host: a.host.clone(),
        },
        workspace_id: source_ws.clone(),
        custom_label: None,
        repo_key: repo.join(".git").to_string_lossy().into_owned(),
        repo_label: "app".into(),
        branch: Some("feat".into()),
        tab_labels: HashMap::new(),
    };
    let cancelled = AtomicBool::new(false);
    // No GUI snapshot: the host is read through its CLI, as when disconnected.
    let resolved = job::resolve(
        &source,
        &HostRepositories {
            place: Place {
                endpoint_id: "d".into(),
                label: "d".into(),
                host: b.host.clone(),
            },
            repositories: None,
            retired: Vec::new(),
        },
        &cancelled,
    )
    .unwrap();
    let place = b.dir.join("code/app");
    let candidate = &resolved;
    assert_eq!(
        candidate.destination,
        Destination::Arrive(super::provision::Arrival::Clone {
            path: place.to_string_lossy().into_owned()
        })
    );

    let review = job::review(&source, candidate, &cancelled).unwrap();
    let outcome = job::run(&source, candidate, &review, |_| {}, &cancelled).unwrap();
    assert!(outcome.warnings.is_empty(), "{:?}", outcome.warnings);

    let snapshot = b.snapshot();
    let opened = job::repositories_of(&snapshot);
    assert_eq!(opened.len(), 1, "the copied repository is open as a space");
    assert_eq!(
        git(&place, &["remote", "get-url", "origin"]).trim(),
        "https://example.invalid/me/app.git"
    );
    let moved = snapshot.workspace(&outcome.workspace_id).unwrap();
    let moved_checkout = PathBuf::from(&moved.worktree.as_ref().unwrap().checkout_path);
    assert_eq!(
        git(&moved_checkout, &["rev-parse", "HEAD"]),
        git(&checkout, &["rev-parse", "HEAD"])
    );
    assert_eq!(
        fs::read_to_string(moved_checkout.join("notes.txt")).unwrap(),
        "untracked\n"
    );
    assert_eq!(a.snapshot().tabs_of(&source_ws).len(), 1);
}
