#![allow(clippy::unwrap_used)]
use super::*;

fn next_state(mailbox: &Mailbox) -> Option<State> {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Some(state) = mailbox.lock().unwrap().take() {
            return state;
        }
        assert!(
            Instant::now() < deadline,
            "native transport did not publish"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
}
#[test]
fn typed_backend_moves_ordered_commands_and_closes_when_owner_disconnects() {
    let (events, receiver) = mpsc::sync_channel(8);
    let (commands, output) = mpsc::sync_channel(8);
    let bridge = start_events(Default::default(), receiver, true, move || {
        move |command| {
            commands
                .try_send(command)
                .map_err(|_| Error::Invalid("owner closed"))
        }
    });
    events
        .send(Incoming::Catalog(Box::new(State {
            request: 6,
            status: "Native catalog ready".into(),
            ..State::default()
        })))
        .unwrap();
    let state = next_state(&bridge.mailbox).unwrap();
    assert_eq!(state.request, 6);
    assert_eq!(state.status, "Native catalog ready");
    assert!(!state.input_ready);
    bridge
        .commands
        .send(Command::Session {
            request: 7,
            id: "live-session.fixture".into(),
        })
        .unwrap();
    bridge
        .commands
        .send(Command::Refresh { request: 8 })
        .unwrap();
    assert!(
        matches!(output.recv_timeout(Duration::from_secs(5)).unwrap(), Command::Session {request:7,id} if id=="live-session.fixture")
    );
    assert!(matches!(
        output.recv_timeout(Duration::from_secs(5)).unwrap(),
        Command::Refresh { request: 8 }
    ));
    // Dropping the typed event source must retire the terminal loop even without
    // a JSON EOF adapter or an explicit Closed event.
    drop(events);
    while next_state(&bridge.mailbox).is_some() {}
    assert!(matches!(
        output.recv_timeout(Duration::from_secs(5)),
        Err(mpsc::RecvTimeoutError::Disconnected)
    ));
}
#[test]
fn typed_backend_command_failure_closes_the_authoritative_mailbox() {
    let (_events, receiver) = mpsc::sync_channel(8);
    let bridge = start_events(Default::default(), receiver, true, || {
        |_| Err(Error::Invalid("owner unavailable"))
    });
    bridge.commands.send(Command::Home { request: 1 }).unwrap();
    assert!(next_state(&bridge.mailbox).is_none());
}

#[test]
fn delayed_catalog_cannot_replace_a_newer_navigation() {
    let (events, receiver) = mpsc::sync_channel(8);
    let bridge = start_events(Default::default(), receiver, true, || |_| Ok(()));
    events
        .send(Incoming::Catalog(Box::new(State {
            request: 7,
            status: "Current pane".into(),
            ..State::default()
        })))
        .unwrap();
    assert_eq!(next_state(&bridge.mailbox).unwrap().request, 7);
    events
        .send(Incoming::Catalog(Box::new(State {
            request: 6,
            status: "Old pane".into(),
            ..State::default()
        })))
        .unwrap();
    bridge
        .commands
        .send(Command::Presence {
            active: true,
            revision: 4,
        })
        .unwrap();
    let state = next_state(&bridge.mailbox).unwrap();
    assert_eq!(state.request, 7);
    assert_eq!(state.status, "Current pane");
    drop(events);
}

/// Commands pile up while the owner is slow. Past the bound the newest are refused
/// with a notice; the terminal loop and its mailbox stay alive.
#[test]
fn a_full_pending_queue_refuses_commands_and_keeps_the_loop() {
    let (_events, receiver) = mpsc::sync_channel(8);
    let (gate, opened) = mpsc::channel::<()>();
    let (seen, forwarded) = mpsc::channel();
    let bridge = start_events(Default::default(), receiver, true, move || {
        let mut first = true;
        move |command| {
            if first {
                first = false;
                let _ = opened.recv_timeout(Duration::from_secs(5));
            }
            let _ = seen.send(command);
            Ok(())
        }
    });
    let commands = bridge.commands.clone();
    let sender = std::thread::spawn(move || {
        for request in 0..400 {
            if commands.send(Command::Refresh { request }).is_err() {
                break;
            }
        }
    });
    std::thread::sleep(Duration::from_millis(200));
    // On failure the loop may already be gone, taking the gate with it.
    let _ = gate.send(());
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut refused = false;
    while !refused && Instant::now() < deadline {
        // Never sleep while holding the mailbox: the loop publishes through it.
        let next = bridge.mailbox.lock().unwrap().take();
        match next {
            Some(Some(state)) => {
                refused =
                    state.status == "Terminal busy — input refused. Retype when it catches up.";
            }
            Some(None) => panic!("the terminal loop exited"),
            None => std::thread::sleep(Duration::from_millis(5)),
        }
    }
    assert!(refused, "no refusal notice was published");
    sender.join().unwrap();
    // Admitted commands keep flowing to the owner after the refusal.
    let deadline = Instant::now() + Duration::from_secs(5);
    while forwarded.try_recv().is_ok() {}
    bridge
        .commands
        .send(Command::Refresh { request: 999 })
        .unwrap();
    let mut delivered = false;
    while !delivered && Instant::now() < deadline {
        delivered = matches!(
            forwarded.recv_timeout(Duration::from_millis(50)),
            Ok(Command::Refresh { request: 999 })
        );
    }
    assert!(delivered, "the loop stopped forwarding after the refusal");
    assert!(!matches!(bridge.mailbox.lock().unwrap().take(), Some(None)));
}

/// #646: a browser pane's header (its address, title and history) is read
/// while the window is in front, whether or not the terminal takes input
/// yet. Input readiness gates what is sent to a page, not what is read.
#[test]
fn browser_controls_are_read_while_input_is_not_ready() {
    let (events, receiver) = mpsc::sync_channel(8);
    let (commands, output) = mpsc::sync_channel(64);
    let bridge = start_events(Default::default(), receiver, true, move || {
        move |command| {
            commands
                .try_send(command)
                .map_err(|_| Error::Invalid("owner closed"))
        }
    });
    let pane = |id: &str, icon: Option<&str>| Choice {
        pane_count: None,
        id: id.into(),
        label: id.into(),
        window_id: Some("window".into()),
        window_label: None,
        browser_icon: icon.map(str::to_owned),
        display_name_source: None,
    };
    events
        .send(Incoming::Catalog(Box::new(State {
            request: 6,
            panes: vec![pane("shell", None), pane("browser", Some("globe"))],
            selected_pane: Some("shell".into()),
            input_ready: false,
            ..State::default()
        })))
        .unwrap();
    let state = next_state(&bridge.mailbox).unwrap();
    assert!(!state.input_ready);
    let deadline = Instant::now() + Duration::from_secs(5);
    let read = loop {
        match output.recv_timeout(Duration::from_millis(50)) {
            Ok(Command::BrowserControls {
                request,
                id,
                command: None,
            }) => break (request, id),
            Ok(_) | Err(mpsc::RecvTimeoutError::Timeout) => {
                assert!(Instant::now() < deadline, "the header was never read");
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => panic!("the worker stopped"),
        }
    };
    assert_eq!(read, (6, "browser".to_owned()));
    // Behind another window nothing is read.
    bridge
        .commands
        .send(Command::Presence {
            active: false,
            revision: 1,
        })
        .unwrap();
    // The worker passes the change on once it has taken it: only what
    // follows that was sent from the background.
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match output.recv_timeout(Duration::from_millis(50)) {
            Ok(Command::Presence { active: false, .. }) => break,
            Ok(_) | Err(mpsc::RecvTimeoutError::Timeout) => {
                assert!(Instant::now() < deadline, "the worker never went back");
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => panic!("the worker stopped"),
        }
    }
    std::thread::sleep(Duration::from_millis(1600));
    assert!(
        !output
            .try_iter()
            .any(|command| matches!(command, Command::BrowserControls { .. })),
        "a window in the background reads no header"
    );
}
