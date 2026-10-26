use super::*;
#[path = "tmux_native_surface_controller_tests.rs"]
mod controller;

enum Observed {
    Started(thread::ThreadId),
    Polled,
    Commit(Arc<CommittedPane>),
    Closed,
}
struct Driver {
    events: crossbeam_channel::Sender<Observed>,
    deadline: Option<Instant>,
    wake_mode: bool,
    wake: Option<surfaces::WakeSender>,
}
impl surfaces::Driver for Driver {
    fn set_waker(&mut self, wake: surfaces::WakeSender) {
        self.wake = Some(wake);
    }
    fn start(&mut self, _: &PaneStream) -> Result<(), surfaces::Failure> {
        self.events
            .try_send(Observed::Started(thread::current().id()))
            .unwrap();
        if self.wake_mode {
            self.wake.as_ref().unwrap().try_send(()).unwrap();
        } else {
            self.deadline = Some(Instant::now() + Duration::from_millis(5));
        }
        Ok(())
    }
    fn accept(
        &mut self,
        _: &str,
        committed: &surfaces::Committed,
        _: &PaneStream,
    ) -> Result<(), surfaces::Failure> {
        self.events
            .try_send(Observed::Commit(Arc::clone(
                committed.get("pane.test").unwrap(),
            )))
            .unwrap();
        Ok(())
    }
    fn poll(
        &mut self,
        _: Instant,
        _: &surfaces::Committed,
        _: &PaneStream,
    ) -> Result<(), surfaces::Failure> {
        self.deadline = None;
        self.events.try_send(Observed::Polled).unwrap();
        Ok(())
    }
    fn deadline(&self) -> Option<Instant> {
        self.deadline
    }
    fn close(&mut self) {
        self.events.try_send(Observed::Closed).unwrap();
    }
}

#[test]
fn platform_owner_uses_worker_commit_identity_and_closes_with_its_socket() {
    worker_owner(false);
}
#[test]
fn platform_owner_wakes_without_a_timer_or_incoming_control() {
    worker_owner(true);
}
fn worker_owner(wake_mode: bool) {
    let (listener, options) = fixture();
    let (events, observed) = bounded(8);
    let (done_tx, done_rx) = bounded(1);
    let peer = thread::spawn(move || {
        let mut socket = accept(listener);
        transaction(&mut socket, 0, false);
        ack(&mut socket, 0);
        send(&mut socket, json!({"type":"terminal-surface-peer"}));
        done_rx.recv_timeout(WAIT).unwrap();
    });
    let session = NativeSession::spawn_with_surfaces(
        options,
        "workspace".into(),
        Box::new(Driver {
            events,
            deadline: None,
            wake_mode,
            wake: None,
        }),
    )
    .unwrap();
    let mut polled = false;
    let mut committed = None;
    let mut started = false;
    for _ in 0..3 {
        match observed.recv_timeout(WAIT).unwrap() {
            Observed::Started(id) => {
                assert_ne!(id, thread::current().id());
                started = true;
            }
            Observed::Polled => polled = true,
            Observed::Commit(commit) => committed = Some(commit),
            Observed::Closed => panic!("owner closed early"),
        }
    }
    assert!(started && polled);
    assert!(Arc::ptr_eq(
        &committed.unwrap(),
        &session.committed("pane.test").unwrap().unwrap()
    ));
    assert!(session.drain().unwrap().controls.is_empty());
    session.cancel();
    assert!(matches!(
        observed.recv_timeout(WAIT).unwrap(),
        Observed::Closed
    ));
    done_tx.send(()).unwrap();
    peer.join().unwrap();
}

#[test]
fn authentication_failure_closes_owner_without_starting_it() {
    let (listener, mut options) = fixture();
    options.descriptor.request_id = "10000000-0000-4000-8000-000000000001".into();
    let (events, observed) = bounded(8);
    let (done_tx, done_rx) = bounded(1);
    let peer = thread::spawn(move || {
        let _socket = accept(listener);
        done_rx.recv_timeout(WAIT).unwrap();
    });
    let session = NativeSession::spawn_with_surfaces(
        options,
        "workspace".into(),
        Box::new(Driver {
            events,
            deadline: None,
            wake_mode: false,
            wake: None,
        }),
    )
    .unwrap();
    assert!(matches!(
        observed.recv_timeout(WAIT).unwrap(),
        Observed::Closed
    ));
    until(|| matches!(session.drain().unwrap().status, Status::Failed(_)).then_some(()));
    done_tx.send(()).unwrap();
    peer.join().unwrap();
}
#[test]
fn surface_schema_support_does_not_enable_native_storage() {
    for kind in [
        "terminal-surface-peer",
        "terminal-surface-offer",
        "terminal-surface-fallback",
    ] {
        let (listener, options) = fixture();
        let (done_tx, done_rx) = bounded(1);
        let peer = thread::spawn(move || {
            let mut socket = accept(listener);
            transaction(&mut socket, 0, false);
            ack(&mut socket, 0);
            send(&mut socket, json!({"type":kind}));
            done_rx.recv_timeout(WAIT).unwrap();
        });
        // Even the existing graphics capability cannot authorize native rights.
        let session = NativeSession::spawn_with_graphics(options, "workspace".into()).unwrap();
        until(|| {
            matches!(session.drain().unwrap().status, Status::Failed(ref error) if matches!(error.as_ref(),Error::GraphicsDisabled)).then_some(())
        });
        assert!(session.snapshot("pane.test").unwrap().is_none());
        assert!(session.drain().unwrap().controls.is_empty());
        done_tx.send(()).unwrap();
        peer.join().unwrap();
    }
}
