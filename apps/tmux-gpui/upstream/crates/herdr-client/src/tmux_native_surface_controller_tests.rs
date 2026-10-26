use super::*;
use crate::{
    tmux_controller::{Controller, Error as ControllerError},
    tmux_handoff::Handoff,
};
struct Probe(crossbeam_channel::Sender<u8>);
impl surfaces::Driver for Probe {
    fn start(&mut self, _: &PaneStream) -> Result<(), surfaces::Failure> {
        self.0.try_send(1).unwrap();
        Ok(())
    }
    fn accept(
        &mut self,
        _: &str,
        _: &surfaces::Committed,
        _: &PaneStream,
    ) -> Result<(), surfaces::Failure> {
        self.0.try_send(2).unwrap();
        Ok(())
    }
    fn poll(
        &mut self,
        _: Instant,
        _: &surfaces::Committed,
        _: &PaneStream,
    ) -> Result<(), surfaces::Failure> {
        Ok(())
    }
    fn deadline(&self) -> Option<Instant> {
        None
    }
    fn close(&mut self) {
        self.0.try_send(0).unwrap();
    }
}
fn handoff(options: ConnectOptions) -> Handoff {
    let d = options.descriptor;
    let mut handoff = Handoff::parse(&serde_json::to_vec(&json!({
        "descriptor":{"protocolVersion":d.protocol_version,"webSocketUrl":d.web_socket_url,"subprotocol":d.subprotocol,
        "redemptionTicket":d.redemption_ticket,"daemonInstanceId":d.daemon_instance_id,"requestId":d.request_id,
        "expiresAt":d.expires_at,"panes":d.panes,"effectiveViewerMode":d.effective_viewer_mode},
        "origin":options.origin,"hostClientId":options.host_client_id,"workspaceName":"workspace","selectedPane":"pane.test",
        "graphics":true,"binaryCells":true,"alternateScreenProjection":true
    })).unwrap()).unwrap();
    handoff.remote_peer = options.remote_peer;
    handoff
}
#[test]
fn controller_preserves_binary_and_projection_offers_with_platform_owner() {
    let (listener, options) = fixture();
    let (events, observed) = bounded(4);
    let (done_tx, done_rx) = bounded(1);
    let peer = thread::spawn(move || {
        let mut socket = accept_offered(listener, "semantic-binary-v1", true);
        // This control is ordered after delivery-ready. Reaching the platform
        // owner proves both negotiated encodings survived controller startup.
        send(&mut socket, json!({"type":"terminal-surface-peer"}));
        done_rx.recv_timeout(WAIT).unwrap();
    });
    let mut controller =
        Controller::spawn_with_surfaces(handoff(options), Box::new(Probe(events))).unwrap();
    assert_eq!(observed.recv_timeout(WAIT).unwrap(), 1);
    assert_eq!(observed.recv_timeout(WAIT).unwrap(), 2);
    controller.poll(0).unwrap();
    controller.retire();
    assert_eq!(observed.recv_timeout(WAIT).unwrap(), 0);
    done_tx.send(()).unwrap();
    peer.join().unwrap();
}
#[test]
fn unsupported_handoffs_reject_before_socket_or_platform_start() {
    for remote in [false, true] {
        let (listener, options) = fixture();
        listener.set_nonblocking(true).unwrap();
        let mut handoff = handoff(options);
        if remote {
            handoff.remote_peer = Some(serde_json::from_value(json!({"pid":123,"protocolVersion":4,"productVersion":"2.9.12","instanceId":INSTANCE,"startedAt":"2026-10-25T00:00:00Z"})).unwrap());
        } else {
            handoff.graphics = false;
        }
        let (events, observed) = bounded(4);
        assert!(matches!(
            Controller::spawn_with_surfaces(handoff, Box::new(Probe(events))),
            Err(ControllerError::Session(Error::GraphicsDisabled))
        ));
        assert_eq!(observed.recv_timeout(WAIT).unwrap(), 0);
        assert_eq!(
            listener.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
    }
}
