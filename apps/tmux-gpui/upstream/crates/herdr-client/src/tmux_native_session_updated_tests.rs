use super::*;

/// A commit wakes whoever waits on the mailbox, at once: the terminal loop no
/// longer finds a frame up to 5 ms late by polling (conn-app-o, 17 Nov).
#[test]
fn a_commit_signals_its_mailbox_update() {
    let (listener, options) = fixture();
    let (go_tx, go_rx) = bounded(1);
    let peer = thread::spawn(move || {
        let mut socket = accept(listener);
        go_rx.recv_timeout(WAIT).unwrap();
        transaction(&mut socket, 0, false);
        ack(&mut socket, 0);
        let _ = socket.read();
    });
    let session = NativeSession::spawn(options, "workspace".into()).unwrap();
    until(|| matches!(session.drain().unwrap().status, Status::Ready(_)).then_some(()));
    // The worker signals at the top of each turn, after what the last turn
    // published, so the turns that settle the opened stream may still signal
    // after `drain` saw Ready. Wait for them to end (a silence), bounded: a
    // worker that keeps turning while idle never falls silent.
    let settled = Instant::now();
    loop {
        assert!(
            settled.elapsed() < WAIT,
            "an idle session kept signalling updates"
        );
        if session
            .updated()
            .recv_timeout(Duration::from_millis(150))
            .is_err()
        {
            break;
        }
    }
    go_tx.send(()).unwrap();
    // Each wait ends on a signal; the commit is there after one of them.
    let started = Instant::now();
    while session.snapshot("pane.test").unwrap().is_none() {
        assert!(started.elapsed() < WAIT, "the commit never arrived");
        session.updated().recv_timeout(WAIT).unwrap();
    }
    // Let the peer read the ACK before the session closes.
    thread::sleep(Duration::from_millis(100));
    drop(session);
    peer.join().unwrap();
}
