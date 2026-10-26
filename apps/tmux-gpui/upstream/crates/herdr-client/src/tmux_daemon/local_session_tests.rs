#![allow(clippy::unwrap_used)]
use super::*;
#[test]
fn cloned_proofs_share_consumption_and_replacement_is_rejected() {
    let stamp = LocalOwnerStamp([1; 32]);
    let proof = LocalSessionProof {
        owner: stamp.clone(),
        generation: Uuid::new_v4().to_string(),
        consumed: Arc::new(AtomicBool::new(false)),
    };
    let clone = proof.clone();
    assert!(proof.claim(&stamp).is_ok());
    assert!(matches!(clone.claim(&stamp), Err(Error::Retired)));
    let proof = LocalSessionProof {
        owner: stamp,
        generation: Uuid::new_v4().to_string(),
        consumed: Arc::new(AtomicBool::new(false)),
    };
    assert!(matches!(
        proof.claim(&LocalOwnerStamp([2; 32])),
        Err(Error::RecordChanged)
    ));
    assert!(matches!(
        proof.claim(&LocalOwnerStamp([1; 32])),
        Err(Error::Retired)
    ));
}
#[test]
fn receipt_requires_success_envelope_and_exact_operation_and_owner() {
    let operation = Uuid::new_v4();
    let generation = Uuid::new_v4().to_string();
    let mut value = serde_json::json!({"ok":true,"result":{"operationId":operation,"daemonInstanceId":generation,"outcome":"created","fleetSessionId":"session.0123456789abcdef","workspaceName":"fixture","displayName":"Fixture","liveSessionId":"live-session.0123456789abcdef0123"}});
    let bytes = serde_json::to_vec(&value).unwrap();
    assert!(parse(&bytes, operation, &generation).is_ok());
    assert!(parse(&bytes, Uuid::new_v4(), &generation).is_err());
    assert!(parse(&bytes, operation, "other").is_err());
    value["ok"] = false.into();
    assert!(parse(&serde_json::to_vec(&value).unwrap(), operation, &generation).is_err());
    value["ok"] = true.into();
    value["unexpected"] = true.into();
    assert!(parse(&serde_json::to_vec(&value).unwrap(), operation, &generation).is_err());
    assert!(parse(&vec![b' '; 256 * 1024 + 1], operation, &generation).is_err());
}
#[test]
fn concurrent_claim_has_exactly_one_winner() {
    let stamp = LocalOwnerStamp([3; 32]);
    let proof = LocalSessionProof {
        owner: stamp.clone(),
        generation: Uuid::new_v4().to_string(),
        consumed: Arc::new(AtomicBool::new(false)),
    };
    let barrier = Arc::new(std::sync::Barrier::new(8));
    let handles: Vec<_> = (0..8)
        .map(|_| {
            let p = proof.clone();
            let stamp = stamp.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                p.claim(&stamp).is_ok()
            })
        })
        .collect();
    assert_eq!(
        handles
            .into_iter()
            .map(|h| usize::from(h.join().unwrap()))
            .sum::<usize>(),
        1
    );
}
#[cfg(unix)]
#[path = "local_session_socket_tests.rs"]
mod socket;
