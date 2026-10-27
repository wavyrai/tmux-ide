use super::*;
use crate::fan_out::error::Step;

mod compare;
mod spread;

fn origin() -> Origin {
    Origin {
        endpoint_id: "local".into(),
        endpoint_label: "This Mac".into(),
        host: crate::teleport::host_for(&herdr_client::ConnectTarget::Local).unwrap(),
        workspace_id: "w1".into(),
        repo_key: "/tmp/repo/.git".into(),
        repo_label: "repo".into(),
        base: "HEAD".into(),
    }
}

/// A fan-out whose host work is never started: events are fed by hand.
fn idle() -> FanOut {
    let (sender, events) = mpsc::channel();
    FanOut {
        origin: origin(),
        stage: Stage::Compose(Some(Ok(vec![AgentKind::Claude, AgentKind::Codex]))),
        picks: Picks::default(),
        hosts: Picker::new("local", Instant::now()),
        spread: false,
        overrides: Vec::new(),
        prompt: String::new(),
        lanes: Vec::new(),
        base: None,
        error: None,
        sender,
        events,
        work: Arc::new(AtomicBool::new(false)),
        probe: Arc::new(AtomicBool::new(false)),
        probing: false,
        next_refresh: None,
    }
}

fn checkout(n: usize) -> Checkout {
    Checkout {
        endpoint_id: "local".into(),
        host: origin().host,
        workspace_id: format!("w{n}"),
        path: format!("/tmp/lane-{n}"),
        pane_id: format!("p{n}"),
    }
}

/// Three lanes launched, without running the launch.
fn launched() -> FanOut {
    let mut fan_out = idle();
    fan_out.picks.add(AgentKind::Claude);
    fan_out.picks.add(AgentKind::Codex);
    fan_out.picks.add(AgentKind::Claude);
    fan_out.lanes = plan::lanes(&fan_out.picks, 7)
        .into_iter()
        .map(|lane| LaneView {
            lane,
            state: LaneState::Waiting,
            checkout: None,
            stats: None,
            unread: None,
        })
        .collect();
    fan_out.stage = Stage::Launching;
    fan_out
}

fn send(fan_out: &FanOut, event: Event) {
    fan_out.sender.send(event).unwrap();
}

#[test]
fn launch_needs_the_agent_list_a_prompt_and_a_pick() {
    let mut fan_out = idle();
    fan_out.stage = Stage::Compose(None);
    assert_eq!(fan_out.not_ready("go"), Some("Waiting for the agent list"));
    fan_out.stage = Stage::Compose(Some(Ok(vec![AgentKind::Claude])));
    assert_eq!(fan_out.not_ready("  "), Some("Write a prompt"));
    assert_eq!(fan_out.not_ready("go"), Some("Pick at least one agent"));
    assert!(fan_out.toggle(AgentKind::Claude, true));
    assert_eq!(fan_out.not_ready("go"), None);
    fan_out.stage = Stage::Compose(Some(Err("no".into())));
    assert!(
        !fan_out.launch("go", 1, |_| None),
        "a failed lookup cannot launch"
    );
    assert!(fan_out.composing());
}

#[test]
fn lane_progress_settles_into_a_comparison() {
    let mut fan_out = launched();
    send(
        &fan_out,
        Event::Report(Report::Lane(0, Progress::CreatingWorktree)),
    );
    send(
        &fan_out,
        Event::Report(Report::Lane(0, Progress::Created(checkout(0)))),
    );
    send(&fan_out, Event::Report(Report::Base("c0ffee".into())));
    send(&fan_out, Event::Report(Report::Lane(0, Progress::Running)));
    send(
        &fan_out,
        Event::Report(Report::Lane(
            1,
            Progress::Failed(Error::Script {
                step: Step::CreateWorktree,
                source: herdr_client::Error::ScriptTimeout,
            }),
        )),
    );
    send(
        &fan_out,
        Event::Report(Report::Lane(2, Progress::Created(checkout(2)))),
    );
    send(
        &fan_out,
        Event::Report(Report::Lane(2, Progress::Prompting)),
    );
    // A report for a lane that does not exist is ignored.
    send(&fan_out, Event::Report(Report::Lane(9, Progress::Running)));
    assert_eq!(fan_out.poll(), (true, None));
    assert!(fan_out.busy());
    assert_eq!(fan_out.base.as_deref(), Some("c0ffee"));
    assert_eq!(fan_out.lanes[0].state, LaneState::Running);
    assert_eq!(fan_out.lanes[0].checkout, Some(checkout(0)));
    assert!(
        matches!(&fan_out.lanes[1].state, LaneState::Failed(e) if e.starts_with("creating the worktree failed"))
    );
    assert_eq!(fan_out.lanes[1].checkout, None);

    send(&fan_out, Event::Launched);
    fan_out.poll();
    assert!(matches!(fan_out.stage, Stage::Compare));
    assert_eq!(
        fan_out.lanes[2].state,
        LaneState::Failed("Stopped".into()),
        "a lane the launch never settled is not left looking busy"
    );
    assert!(!fan_out.busy());
}

#[test]
fn stats_land_on_their_lanes_and_reads_do_not_overlap() {
    let mut fan_out = launched();
    fan_out.stage = Stage::Compare;
    let now = Instant::now();
    assert!(
        !fan_out.refresh(now),
        "nothing to compare before the base is known"
    );
    fan_out.base = Some("c0ffee".into());
    fan_out.probing = true;
    assert!(!fan_out.refresh(now), "one read at a time");
    fan_out.probing = false;
    fan_out.next_refresh = Some(now + Duration::from_secs(1));
    assert!(!fan_out.refresh(now), "not before it is due");

    let stat = DiffStat {
        files: 1,
        additions: 2,
        ..DiffStat::default()
    };
    fan_out.probing = true;
    send(
        &fan_out,
        Event::Stats(vec![HostStats {
            lanes: vec![0, 1, 2],
            result: Ok(vec![Some(stat), None, None]),
        }]),
    );
    fan_out.poll();
    assert!(!fan_out.probing);
    assert_eq!(fan_out.lanes[0].stats, Some(stat));
    assert_eq!(fan_out.lanes[1].stats, None);
}

#[test]
fn keeping_a_lane_needs_its_confirmation_and_removes_only_the_others() {
    let mut fan_out = launched();
    for (index, lane) in fan_out.lanes.iter_mut().enumerate() {
        lane.checkout = (index != 1).then(|| checkout(index));
        lane.state = LaneState::Running;
    }
    fan_out.stage = Stage::Compare;
    assert!(!fan_out.keep(0), "keeping asks first");
    fan_out.stage = Stage::Confirm(2);
    assert!(!fan_out.keep(0), "only the confirmed lane is kept");
    assert_eq!(
        fan_out.doomed(2),
        [(0, "w0".to_owned())],
        "lane 1 never got a checkout, and the winner stays"
    );
    // The removal's answer is fed by hand instead of running it.
    fan_out.stage = Stage::Removing(2);
    assert!(fan_out.busy());
    send(&fan_out, Event::Removed(vec![(0, Ok(()))]));
    assert_eq!(
        fan_out.poll(),
        (true, Some(("local".to_owned(), "w2".to_owned())))
    );
}

#[test]
fn a_failed_removal_returns_to_the_confirmation_without_removed_lanes() {
    let mut fan_out = launched();
    for (index, lane) in fan_out.lanes.iter_mut().enumerate() {
        lane.checkout = Some(checkout(index));
    }
    fan_out.stage = Stage::Removing(2);
    send(
        &fan_out,
        Event::Removed(vec![
            (0, Ok(())),
            (
                1,
                Err(Error::Script {
                    step: Step::Remove,
                    source: herdr_client::Error::ScriptTimeout,
                }),
            ),
        ]),
    );
    assert_eq!(fan_out.poll(), (true, None));
    assert_eq!(fan_out.lanes.len(), 2);
    assert!(
        matches!(fan_out.stage, Stage::Confirm(1)),
        "the winner moved up"
    );
    assert_eq!(
        fan_out.lanes[1].checkout.as_ref().unwrap().workspace_id,
        "w2"
    );
    assert!(
        fan_out
            .error
            .as_deref()
            .unwrap()
            .starts_with("1 worktree(s) could not be removed")
    );
}

#[test]
fn agent_status_comes_from_the_daemon_snapshot() {
    let mut snapshot = crate::sidebar::layout_tests::snapshot(2);
    let id = snapshot.workspaces[1].workspace_id.clone();
    snapshot.workspaces[1].agent_status = AgentStatus::Blocked;
    assert_eq!(agent_status(Some(&snapshot), &id), "Needs input");
    assert_eq!(agent_status(Some(&snapshot), "gone"), "Closed");
    assert_eq!(agent_status(None, &id), "Host offline");
}
