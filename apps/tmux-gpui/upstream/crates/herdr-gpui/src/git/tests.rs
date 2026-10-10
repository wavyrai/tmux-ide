#![allow(clippy::unwrap_used)]
use super::*;

#[test]
fn close_probe_detects_untracked_staged_unstaged_and_unpublished_work() {
    let directory = tempfile::tempdir().unwrap();
    let hooks = tempfile::tempdir().unwrap();
    let checkout = directory.path().to_str().unwrap();
    let command = |args: &[&str]| {
        let result = Command::new("git")
            .args([
                "-C",
                checkout,
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.invalid",
                "-c",
                "commit.gpgsign=false",
                "-c",
            ])
            .arg(format!("core.hooksPath={}", hooks.path().display()))
            .args(args)
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
    };
    command(&["init", "-b", "test"]);
    std::fs::write(directory.path().join("tracked"), "original\n").unwrap();
    command(&["add", "tracked"]);
    command(&["commit", "-m", "initial"]);
    let input = Input {
        repo_key: Some(directory.path().join(".git").to_str().unwrap().to_owned()),
        branch: "test".into(),
        checkout: Some(checkout.into()),
    };
    let probe =
        || close_status(&input, Instant::now() + Duration::from_secs(15), &|| false).unwrap();
    assert_eq!(probe(), (false, true)); // No upstream or remote refs.
    command(&["update-ref", "refs/remotes/origin/test", "HEAD"]);
    assert_eq!(probe(), (false, false));
    std::fs::write(directory.path().join("new"), "new\n").unwrap();
    assert_eq!(probe(), (true, false));
    command(&["add", "new"]);
    assert_eq!(probe(), (true, false));
    command(&["commit", "-m", "unpublished"]);
    assert_eq!(probe(), (false, true));
    std::fs::write(directory.path().join("tracked"), "modified\n").unwrap();
    assert_eq!(probe(), (true, true));
    assert!(matches!(
        close_status(&input, Instant::now() + Duration::from_secs(15), &|| true),
        Err(Error::PrCancelled)
    ));
}

struct Peer {
    git: Git,
    incoming: mpsc::Receiver<(u64, Input, Job)>,
    outgoing: mpsc::SyncSender<(Input, Completion)>,
}

impl Peer {
    fn new() -> Self {
        let (requests, incoming) = mpsc::sync_channel(1);
        let (outgoing, results) = mpsc::sync_channel(1);
        let mut git = Git::default();
        git.worker = Some(Worker { requests, results });
        Self {
            git,
            incoming,
            outgoing,
        }
    }

    fn request(&mut self) -> (Input, Job) {
        let (_, input, job) = self.incoming.try_recv().unwrap();
        (input, job)
    }

    fn complete(&mut self, input: Input, completion: Completion, now: Instant) {
        self.outgoing.send((input, completion)).unwrap();
        self.git.poll(now);
    }
}

fn input(branch: &str) -> Input {
    Input {
        checkout: None,
        repo_key: Some("/repo/.git".into()),
        branch: branch.into(),
    }
}

fn status(additions: u64, deletions: u64, untracked: u64) -> Status {
    Status {
        additions,
        deletions,
        untracked,
    }
}

#[test]
fn numstat_sums_text_changes_and_ignores_binary_rows() {
    assert_eq!(
        parse_numstat("12\t3\tsrc/main.rs\n-\t-\tlogo.png\n0\t7\tREADME.md\n"),
        status(12, 10, 0)
    );
    assert_eq!(parse_numstat(""), Status::default());
    assert!(!Status::default().dirty());
    assert!(status(0, 0, 1).dirty());
}

#[test]
fn status_refreshes_on_a_ttl_and_only_while_the_window_is_active() {
    let mut peer = Peer::new();
    let now = Instant::now();
    assert!(peer.git.track(Some(input("feature")), true, now));
    peer.git.poll(now);
    let (requested, job) = peer.request();
    assert_eq!(requested, input("feature"));
    assert!(matches!(job, Job::Status));
    peer.complete(requested, Completion::Status(Ok(status(9, 2, 1))), now);
    assert_eq!(peer.git.status(), Some(status(9, 2, 1)));
    let early = now + REFRESH - Duration::from_secs(1);
    peer.git.track(Some(input("feature")), true, early);
    peer.git.poll(early);
    assert!(
        peer.incoming.try_recv().is_err(),
        "refresh waits for the TTL"
    );
    let due = now + REFRESH;
    peer.git.track(Some(input("feature")), false, due);
    peer.git.poll(due);
    assert!(
        peer.incoming.try_recv().is_err(),
        "an inactive window does not poll Git"
    );
    assert_eq!(
        peer.git.status(),
        Some(status(9, 2, 1)),
        "and keeps its last status"
    );
    peer.git.track(Some(input("feature")), true, due);
    peer.git.poll(due);
    assert!(matches!(peer.request().1, Job::Status));
}

#[test]
fn a_changed_checkout_drops_its_predecessors_status() {
    let mut peer = Peer::new();
    let now = Instant::now();
    peer.git.track(Some(input("feature")), true, now);
    peer.git.poll(now);
    let (requested, _) = peer.request();
    assert!(peer.git.track(Some(input("other")), true, now));
    assert_eq!(peer.git.status(), None);
    peer.complete(requested, Completion::Status(Ok(status(9, 2, 0))), now);
    assert_eq!(
        peer.git.status(),
        None,
        "a stale checkout cannot paint over the new one"
    );
    peer.git.track(Some(input("other")), true, now);
    peer.git.poll(now);
    let (requested, _) = peer.request();
    assert_eq!(requested, input("other"));
    peer.complete(requested, Completion::Status(Ok(status(1, 1, 0))), now);
    assert_eq!(peer.git.status(), Some(status(1, 1, 0)));
    assert!(peer.git.track(None, true, now));
    assert_eq!(peer.git.status(), None);
}

#[test]
fn one_action_runs_at_a_time_and_reports_its_own_result() {
    let mut peer = Peer::new();
    let now = Instant::now();
    peer.git.track(Some(input("feature")), true, now);
    assert!(matches!(
        peer.git.start(Action::Commit("  ".into()), None),
        Err(Error::GitCommitMessage)
    ));
    assert!(matches!(
        peer.git.start(Action::CreatePullRequest, None),
        Err(Error::GitHubAuthentication)
    ));
    peer.git
        .start(Action::Commit("subject".into()), None)
        .unwrap();
    assert!(matches!(
        peer.git.start(Action::Push, None),
        Err(Error::GitBusy)
    ));
    peer.git.poll(now);
    let (requested, job) = peer.request();
    assert!(matches!(job, Job::Run(Action::Commit(message), None) if message == "subject"));
    // Switching workspaces mid-commit must not cancel or misreport it.
    peer.git.track(Some(input("other")), true, now);
    peer.complete(
        requested,
        Completion::Action(Ok(Outcome {
            message: "Committed abc1234 subject".into(),
            url: None,
        })),
        now,
    );
    assert_eq!(
        peer.git.outcome().map(|outcome| outcome.message.as_str()),
        Some("Committed abc1234 subject")
    );
    assert!(peer.git.running().is_none());
    peer.git.start(Action::Push, None).unwrap();
    peer.git.poll(now);
    let (requested, _) = peer.request();
    peer.complete(
        requested,
        Completion::Action(Err(Error::GitFailed {
            operation: "push",
            details: "rejected".into(),
        })),
        now,
    );
    assert!(peer.git.outcome().is_none());
    assert!(
        peer.git
            .error()
            .is_some_and(|error| error.contains("rejected"))
    );
}

#[test]
fn listed_checkouts_are_probed_round_robin_and_forgotten_when_they_go() {
    let mut peer = Peer::new();
    let now = Instant::now();
    let listed = [input("feature"), input("other")];
    peer.git.track(Some(input("feature")), true, now);
    peer.git.track_listed(listed.clone(), true, now);
    peer.git.poll(now);
    // The focused checkout is counted by its own status, not probed twice.
    let (requested, job) = peer.request();
    assert_eq!(requested, input("feature"));
    assert!(matches!(job, Job::Status));
    peer.complete(requested, Completion::Status(Ok(status(1, 0, 0))), now);
    assert_eq!(peer.git.dirty("/repo/.git", "feature"), Some(true));
    peer.git.poll(now);
    let (requested, job) = peer.request();
    assert_eq!(requested, input("other"), "the rest are probed in turn");
    assert!(matches!(job, Job::Dirty));
    assert_eq!(
        peer.git.dirty("/repo/.git", "other"),
        None,
        "unknown, not clean"
    );
    peer.complete(requested, Completion::Dirty(Ok(true)), now);
    assert_eq!(peer.git.dirty("/repo/.git", "other"), Some(true));
    // A failed probe is remembered as unknown and backs off further.
    peer.git
        .track_listed(listed.clone(), true, now + PROBE_REFRESH);
    peer.git.poll(now + PROBE_REFRESH);
    let (requested, _) = peer.request();
    peer.complete(
        requested,
        Completion::Dirty(Err(Error::GitNoCheckout)),
        now + PROBE_REFRESH,
    );
    assert_eq!(peer.git.dirty("/repo/.git", "other"), None);
    let early = now + PROBE_REFRESH + PROBE_BACKOFF - Duration::from_secs(1);
    peer.git.track_listed(listed.clone(), true, early);
    peer.git.poll(early);
    assert!(peer.incoming.try_recv().is_err(), "a failure waits longer");
    let due = now + PROBE_REFRESH + PROBE_BACKOFF;
    peer.git.track_listed(listed.clone(), false, due);
    peer.git.poll(due);
    assert!(
        peer.incoming.try_recv().is_err(),
        "an inactive window probes nothing"
    );
    peer.git.track_listed(listed, true, due);
    peer.git.poll(due);
    assert!(matches!(peer.request().1, Job::Dirty));
    // A workspace that leaves the listing takes its answer with it.
    peer.git
        .track_listed([input("feature")], true, due + SCAN_INTERVAL);
    assert_eq!(peer.git.dirty("/repo/.git", "other"), None);
    assert!(peer.git.queue.is_empty());
}

#[test]
fn the_probe_cache_is_bounded() {
    let mut git = Git::default();
    let now = Instant::now();
    let listed: Vec<_> = (0..CACHE_LIMIT + 10)
        .map(|index| input(&format!("branch-{index}")))
        .collect();
    git.track_listed(listed.clone(), true, now);
    assert_eq!(git.queue.len(), CACHE_LIMIT);
    for (index, input) in listed.iter().enumerate() {
        git.seed_probe(input.clone(), index.is_multiple_of(2), now);
    }
    assert_eq!(git.probes.len(), CACHE_LIMIT);
}

#[test]
fn a_stopped_worker_is_reported_and_does_not_strand_an_action() {
    let mut peer = Peer::new();
    let now = Instant::now();
    peer.git.track(Some(input("feature")), true, now);
    peer.git.start(Action::Push, None).unwrap();
    peer.git.poll(now);
    let _ = peer.request();
    drop(peer.outgoing);
    assert!(peer.git.poll(now));
    assert!(peer.git.running().is_none());
    assert_eq!(
        peer.git.error(),
        Some(Error::GitWorker.to_string().as_str())
    );
}

#[test]
fn created_pull_requests_must_match_their_repository() {
    let response = |url: &str, number: u64| serde_json::json!({"data":{"createPullRequest":{"pullRequest":{"number":number,"url":url}}}});
    let outcome = parse_created(
        &response("https://github.com/example/project/pull/7", 7),
        "example",
        "project",
    )
    .unwrap();
    assert_eq!(outcome.message, "Opened pull request #7");
    assert_eq!(
        outcome.url.as_deref(),
        Some("https://github.com/example/project/pull/7")
    );
    for (url, number) in [
        ("https://github.com/other/project/pull/7", 7),
        ("https://github.com/example/project/pull/8", 7),
        ("https://example.com/example/project/pull/7", 7),
        ("https://github.com/example/project/pull/0", 0),
    ] {
        assert!(matches!(
            parse_created(&response(url, number), "example", "project"),
            Err(Error::PrIdentity)
        ));
    }
}
