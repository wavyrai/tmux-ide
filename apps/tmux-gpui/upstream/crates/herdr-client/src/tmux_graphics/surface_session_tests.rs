use super::*;
use crate::tmux_graphics::{
    surface_control::FallbackReason,
    surface_session::{Error as SessionError, Session},
};
use std::time::{Duration, Instant};
use uuid::Uuid;
fn fixture() -> (Session, CommittedPane, Value) {
    let generation = Uuid::from_u128(1);
    let mut pane = pane();
    Arc::get_mut(&mut pane.identity).unwrap().generation = generation.to_string();
    let mut value = offer();
    value["generation"] = json!(generation);
    (
        Session::new(generation, 123, 0, [1; 8]).unwrap(),
        pane,
        value,
    )
}
fn ready(session: &mut Session) {
    let receiver: Value = serde_json::from_str(&session.receiver_frame().unwrap()).unwrap();
    let peer = json!({"type":"terminal-surface-peer","version":1,"generation":receiver["generation"],"connectionNonce":receiver["connectionNonce"],"auditToken":vec![2;8]});
    session
        .accept_peer(&serde_json::to_vec(&peer).unwrap())
        .unwrap();
    session.confirm_kernel_peer([2; 8]).unwrap();
}
#[test]
fn admission_requires_proof_and_same_generation() {
    let (mut session, pane, value) = fixture();
    let now = Instant::now();
    let raw = serde_json::to_vec(&value).unwrap();
    assert!(matches!(
        session.admit(&raw, "pane", &pane, now),
        Err(SessionError::NotReady)
    ));
    assert_eq!(session.reserved_bytes(), 0);
    ready(&mut session);
    let wrong = CommittedPane {
        snapshot: pane.snapshot.clone(),
        identity: Arc::new(CommittedIdentity {
            generation: Uuid::from_u128(2).to_string(),
            incarnation: "incarnation".into(),
            delivery_nonce: "nonce".into(),
            canonical_revision: 7,
            canonical_state_hash: "committed-hash".into(),
        }),
    };
    assert!(matches!(
        session.admit(&raw, "pane", &wrong, now),
        Err(SessionError::Generation)
    ));
    assert_eq!(session.reserved_bytes(), 0);
    session.admit(&raw, "pane", &pane, now).unwrap();
    assert!(session.has_pending());
    let ticket = Uuid::parse_str(value["storageTicket"].as_str().unwrap()).unwrap();
    assert_eq!(session.pending_pane(1, ticket), Some("pane"));
    assert_eq!(session.pending_pane(2, ticket), None);
    assert_eq!(session.pending_pane(1, Uuid::nil()), None);
    session.close();
    assert_eq!(session.pending_pane(1, ticket), None);
}
#[test]
fn fallback_releases_pending_but_gpu_storage_waits_for_final_drop() {
    let (mut session, pane, mut value) = fixture();
    ready(&mut session);
    let now = Instant::now();
    session
        .admit(&serde_json::to_vec(&value).unwrap(), "pane", &pane, now)
        .unwrap();
    let ticket = Uuid::parse_str(value["storageTicket"].as_str().unwrap()).unwrap();
    let (accepted, ()) = session.bind(1, ticket, (), "pane", &pane, now).unwrap();
    let gpu = accepted.storage_lease();
    drop(accepted);
    value["sequence"] = json!(2);
    session
        .admit(&serde_json::to_vec(&value).unwrap(), "pane", &pane, now)
        .unwrap();
    session.fallback(FallbackReason::Storage).unwrap();
    assert!(!session.has_pending());
    let retired: Value =
        serde_json::from_str(&session.next_retirement().unwrap().unwrap()).unwrap();
    assert_eq!(retired["sequence"], 2);
    assert_eq!(session.reserved_bytes(), 4096);
    assert!(session.next_retirement().unwrap().is_none());
    drop(gpu);
    let retired: Value =
        serde_json::from_str(&session.next_retirement().unwrap().unwrap()).unwrap();
    assert_eq!(retired["sequence"], 1);
    assert_eq!(session.reserved_bytes(), 0);
}
#[test]
fn closure_suppresses_pending_and_late_gpu_acknowledgments() {
    let (mut session, pane, value) = fixture();
    ready(&mut session);
    let now = Instant::now();
    session
        .admit(&serde_json::to_vec(&value).unwrap(), "pane", &pane, now)
        .unwrap();
    let ticket = Uuid::parse_str(value["storageTicket"].as_str().unwrap()).unwrap();
    let (accepted, ()) = session.bind(1, ticket, (), "pane", &pane, now).unwrap();
    let gpu = accepted.storage_lease();
    drop(accepted);
    session.close();
    assert!(!session.has_pending());
    drop(gpu);
    assert!(session.next_retirement().unwrap().is_none());
    assert!(
        session
            .admit(&serde_json::to_vec(&value).unwrap(), "pane", &pane, now)
            .is_err()
    );
}
#[test]
fn expiry_and_pane_replacement_retire_without_import() {
    let (mut session, pane, mut value) = fixture();
    ready(&mut session);
    let now = Instant::now();
    session
        .admit(&serde_json::to_vec(&value).unwrap(), "pane", &pane, now)
        .unwrap();
    session.poll(now + Duration::from_secs(5)).unwrap();
    assert!(!session.has_pending());
    assert!(session.next_retirement().unwrap().is_some());
    value["sequence"] = json!(2);
    session
        .admit(&serde_json::to_vec(&value).unwrap(), "pane", &pane, now)
        .unwrap();
    let ticket = Uuid::parse_str(value["storageTicket"].as_str().unwrap()).unwrap();
    let (_, replacement, _) = fixture();
    let right = Arc::new(());
    let weak = Arc::downgrade(&right);
    assert!(
        session
            .bind(2, ticket, right, "pane", &replacement, now)
            .is_err()
    );
    assert!(weak.upgrade().is_none());
    assert!(session.next_retirement().unwrap().is_some());
    assert_eq!(session.reserved_bytes(), 0);
}
