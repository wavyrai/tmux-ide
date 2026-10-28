use super::*;
#[test]
fn resize_during_native_handoff_discards_only_the_stale_image() {
    use gpui_apple::{
        surface_inbox::{SendStatus, SenderIdentity},
        surface_rendezvous::Registration,
        surface_sender::Sender,
    };
    use std::time::{Duration, Instant};
    use uuid::Uuid;
    let (source, _source_pool, window) = fixture();
    let current = &window.paint.regions[0].source;
    let mut attempt = Registration::begin().unwrap();
    let mut connection = loop {
        if let Some(registration) = attempt.poll().unwrap() {
            break connection::Connection::new(
                Uuid::parse_str(&current.identity.generation).unwrap(),
                registration,
            )
            .unwrap();
        }
        std::thread::sleep(Duration::from_millis(5));
    };
    let descriptor: serde_json::Value =
        serde_json::from_str(&connection.receiver_frame().unwrap()).unwrap();
    let peer = SenderIdentity::current().unwrap();
    let raw = serde_json::to_vec(&serde_json::json!({
        "type":"terminal-surface-peer", "version":1,
        "generation":descriptor["generation"], "connectionNonce":descriptor["connectionNonce"],
        "auditToken":peer.token(),
    }))
    .unwrap();
    connection.accept_peer(&raw).unwrap();
    connection.accept_peer(&raw).unwrap(); // Duplicate must not replace endpoints.
    let now = Instant::now();
    let mut sender = Sender::new(
        std::process::id(),
        descriptor["slot"].as_u64().unwrap() as u8,
        peer,
        *Uuid::parse_str(descriptor["challenge"].as_str().unwrap())
            .unwrap()
            .as_bytes(),
        now + Duration::from_secs(5),
    )
    .unwrap();
    assert!(!sender.poll(now).unwrap());
    assert!(connection.poll(now).unwrap().is_none());
    assert!(sender.poll(now).unwrap());
    let vectors: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../fixtures/native-surface-offers.json"
    ))
    .unwrap();
    let mut offer = vectors["cases"][0]["offer"].clone();
    let surface = CVPixelBufferGetIOSurface(Some(&source.buffer.0)).unwrap();
    offer["stride"] = serde_json::json!(surface.bytes_per_row());
    offer["allocationBytes"] = serde_json::json!(surface.alloc_size());
    connection
        .admit(
            &serde_json::to_vec(&offer).unwrap(),
            "pane.native",
            current,
            now,
        )
        .unwrap();
    let port = SurfacePort::from_surface(&surface).unwrap();
    assert_eq!(
        sender
            .try_send(
                &port,
                *Uuid::parse_str(offer["storageTicket"].as_str().unwrap())
                    .unwrap()
                    .as_bytes(),
                1,
            )
            .unwrap(),
        SendStatus::Queued
    );
    let identity = CommittedIdentity {
        generation: current.identity.generation.clone(),
        incarnation: current.identity.incarnation.clone(),
        delivery_nonce: current.identity.delivery_nonce.clone(),
        canonical_revision: current.identity.canonical_revision + 1,
        canonical_state_hash: "new-canonical-hash".into(),
    };
    let newer = Arc::new(CommittedPane {
        identity: Arc::new(identity),
        snapshot: current.snapshot.clone(),
    });
    assert!(
        connection
            .receive(now, |_| Some(Arc::clone(&newer)))
            .unwrap()
            .is_none()
    );
    let retired: serde_json::Value =
        serde_json::from_str(&connection.next_retirement().unwrap().unwrap()).unwrap();
    assert_eq!(retired["sequence"], 1);
    assert_eq!(connection.reserved_bytes(), 0);
    assert!(connection.poll(now).unwrap().is_none());
    offer["sequence"] = serde_json::json!(2);
    offer["canonicalRevision"] = serde_json::json!(newer.identity.canonical_revision);
    offer["canonicalStateHash"] = serde_json::json!(newer.identity.canonical_state_hash);
    offer["storageTicket"] = serde_json::json!(Uuid::new_v4());
    connection
        .admit(
            &serde_json::to_vec(&offer).unwrap(),
            "pane.native",
            &newer,
            now,
        )
        .unwrap();
    assert_eq!(
        sender
            .try_send(
                &port,
                *Uuid::parse_str(offer["storageTicket"].as_str().unwrap())
                    .unwrap()
                    .as_bytes(),
                2
            )
            .unwrap(),
        SendStatus::Queued
    );
    let recovered = connection
        .receive(now, |_| Some(Arc::clone(&newer)))
        .unwrap();
    assert!(recovered.is_some());
    drop(recovered);
    let retired: serde_json::Value =
        serde_json::from_str(&connection.next_retirement().unwrap().unwrap()).unwrap();
    assert_eq!(retired["sequence"], 2);
    assert_eq!(connection.reserved_bytes(), 0);
}
