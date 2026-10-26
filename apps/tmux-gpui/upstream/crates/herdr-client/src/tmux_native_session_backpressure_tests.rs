use super::*;
use sha2::{Digest, Sha256};
use std::{fs, os::unix::fs::PermissionsExt};

struct Scratch(std::path::PathBuf);
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn slow_consumer_keeps_local_images_bounded_and_terminal_connected() {
    let data = vec![73u8; 1536 * 1536 * 4];
    let hash = Sha256::digest(&data)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    let generation = uuid::Uuid::new_v4().to_string();
    let root_path = fs::canonicalize(std::env::temp_dir())
        .unwrap()
        .join(format!("local-images-{generation}"));
    fs::create_dir(&root_path).unwrap();
    let _root = Scratch(root_path.clone());
    fs::set_permissions(&root_path, fs::Permissions::from_mode(0o700)).unwrap();
    let store = root_path.join("local-images-Ab12cd");
    fs::create_dir(&store).unwrap();
    fs::set_permissions(&store, fs::Permissions::from_mode(0o700)).unwrap();
    let path = store.join(&hash);
    fs::write(&path, &data).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o400)).unwrap();
    let proof = tmux_graphics::LocalImages {
        root: root_path.to_str().unwrap().into(),
        generation: generation.clone(),
    };
    let (listener, options) = fixture();
    let (full_tx, full_rx) = bounded(1);
    let (done_tx, done_rx) = bounded(1);
    let (release_tx, release_rx) = bounded(1);
    let total = data.len();
    let peer = thread::spawn(move || {
        let mut socket = accept(listener);
        transaction(&mut socket, 0, false);
        ack(&mut socket, 0);
        let mut state = graphics_state();
        state["images"][0]["digest"] = json!(&hash[..32]);
        state["images"][0]["width"] = json!(1536);
        state["images"][0]["height"] = json!(1536);
        state["images"][0]["bytes"] = json!(total);
        state["placements"][0]["digest"] = json!(&hash[..32]);
        state["localFiles"] = json!(true);
        state["binaryBlobs"] = json!(true);
        send(
            &mut socket,
            json!({"type":"terminal-graphics","pane":"pane.test","state":state}),
        );
        let request: Value =
            serde_json::from_str(&socket.read().unwrap().into_text().unwrap()).unwrap();
        assert_eq!(request["type"], "terminal-graphics-request");
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        let lease = uuid::Uuid::new_v4().to_string();
        send(
            &mut socket,
            json!({"type":"terminal-graphics-local","pane":"pane.test","generation":generation,"leaseId":lease,"path":path,"expiresAt":now+30_000,"blob":{"digest":&hash[..32],"format":"rgba","width":1536,"height":1536,"total":total,"offset":0}}),
        );
        full_rx.recv_timeout(WAIT).unwrap();
        // A control event must still be delivered while file reads are paused.
        send(
            &mut socket,
            json!({"type":"layout-snapshot","topologyEpoch":1,"layouts":[]}),
        );
        let release: Value =
            serde_json::from_str(&socket.read().unwrap().into_text().unwrap()).unwrap();
        assert_eq!(release["type"], "terminal-graphics-local-release");
        assert_eq!(release["leaseId"], lease);
        release_tx.send(()).unwrap();
        done_rx.recv_timeout(WAIT).unwrap();
    });
    let session =
        NativeSession::spawn_with_local_images(options, "workspace".into(), proof).unwrap();
    until(|| {
        let m = session.shared.lock().unwrap();
        (m.graphics_bytes > GRAPHICS_BYTES - 2 * tmux_graphics::CHUNK_BYTES
            || matches!(m.status, Status::Failed(_)))
        .then_some(())
    });
    full_tx.send(()).unwrap();
    until(|| {
        let m = session.shared.lock().unwrap();
        assert!(
            !matches!(m.status, Status::Failed(_)),
            "local reader disconnected a slow consumer"
        );
        assert!(m.graphics_bytes <= GRAPHICS_BYTES && m.graphics.len() <= GRAPHICS_COUNT);
        (!m.controls.is_empty()).then_some(())
    });
    thread::sleep(Duration::from_millis(200));
    assert!(
        !matches!(session.shared.lock().unwrap().status, Status::Failed(_)),
        "paused local reader must preserve the terminal"
    );
    let mut assembled = Vec::new();
    let mut complete = false;
    until(|| {
        let update = session.drain().unwrap();
        assert!(!matches!(update.status, Status::Failed(_)));
        for event in update.graphics {
            if let GraphicsEvent::Chunk(chunk) = event {
                assert_eq!(chunk.metadata.blob.offset, assembled.len());
                assembled.extend(chunk.bytes);
                complete |= chunk.complete_verified;
            }
        }
        complete.then_some(())
    });
    assert_eq!(assembled, data);
    release_rx.recv_timeout(WAIT).unwrap();
    assert!(session.snapshot("pane.test").unwrap().is_some());
    session.cancel();
    done_tx.send(()).unwrap();
    peer.join().unwrap();
}
