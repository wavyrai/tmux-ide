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
    let bridge = start_events(Default::default(), receiver, move || {
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
    let bridge = start_events(Default::default(), receiver, || {
        |_| Err(Error::Invalid("owner unavailable"))
    });
    bridge.commands.send(Command::Home { request: 1 }).unwrap();
    assert!(next_state(&bridge.mailbox).is_none());
}
