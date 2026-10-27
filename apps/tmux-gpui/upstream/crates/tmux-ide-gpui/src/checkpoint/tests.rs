#![allow(clippy::unwrap_used, clippy::expect_used)]

use super::*;
use herdr_client::protocol::ClientShellWorktree;

const KEY: &str = "/repo/.git";

/// Two agents: p0 in w4 (a linked worktree on `feature`), p1 in w0 (no
/// worktree), both idle.
fn snapshot() -> ClientShellSnapshot {
    let mut snapshot = crate::sidebar::layout_tests::snapshot(5);
    snapshot.workspaces[4].worktree = Some(ClientShellWorktree {
        key: KEY.into(),
        label: "repo".into(),
        is_linked_worktree: true,
    });
    snapshot.workspaces[4].branch = Some("feature".into());
    snapshot.agents[0].workspace_id = "w4".into();
    snapshot.agents[1].workspace_id = "w0".into();
    for agent in &mut snapshot.agents {
        agent.agent_status = AgentStatus::Idle;
    }
    snapshot
}

fn with(statuses: [AgentStatus; 2]) -> Arc<ClientShellSnapshot> {
    let mut snapshot = snapshot();
    for (agent, status) in snapshot.agents.iter_mut().zip(statuses) {
        agent.agent_status = status;
    }
    Arc::new(snapshot)
}

fn feature() -> Checkout {
    Checkout::new(Host::Local, KEY, Some("feature")).unwrap()
}

fn queued(checkpoints: &Checkpoints) -> Vec<(Checkout, Request)> {
    checkpoints
        .lanes
        .values()
        .flat_map(|lane| lane.queue.iter())
        .map(|job| (job.checkout.clone(), job.request.clone()))
        .collect()
}

fn capture(label: &str) -> Request {
    Request::Capture {
        label: label.into(),
    }
}

#[test]
fn turns_starting_and_ending_queue_one_checkpoint_per_checkout() {
    use AgentStatus::*;
    let mut checkpoints = Checkpoints::default();
    // The first snapshot only records what agents are doing.
    checkpoints.observe("local", &Host::Local, &with([Working, Working]));
    assert!(queued(&checkpoints).is_empty());

    // p0 finishes; p1's workspace has no checkout, so nothing for it.
    let done = with([Done, Idle]);
    checkpoints.observe("local", &Host::Local, &done);
    assert_eq!(
        queued(&checkpoints),
        [(feature(), capture("Claude Code finished a turn"))]
    );
    // The same snapshot again is not a new transition.
    checkpoints.observe("local", &Host::Local, &done);
    assert_eq!(queued(&checkpoints).len(), 1);

    // A new turn before the first checkpoint ran merges into it.
    checkpoints.observe("local", &Host::Local, &with([Working, Idle]));
    assert_eq!(
        queued(&checkpoints),
        [(feature(), capture("Before Claude Code's turn"))]
    );
}

#[test]
fn permission_prompts_and_restarts_are_not_turns() {
    use AgentStatus::*;
    let mut checkpoints = Checkpoints::default();
    checkpoints.observe("local", &Host::Local, &with([Working, Idle]));
    checkpoints.observe("local", &Host::Local, &with([Blocked, Idle]));
    checkpoints.observe("local", &Host::Local, &with([Working, Idle]));
    assert!(queued(&checkpoints).is_empty(), "still the same turn");

    // A restarted daemon reports fresh statuses; no turn spans it.
    let mut restarted = (*with([Idle, Idle])).clone();
    restarted.boot_id = "another boot".into();
    checkpoints.observe("local", &Host::Local, &Arc::new(restarted));
    assert!(queued(&checkpoints).is_empty());

    // Blocked, then given up on: the turn ended.
    checkpoints.observe("local", &Host::Local, &with([Blocked, Idle]));
    checkpoints.observe("local", &Host::Local, &with([Idle, Idle]));
    assert_eq!(queued(&checkpoints).len(), 1);
}

#[test]
fn endpoints_and_hosts_are_kept_apart() {
    use AgentStatus::*;
    let remote = Host::Ssh("me@box".into());
    let mut checkpoints = Checkpoints::default();
    checkpoints.observe("local", &Host::Local, &with([Working, Idle]));
    checkpoints.observe("ssh:box", &remote, &with([Idle, Idle]));
    checkpoints.observe("local", &Host::Local, &with([Idle, Idle]));
    checkpoints.observe("ssh:box", &remote, &with([Idle, Idle]));
    assert_eq!(
        queued(&checkpoints),
        [(feature(), capture("Claude Code finished a turn"))]
    );

    checkpoints.observe("ssh:box", &remote, &with([Working, Idle]));
    assert_eq!(checkpoints.lanes.len(), 2);
    assert_eq!(checkpoints.lanes[&remote].queue[0].checkout.host, remote);
}

#[test]
fn checkouts_need_an_absolute_key_and_a_plain_branch() {
    assert!(Checkout::new(Host::Local, "/r/.git", Some("a/b")).is_some());
    assert!(Checkout::new(Host::Local, "r/.git", Some("main")).is_none());
    assert!(Checkout::new(Host::Local, "/r/.git", None).is_none());
    assert!(Checkout::new(Host::Local, "/r/.git", Some("")).is_none());
    assert!(Checkout::new(Host::Local, "/r/.git", Some("a\nb")).is_none());
}

#[test]
fn queues_are_bounded() {
    let mut checkpoints = Checkpoints::default();
    for index in 0..QUEUE_LIMIT + 5 {
        let checkout = Checkout::new(Host::Local, &format!("/r{index}/.git"), Some("main"));
        checkpoints.capture(checkout.unwrap(), "turn".into());
    }
    assert_eq!(queued(&checkpoints).len(), QUEUE_LIMIT);
    for index in 0..HOST_LIMIT + 5 {
        let host = Host::Ssh(format!("box{index}"));
        let checkout = Checkout::new(host, "/r/.git", Some("main")).unwrap();
        checkpoints.capture(checkout, "turn".into());
    }
    assert_eq!(checkpoints.lanes.len(), HOST_LIMIT);
}

fn checkpoint(id: &str, branch: &str) -> Checkpoint {
    Checkpoint {
        id: id.into(),
        created: 0,
        label: "turn".into(),
        branch: Some(branch.into()),
        diff: Diff::default(),
    }
}

/// Finish the job a lane would have run, as its worker would answer.
fn answer(checkpoints: &mut Checkpoints, request: Request, answer: Answer) -> Vec<Restored> {
    let mut restored = Vec::new();
    let job = Job {
        checkout: feature(),
        request,
    };
    checkpoints.apply(job, answer, &mut restored);
    restored
}

#[test]
fn the_dialog_lists_first_and_restores_only_after_confirming() {
    let mut checkpoints = Checkpoints::default();
    checkpoints.capture(feature(), "turn".into());
    checkpoints.open(feature(), "repo".into(), "w4".into());
    assert_eq!(
        queued(&checkpoints)[0],
        (feature(), Request::List),
        "the list goes ahead of waiting checkpoints"
    );
    let view = checkpoints.view.as_ref().unwrap();
    assert_eq!(view.listing, Listing::Loading);

    answer(
        &mut checkpoints,
        Request::List,
        Answer::Listed(Ok(vec![
            checkpoint("2", "feature"),
            checkpoint("1", "elsewhere"),
        ])),
    );
    // Nothing is confirmed yet, and another branch's checkpoint never is.
    checkpoints.restore();
    assert_eq!(queued(&checkpoints).len(), 2);
    let view = checkpoints.view.as_mut().unwrap();
    view.confirming = Some("1".into());
    checkpoints.restore();
    assert!(!checkpoints.view.as_ref().unwrap().restoring);

    let view = checkpoints.view.as_mut().unwrap();
    view.selected = Some(0);
    view.confirming = Some("2".into());
    checkpoints.restore();
    assert!(checkpoints.view.as_ref().unwrap().restoring);
    assert_eq!(
        queued(&checkpoints)[0],
        (feature(), Request::Restore { id: "2".into() })
    );

    let restored = answer(
        &mut checkpoints,
        Request::Restore { id: "2".into() },
        Answer::Restored(Ok(())),
    );
    assert_eq!(restored.len(), 1);
    let view = checkpoints.view.as_ref().unwrap();
    assert!(!view.restoring && view.confirming.is_none());
    assert_eq!(view.selected, None, "a new list has nothing selected");
    assert_eq!(
        queued(&checkpoints)
            .iter()
            .filter(|(_, request)| *request == Request::List)
            .count(),
        1,
        "listed again, once"
    );
}

#[test]
fn a_restore_is_reported_after_its_dialog_closed_and_failures_show() {
    let mut checkpoints = Checkpoints::default();
    checkpoints.open(feature(), "repo".into(), "w4".into());
    answer(
        &mut checkpoints,
        Request::List,
        Answer::Listed(Err(Error::CheckpointCheckout)),
    );
    assert!(matches!(
        checkpoints.view.as_ref().unwrap().listing,
        Listing::Failed(_)
    ));
    checkpoints.close();
    let restored = answer(
        &mut checkpoints,
        Request::Restore { id: "1".into() },
        Answer::Restored(Err(Error::CheckpointBusy)),
    );
    assert!(matches!(
        restored.as_slice(),
        [Restored {
            result: Err(Error::CheckpointBusy),
            ..
        }]
    ));
}

#[test]
fn a_capture_of_the_listed_checkout_refreshes_the_list() {
    let mut checkpoints = Checkpoints::default();
    answer(
        &mut checkpoints,
        capture("x"),
        Answer::Captured(Ok(Some("1".into()))),
    );
    assert!(queued(&checkpoints).is_empty(), "nobody is looking");
    checkpoints.open(feature(), "repo".into(), "w4".into());
    checkpoints.lanes.clear();
    answer(&mut checkpoints, capture("x"), Answer::Captured(Ok(None)));
    assert!(queued(&checkpoints).is_empty(), "nothing new to show");
    answer(
        &mut checkpoints,
        capture("x"),
        Answer::Captured(Ok(Some("2".into()))),
    );
    assert_eq!(queued(&checkpoints), [(feature(), Request::List)]);
}

#[test]
fn stamps_always_increase() {
    let mut checkpoints = Checkpoints {
        last_stamp: u128::from(u64::MAX),
        ..Checkpoints::default()
    };
    let first = checkpoints.stamp();
    let second = checkpoints.stamp();
    assert!(second > first);
    assert!(script::valid_id(&second));
}

#[test]
fn ages_read_plainly() {
    assert_eq!(age(100, 130), "just now");
    assert_eq!(age(0, 125), "2 min ago");
    assert_eq!(age(0, 7200), "2 h ago");
    assert_eq!(age(0, 200_000), "2 d ago");
    assert_eq!(
        age(100, 0),
        "just now",
        "a host clock ahead is not negative"
    );
    assert_eq!(
        describe(&Error::CheckpointScript(herdr_client::Error::ScriptTimeout)),
        "Checkpoint Git commands failed: host script made no progress before its deadline"
    );
}

#[test]
fn git_runs_only_on_ssh_hosts_and_the_users_own_daemon() {
    let mut live = crate::LiveState::default();
    let local = ConnectTarget::Local;
    let session = ConnectTarget::Session {
        name: "work".into(),
        development: false,
    };
    let ssh = ConnectTarget::Ssh {
        target: "me@box".into(),
        session: "default".into(),
    };
    let socket = ConnectTarget::Socket("/tmp/other.sock".into());
    let scriptable = cfg!(any(target_os = "linux", target_os = "macos"));
    assert_eq!(host_for(&local, &live), None, "not proven to be ours");
    assert_eq!(
        host_for(&ssh, &live),
        scriptable.then(|| Host::Ssh("me@box".into()))
    );
    live.local_daemon_peer = true;
    for target in [&local, &session] {
        assert_eq!(host_for(target, &live), scriptable.then_some(Host::Local));
    }
    assert_eq!(host_for(&socket, &live), None);
}
