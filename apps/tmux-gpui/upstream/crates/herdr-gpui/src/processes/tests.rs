#![allow(clippy::unwrap_used, clippy::expect_used)]

use super::{
    tree::{check, listing},
    *,
};

fn entry(pid: u32, parent: Option<u32>, started: u64) -> Entry {
    Entry {
        identity: Identity { pid, started },
        parent,
        name: format!("p{pid}"),
        command: String::new(),
        cpu: Some(pid as f32),
        memory: u64::from(pid) * 1024,
    }
}

fn pids(listing: &Listing) -> Vec<(u32, usize)> {
    listing
        .rows
        .iter()
        .map(|row| (row.entry.identity.pid, row.depth))
        .collect()
}

#[test]
fn the_tree_is_the_roots_descendants_depth_first_oldest_first() {
    let entries = [
        entry(1, None, 0),
        entry(10, Some(1), 100),
        // Children of 10, listed out of order: 30 started before 20.
        entry(20, Some(10), 300),
        entry(30, Some(10), 200),
        entry(40, Some(30), 400),
        // Not below 10.
        entry(50, Some(1), 500),
        entry(60, None, 0),
    ];
    let tree = listing(entries.clone(), 10, &[30, 40], 100).unwrap();
    assert_eq!(pids(&tree), [(10, 0), (30, 1), (40, 2), (20, 1)]);
    assert_eq!(
        tree.rows.iter().map(|r| r.foreground).collect::<Vec<_>>(),
        [false, true, true, false]
    );
    assert_eq!(tree.cpu, 10. + 20. + 30. + 40.);
    assert_eq!(tree.memory, (10 + 20 + 30 + 40) * 1024);
    assert_eq!(tree.hidden, 0);
    assert_eq!(
        tree.root(),
        Some(Identity {
            pid: 10,
            started: 100
        })
    );
    assert!(tree.contains(Identity {
        pid: 40,
        started: 400
    }));
    // The same pid with another start time is another process.
    assert!(!tree.contains(Identity {
        pid: 40,
        started: 401
    }));
    // A root that is not listed has exited.
    assert!(listing(entries, 99, &[], 100).is_none());
}

#[test]
fn the_row_limit_still_counts_hidden_processes_in_the_totals() {
    let entries = (0..10).map(|i| entry(100 + i, (i > 0).then_some(100), u64::from(i)));
    let tree = listing(entries, 100, &[], 4).unwrap();
    assert_eq!(tree.rows.len(), 4);
    assert_eq!(tree.hidden, 6);
    assert_eq!(tree.cpu, (100..110).sum::<u32>() as f32);
}

#[test]
fn reused_pids_forming_a_cycle_do_not_loop() {
    // 20 and 30 name each other as parents; neither descends from 10.
    let entries = [
        entry(10, None, 0),
        entry(11, Some(10), 1),
        entry(20, Some(30), 2),
        entry(30, Some(20), 3),
    ];
    let tree = listing(entries.clone(), 10, &[], 100).unwrap();
    assert_eq!(pids(&tree), [(10, 0), (11, 1)]);
    let table = entries
        .iter()
        .map(|e| (e.identity.pid, (e.parent, e.identity.started)))
        .collect();
    let root = Identity {
        pid: 10,
        started: 0,
    };
    assert_eq!(
        check(
            &table,
            root,
            Identity {
                pid: 20,
                started: 2
            }
        ),
        Err(Refusal::Elsewhere)
    );
}

#[test]
fn a_kill_is_checked_against_the_process_chosen_and_the_pane() {
    let table = [
        (10, (Some(1), 100)),
        (20, (Some(10), 200)),
        (30, (Some(20), 300)),
        (40, (Some(1), 400)),
    ]
    .into();
    let root = Identity {
        pid: 10,
        started: 100,
    };
    let at = |pid, started| Identity { pid, started };
    assert_eq!(check(&table, root, at(20, 200)), Ok(()));
    assert_eq!(check(&table, root, at(30, 300)), Ok(()));
    assert_eq!(check(&table, root, at(10, 100)), Err(Refusal::Root));
    // The pid now names a process started later.
    assert_eq!(check(&table, root, at(30, 299)), Err(Refusal::Exited));
    assert_eq!(check(&table, root, at(99, 1)), Err(Refusal::Exited));
    // Reparented away from the pane, as an orphan is.
    assert_eq!(check(&table, root, at(40, 400)), Err(Refusal::Elsewhere));
    // The pane's process itself was replaced.
    assert_eq!(
        check(&table, at(10, 101), at(20, 200)),
        Err(Refusal::RootExited)
    );
}

#[test]
fn the_cli_is_asked_about_exactly_one_pane_of_its_session() {
    let path = Path::new("/opt/my herdr/herdr");
    assert_eq!(
        Daemon::Default.script(path, "w1:t1:p'2").unwrap(),
        "exec '/opt/my herdr/herdr' pane process-info --pane 'w1:t1:p'\\''2'\n"
    );
    assert_eq!(
        Daemon::Session("dev; rm".into()).script(path, "p").unwrap(),
        "exec '/opt/my herdr/herdr' --session 'dev; rm' pane process-info --pane 'p'\n"
    );
}

#[test]
fn only_daemons_on_this_machine_are_watched() {
    let local = cfg!(any(target_os = "linux", target_os = "macos"));
    assert_eq!(
        Daemon::for_target(&ConnectTarget::Local),
        local.then_some(Daemon::Default)
    );
    assert_eq!(
        Daemon::for_target(&ConnectTarget::Session {
            name: "work".into(),
            development: false,
        }),
        local.then(|| Daemon::Session("work".into()))
    );
    assert_eq!(
        Daemon::for_target(&ConnectTarget::Ssh {
            target: "box".into(),
            session: "default".into(),
        }),
        None
    );
    assert_eq!(
        Daemon::for_target(&ConnectTarget::Socket("/tmp/x.sock".into())),
        None
    );
}

#[test]
fn process_text_is_bounded_and_has_no_control_characters() {
    assert_eq!(display("a\u{1b}[31mb\nc".chars()), "a [31mb c");
    assert_eq!(display("x".repeat(2000).chars()).len(), COMMAND_LIMIT);
}

/// Exactly the child this test started, and only it, is signalled.
#[cfg(unix)]
#[test]
fn kill_signals_only_the_exact_process_chosen() {
    use std::os::unix::process::ExitStatusExt;
    let mut system = System::new();
    system.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing());
    let me = identity(system.process(Pid::from_u32(std::process::id())).unwrap());
    let spawn = || {
        std::process::Command::new("sleep")
            .arg("30")
            .spawn()
            .unwrap()
    };
    let mut kept = spawn();
    let mut ended = spawn();
    system.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing());
    let of =
        |child: &std::process::Child| identity(system.process(Pid::from_u32(child.id())).unwrap());
    let (kept_id, ended_id) = (of(&kept), of(&ended));
    let stale = Identity {
        started: kept_id.started + 1,
        ..kept_id
    };

    let outcomes = kill(&mut system, Some(me), &[ended_id, stale, me]);
    assert_eq!(
        outcomes,
        [
            (ended_id, Outcome::Signalled),
            (stale, Outcome::Refused(Refusal::Exited)),
            (me, Outcome::Refused(Refusal::Root)),
        ]
    );
    assert_eq!(ended.wait().unwrap().signal(), Some(15));
    assert!(kept.try_wait().unwrap().is_none());
    // Without a known root, nothing is signalled.
    assert_eq!(
        kill(&mut system, None, &[kept_id]),
        [(kept_id, Outcome::Refused(Refusal::RootExited))]
    );
    assert!(kept.try_wait().unwrap().is_none());
    kept.kill().unwrap();
    kept.wait().unwrap();
}

#[test]
fn a_watch_reports_a_stopped_worker_and_a_busy_one() {
    let (watch, updates, commands) = Watch::fake();
    assert!(watch.try_update().unwrap().is_none());
    let victim = Identity { pid: 7, started: 1 };
    watch.kill(vec![victim]).unwrap();
    // One kill at a time: the first is still with the worker.
    assert!(matches!(
        watch.kill(vec![victim]),
        Err(Error::ProcessesBusy)
    ));
    assert_eq!(commands.recv().unwrap(), Command::Kill(vec![victim]));
    drop(updates);
    assert!(matches!(watch.try_update(), Err(Error::ProcessesStopped)));
    drop(commands);
    assert!(matches!(
        watch.kill(vec![victim]),
        Err(Error::ProcessesStopped)
    ));
}

#[test]
fn usage_is_shown_from_a_processs_third_listing() {
    let process = Identity { pid: 7, started: 1 };
    let reused = Identity { pid: 7, started: 9 };
    let mut sightings = HashMap::new();
    let mut list = |identities: &[Identity]| {
        let previous = std::mem::take(&mut sightings);
        identities
            .iter()
            .map(|identity| sight(&previous, &mut sightings, *identity))
            .collect::<Vec<_>>()
    };
    assert_eq!(list(&[process]), [false]);
    assert_eq!(list(&[process]), [false]);
    assert_eq!(list(&[process]), [true]);
    assert_eq!(list(&[process]), [true]);
    // Its pid now names another process, measured afresh.
    assert_eq!(list(&[reused]), [false]);
    // A process missing from one listing is forgotten.
    assert_eq!(list(&[]), [] as [bool; 0]);
    assert_eq!(list(&[reused]), [false]);
}
