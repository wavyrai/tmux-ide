use super::*;
use herdr_client::SessionState;
use std::path::PathBuf;

fn session(name: &str, state: SessionState) -> LocalSession {
    LocalSession {
        name: name.into(),
        state,
        socket: PathBuf::from(format!("/config/herdr/sessions/{name}/herdr-client.sock")),
    }
}

fn now() -> Instant {
    Instant::now()
}

/// A scan the test releases by hand, so when it finishes is never a guess.
fn blocked_scan() -> (
    mpsc::Sender<()>,
    impl FnOnce() -> Result<Vec<LocalSession>, Error> + Send + 'static,
) {
    let (release, blocked) = mpsc::channel();
    let scan = move || {
        let _ = blocked.recv();
        Ok(vec![session("work", SessionState::Running)])
    };
    (release, scan)
}

#[test]
fn a_closed_popup_never_scans_but_still_applies_a_finished_scan() {
    let mut sessions = Sessions::default();
    assert!(!sessions.poll_with(false, now(), || {
        unreachable!("a closed popup must not scan")
    }));
    let (tx, rx) = mpsc::sync_channel(1);
    sessions.pending = Some(rx);
    sessions.scanning = true;
    tx.send(Ok(vec![session("work", SessionState::Running)]))
        .unwrap();
    assert!(sessions.poll_with(false, now(), || unreachable!("still closed")));
    assert_eq!(sessions.entries.len(), 1);
    assert!(!sessions.scanning);
    assert!(sessions.error.is_none());
}

#[test]
fn an_open_popup_scans_then_waits_for_the_refresh_interval() {
    let mut sessions = Sessions::default();
    let (release, scan) = blocked_scan();
    assert!(sessions.poll_with(true, now(), scan));
    assert!(sessions.scanning);
    // A second poll while that scan runs must not queue another one.
    assert!(!sessions.poll_with(true, now(), || {
        unreachable!("a scan is already running")
    }));
    release.send(()).unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    let settled = |sessions: &mut Sessions| {
        sessions.poll_with(false, Instant::now(), || unreachable!("closed"))
    };
    while !settled(&mut sessions) {
        assert!(Instant::now() < deadline, "the scan never reported");
        std::thread::sleep(Duration::from_millis(5));
    }
    assert_eq!(sessions.entries.len(), 1);
    let scanned_at = now();
    // Inside the interval, an open popup leaves the probe and its result alone.
    assert!(!sessions.poll_with(true, scanned_at + REFRESH / 2, || {
        unreachable!("results are still fresh")
    }));
    // Past it, the popup probes again.
    assert!(sessions.poll_with(true, scanned_at + REFRESH, || Ok(vec![])));
}

#[test]
fn a_failed_scan_keeps_the_last_list_and_reports_why() {
    let mut sessions = Sessions {
        entries: vec![session("work", SessionState::Stopped)],
        ..Default::default()
    };
    let (tx, rx) = mpsc::sync_channel(1);
    sessions.pending = Some(rx);
    tx.send(Err(Error::Client(herdr_client::Error::SessionLimit)))
        .unwrap();
    assert!(sessions.poll_with(false, now(), || unreachable!("closed")));
    assert_eq!(sessions.entries.len(), 1);
    assert_eq!(sessions.error.as_deref(), Some("too many sessions to list"));
}

#[test]
fn a_worker_that_dies_without_reporting_does_not_leave_the_popup_scanning() {
    let mut sessions = Sessions {
        scanning: true,
        ..Default::default()
    };
    let (tx, rx) = mpsc::sync_channel::<Result<Vec<LocalSession>, Error>>(1);
    sessions.pending = Some(rx);
    drop(tx);
    assert!(sessions.poll_with(false, now(), || { unreachable!("a scan is outstanding") }));
    assert!(!sessions.scanning);
    assert!(sessions.pending.is_none());
    assert!(sessions.error.is_some());
}

#[test]
fn opening_the_popup_requests_a_fresh_scan() {
    let mut sessions = Sessions::default();
    let scanned_at = now();
    assert!(sessions.poll_with(true, scanned_at, || Ok(vec![])));
    sessions.pending.take();
    sessions.scanning = false;
    sessions.next_scan = Some(scanned_at + REFRESH);
    // Opening again must not wait out the interval the previous open left.
    sessions.refresh();
    assert!(sessions.poll_with(true, scanned_at, || Ok(vec![])));
}

#[test]
fn mutation_refresh_survives_an_older_local_scan() {
    let mut sessions = Sessions::default();
    let (tx, rx) = mpsc::sync_channel(1);
    sessions.pending = Some(rx);
    sessions.refresh();
    tx.send(Ok(vec![])).unwrap();
    sessions.poll_with(false, now(), || unreachable!("closed"));
    assert!(
        sessions.next_scan.is_none(),
        "the old answer must not delay the post-mutation scan"
    );
    assert!(sessions.poll_with(true, now(), || Ok(vec![])));
}

#[test]
fn mutation_refresh_rejects_an_older_remote_answer() {
    let mut devices = Devices::default();
    let targets = [device("build")];
    devices
        .asked
        .insert(targets[0].0.clone(), (targets[0].1.clone(), now()));
    let (tx, rx) = mpsc::sync_channel(1);
    devices.pending = Some(rx);
    devices.refresh();
    tx.send(vec![(
        targets[0].0.clone(),
        targets[0].1.clone(),
        DeviceScan::Sessions(vec![]),
    )])
    .unwrap();
    devices.poll_with(&targets, false, now(), |_| unreachable!("closed"));
    assert!(devices.answers.is_empty());
    assert!(stale(&devices.asked, &targets[0].0, &targets[0].1, now()));
}

#[test]
fn departure_is_bounded_and_an_old_scan_cannot_restore_a_deleted_row() {
    let started = now();
    let target = ConnectTarget::Session {
        name: "old".into(),
        development: false,
    };
    let departure = Departure::new(target, started);
    assert_eq!(departure.remaining(started), 1.);
    assert_eq!(departure.remaining(started + DELETION_ANIMATION / 2), 0.5);
    assert_eq!(departure.remaining(started + DELETION_ANIMATION), 0.);
    assert_eq!(departure.remaining(started + DELETION_ANIMATION * 2), 0.);
    let mut sessions = Sessions {
        entries: vec![
            session("old", SessionState::Stopped),
            session("keep", SessionState::Running),
        ],
        departure: Some(departure),
        ..Default::default()
    };
    let (tx, rx) = mpsc::sync_channel(1);
    sessions.pending = Some(rx);
    tx.send(Ok(vec![session("old", SessionState::Stopped)]))
        .unwrap();
    sessions.finish_departure();
    sessions.refresh();
    sessions.poll_with(false, now(), || unreachable!("closed"));
    assert_eq!(
        sessions
            .entries
            .iter()
            .map(|entry| entry.name.as_str())
            .collect::<Vec<_>>(),
        ["keep"]
    );
    assert!(sessions.departure.is_none());
    assert!(sessions.next_scan.is_none());
}

#[test]
fn remote_departure_keeps_other_rows_and_refresh_keeps_the_updated_catalog() {
    let mut sessions = Sessions::default();
    for (id, host) in [("device", "host"), ("other", "elsewhere")] {
        sessions.devices.asked.insert(id.into(), (ssh(host), now()));
        sessions.devices.answers.insert(
            id.into(),
            DeviceScan::Sessions(vec![
                RemoteSession {
                    name: "old".into(),
                    running: false,
                },
                RemoteSession {
                    name: "keep".into(),
                    running: true,
                },
            ]),
        );
    }
    sessions.departure = Some(Departure::new(
        ConnectTarget::Ssh {
            target: "host".into(),
            session: "old".into(),
        },
        now(),
    ));
    sessions.finish_departure();
    sessions.devices.refresh();
    assert!(
        matches!(&sessions.devices.answers["device"], DeviceScan::Sessions(rows) if rows.len() == 1 && rows[0].name == "keep")
    );
    assert!(
        matches!(&sessions.devices.answers["other"], DeviceScan::Sessions(rows) if rows.len() == 2)
    );
}

/// One saved device as the window's endpoint list describes it.
fn device(name: &str) -> (String, RemoteHost) {
    (format!("ssh:{name}"), ssh(&format!("{name}.invalid")))
}

fn ssh(target: &str) -> RemoteHost {
    RemoteHost::Ssh(target.to_owned())
}

/// Wait for the pass the popup started, counting nothing it never began.
fn settle(devices: &mut Devices, targets: &[(String, RemoteHost)]) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while devices.pending.is_some() {
        assert!(Instant::now() < deadline, "the device pass never reported");
        devices.poll_with(targets, false, Instant::now(), |_| {
            unreachable!("a closed popup starts no pass")
        });
        std::thread::sleep(Duration::from_millis(5));
    }
}

/// A probe that records each target it was handed.
fn recorder() -> (
    std::sync::Arc<std::sync::Mutex<Vec<RemoteHost>>>,
    Box<Probe>,
) {
    let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let recorded = seen.clone();
    let probe: Box<Probe> = Box::new(move |target: &RemoteHost| {
        recorded.lock().unwrap().push(target.clone());
        Ok(Vec::new())
    });
    (seen, probe)
}

#[test]
fn a_closed_popup_never_probes_a_device_but_still_applies_a_finished_pass() {
    let targets = [device("build")];
    let mut devices = Devices::default();
    assert!(!devices.poll_with(&targets, false, now(), |_| {
        unreachable!("a closed popup must not probe")
    }));
    let (tx, rx) = mpsc::sync_channel(1);
    devices.pending = Some(rx);
    devices
        .asked
        .insert("ssh:build".to_owned(), (ssh("build.invalid"), now()));
    tx.send(vec![(
        "ssh:build".to_owned(),
        ssh("build.invalid"),
        DeviceScan::Sessions(vec![RemoteSession {
            name: "agents".into(),
            running: true,
        }]),
    )])
    .unwrap();
    assert!(devices.poll_with(&targets, false, now(), |_| { unreachable!("still closed") }));
    assert!(devices.pending.is_none());
    assert!(matches!(
        devices.answers["ssh:build"],
        DeviceScan::Sessions(ref sessions) if sessions.len() == 1
    ));
}

#[test]
fn a_pass_asks_every_due_device_and_leaves_the_others_alone() {
    let targets = [device("build"), device("prod")];
    let asked_at = now();
    let mut devices = Devices::default();
    // `prod` was asked a moment ago; `build` never has been.
    devices
        .asked
        .insert("ssh:prod".to_owned(), (ssh("prod.invalid"), asked_at));
    let (seen, probe) = recorder();
    assert!(devices.poll_with(&targets, true, asked_at, probe));
    settle(&mut devices, &targets);
    assert_eq!(
        *seen.lock().unwrap(),
        [ssh("build.invalid")],
        "only the device whose answer has aged out is asked"
    );
    assert_eq!(devices.answers.len(), 1);
    // Inside the interval nothing is asked again, and past it both are.
    assert!(
        !devices.poll_with(&targets, true, asked_at + DEVICE_REFRESH / 2, |_| {
            unreachable!("both answers are still fresh")
        })
    );
    let (seen, probe) = recorder();
    assert!(devices.poll_with(&targets, true, asked_at + DEVICE_REFRESH, probe));
    settle(&mut devices, &targets);
    let mut both = seen.lock().unwrap().clone();
    both.sort();
    assert_eq!(both, [ssh("build.invalid"), ssh("prod.invalid")]);
}

#[test]
fn a_failed_probe_waits_out_the_interval_like_an_answer() {
    let targets = [device("build")];
    let mut devices = Devices::default();
    let asked_at = now();
    assert!(devices.poll_with(&targets, true, asked_at, |_| {
        Err(herdr_client::Error::SshTimeout)
    }));
    settle(&mut devices, &targets);
    assert!(matches!(
        devices.answers["ssh:build"],
        DeviceScan::Failed(_)
    ));
    // A host that cannot answer must not be redialled on every refresh.
    assert!(
        !devices.poll_with(&targets, true, asked_at + DEVICE_REFRESH / 2, |_| {
            unreachable!("the failure is still fresh")
        })
    );
    assert!(
        devices.poll_with(&targets, true, asked_at + DEVICE_REFRESH, |_| {
            Err(herdr_client::Error::SshTimeout)
        })
    );
}

#[test]
fn a_worker_that_dies_fails_only_the_devices_it_was_asking() {
    let targets = [device("build"), device("prod")];
    let asked_at = now();
    let mut devices = Devices {
        asking: vec![device("build")],
        ..Default::default()
    };
    devices
        .asked
        .insert("ssh:build".to_owned(), (ssh("build.invalid"), asked_at));
    // `prod` answered a moment ago: it is not part of this pass.
    devices
        .asked
        .insert("ssh:prod".to_owned(), (ssh("prod.invalid"), asked_at));
    devices.answers.insert(
        "ssh:prod".to_owned(),
        DeviceScan::Sessions(vec![RemoteSession {
            name: "agents".into(),
            running: true,
        }]),
    );
    let (tx, rx) = mpsc::sync_channel::<Vec<(String, RemoteHost, DeviceScan)>>(1);
    devices.pending = Some(rx);
    drop(tx);
    assert!(devices.poll_with(&targets, false, now(), |_| {
        unreachable!("a pass is outstanding")
    }));
    assert!(devices.pending.is_none());
    assert!(matches!(
        devices.answers["ssh:build"],
        DeviceScan::Failed(_)
    ));
    // The device that was not being asked keeps the answer it already had.
    assert!(matches!(
        devices.answers["ssh:prod"],
        DeviceScan::Sessions(ref sessions) if sessions.len() == 1
    ));
}

#[test]
fn a_device_whose_host_changed_is_asked_again_at_once() {
    let asked_at = now();
    let mut devices = Devices::default();
    devices
        .asked
        .insert("ssh:build".to_owned(), (ssh("old.invalid"), asked_at));
    devices.answers.insert(
        "ssh:build".to_owned(),
        DeviceScan::Sessions(vec![RemoteSession {
            name: "agents".into(),
            running: true,
        }]),
    );
    // The same endpoint id now points at another host, inside the interval.
    let targets = [("ssh:build".to_owned(), ssh("new.invalid"))];
    let (seen, probe) = recorder();
    assert!(devices.poll_with(&targets, true, asked_at + Duration::from_secs(1), probe));
    settle(&mut devices, &targets);
    assert_eq!(
        *seen.lock().unwrap(),
        [ssh("new.invalid")],
        "a changed host is asked at once rather than after the old host's interval"
    );
    assert!(devices.answers.contains_key("ssh:build"));
}

#[test]
fn an_answer_from_a_host_the_device_no_longer_points_at_is_dropped() {
    let asked_at = now();
    let mut devices = Devices {
        asking: vec![("ssh:build".to_owned(), ssh("old.invalid"))],
        ..Default::default()
    };
    devices
        .asked
        .insert("ssh:build".to_owned(), (ssh("old.invalid"), asked_at));
    let (tx, rx) = mpsc::sync_channel::<Vec<(String, RemoteHost, DeviceScan)>>(1);
    devices.pending = Some(rx);
    tx.send(vec![(
        "ssh:build".to_owned(),
        ssh("old.invalid"),
        DeviceScan::Sessions(vec![RemoteSession {
            name: "agents".into(),
            running: true,
        }]),
    )])
    .unwrap();
    // The device moved to another host while that probe was in flight.
    let targets = [("ssh:build".to_owned(), ssh("new.invalid"))];
    assert!(devices.poll_with(&targets, false, asked_at, |_| {
        unreachable!("the pass is already outstanding")
    }));
    assert!(
        devices.answers.is_empty(),
        "the previous host's sessions are not this device's"
    );
}
