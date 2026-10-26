#![allow(clippy::unwrap_used)]
use super::*;
use serde_json::{Value, json};
fn control() -> Control {
    Control::new(Uuid::from_u128(1), 123, 0, [1; 8]).unwrap()
}
fn peer(control: &Control) -> Vec<u8> {
    serde_json::to_vec(&json!({"type":"terminal-surface-peer", "version":1,
        "generation":control.generation,"connectionNonce":control.nonce,"auditToken":vec![2;8]}))
    .unwrap()
}
#[test]
fn authenticated_control_peer_is_not_ready_without_native_proof() {
    let mut control = control();
    let frame: Value = serde_json::from_str(&control.receiver_frame().unwrap()).unwrap();
    assert_eq!(frame["pid"], 123);
    assert_eq!(frame["slot"], 0);
    assert_ne!(control.challenge(), [0; 16]);
    let raw = peer(&control);
    assert!(control.accept_peer(&raw).unwrap());
    assert!(!control.ready());
    assert!(matches!(
        control.confirm_kernel_peer([3; 8]),
        Err(Error::Identity)
    ));
    control.confirm_kernel_peer([2; 8]).unwrap();
    assert!(control.ready());
    assert!(!control.accept_peer(&raw).unwrap());
    assert!(control.ready());
}
#[test]
fn replacement_scope_and_changed_peer_cannot_rebind_a_connection() {
    let mut first = control();
    let mut replacement = control();
    assert_ne!(first.nonce, replacement.nonce);
    assert_ne!(first.challenge(), replacement.challenge());
    let raw = peer(&first);
    assert!(matches!(
        replacement.accept_peer(&raw),
        Err(Error::Identity)
    ));
    first.accept_peer(&raw).unwrap();
    let mut value: Value = serde_json::from_slice(&raw).unwrap();
    value["auditToken"] = json!(vec![3; 8]);
    assert!(matches!(
        first.accept_peer(&serde_json::to_vec(&value).unwrap()),
        Err(Error::Identity)
    ));
    assert_eq!(first.expected_peer(), Some([2; 8]));
}
#[test]
fn fallback_and_close_are_terminal_but_gpu_retirement_survives_fallback() {
    let mut control = control();
    let raw = peer(&control);
    control.accept_peer(&raw).unwrap();
    control.confirm_kernel_peer([2; 8]).unwrap();
    let frame = control.fallback_frame(FallbackReason::Storage).unwrap();
    assert_eq!(
        control.accept_fallback(frame.as_bytes()).unwrap(),
        FallbackReason::Storage
    );
    assert!(!control.ready());
    assert!(matches!(control.accept_peer(&raw), Err(Error::State)));
    assert!(control.retirement_frame(Retirement { sequence: 1 }).is_ok());
    control.close();
    assert!(matches!(
        control.retirement_frame(Retirement { sequence: 1 }),
        Err(Error::State)
    ));
    assert!(matches!(
        control.accept_fallback(frame.as_bytes()),
        Err(Error::State)
    ));
}
#[test]
fn control_bounds_and_diagnostics_do_not_accept_arbitrary_peer_data() {
    let mut control = control();
    assert!(matches!(
        control.accept_peer(&vec![b' '; 16385]),
        Err(Error::Bounds)
    ));
    let mut value: Value = serde_json::from_slice(&peer(&control)).unwrap();
    value["private-secret"] = json!("secret");
    let error = control
        .accept_peer(&serde_json::to_vec(&value).unwrap())
        .unwrap_err();
    assert!(!format!("{error:?}").contains("secret"));
    value.as_object_mut().unwrap().remove("private-secret");
    value["auditToken"] = json!(vec![0; 8]);
    assert!(matches!(
        control.accept_peer(&serde_json::to_vec(&value).unwrap()),
        Err(Error::Identity)
    ));
    assert!(Control::new(Uuid::nil(), 123, 0, [1; 8]).is_err());
    assert!(Control::new(Uuid::from_u128(1), 123, 32, [1; 8]).is_err());
}

#[test]
fn handshake_timeout_is_bounded_and_duplicate_peers_cannot_extend_it() {
    let mut control = control();
    let started = control.started;
    assert!(
        control
            .poll_timeout(started + Duration::from_secs(4))
            .unwrap()
            .is_none()
    );
    let raw = peer(&control);
    control.accept_peer(&raw).unwrap();
    assert!(!control.accept_peer(&raw).unwrap());
    let fallback = control
        .poll_timeout(started + HANDSHAKE_TIMEOUT)
        .unwrap()
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&fallback).unwrap()["reason"],
        "timeout"
    );
    assert!(control.confirm_kernel_peer([2; 8]).is_err());
    assert!(
        control
            .poll_timeout(started + Duration::from_secs(60))
            .unwrap()
            .is_none()
    );
}
#[test]
fn completed_and_closed_connections_do_not_emit_handshake_timeouts() {
    let mut ready = control();
    ready.accept_peer(&peer(&ready)).unwrap();
    ready.confirm_kernel_peer([2; 8]).unwrap();
    assert!(
        ready
            .poll_timeout(ready.started + Duration::from_secs(60))
            .unwrap()
            .is_none()
    );
    let mut closed = control();
    closed.close();
    assert!(
        closed
            .poll_timeout(closed.started + Duration::from_secs(60))
            .unwrap()
            .is_none()
    );
}
