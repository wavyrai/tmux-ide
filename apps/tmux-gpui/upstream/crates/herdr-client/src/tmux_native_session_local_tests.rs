//! Real socket + file worker: local success and fallback stay within the issued stream.
use super::*;
use sha2::{Digest, Sha256};
use std::{
    fs,
    os::unix::fs::{PermissionsExt, symlink},
};
#[test]
fn local_file_release_and_inline_failure_fallback_preserve_exact_bytes() {
    for mode in ["valid", "missing", "expired", "symlink", "corrupt"] {
        let total = if mode == "corrupt" { 512 * 257 * 4 } else { 64 };
        let width = if mode == "corrupt" { 512 } else { 4 };
        let height = if mode == "corrupt" { 257 } else { 4 };
        let data = (0..total).map(|v| v as u8).collect::<Vec<_>>();
        let hash = Sha256::digest(&data)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();
        let generation = uuid::Uuid::new_v4().to_string();
        let root = fs::canonicalize(std::env::temp_dir())
            .unwrap()
            .join(format!("local-images-{generation}"));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let store = root.join("local-images-Ab12cd");
        fs::create_dir(&store).unwrap();
        fs::set_permissions(&store, fs::Permissions::from_mode(0o700)).unwrap();
        let path = store.join(&hash);
        if mode != "missing" {
            let mut file_data = data.clone();
            if mode == "corrupt" {
                file_data[total - 1] ^= 1;
            }
            fs::write(&path, &file_data).unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o400)).unwrap();
        }
        if mode == "symlink" {
            let original = store.join("original");
            fs::rename(&path, &original).unwrap();
            symlink(&original, &path).unwrap();
        }
        let (listener, options) = fixture();
        let (done_tx, done_rx) = bounded(1);
        let (released_tx, released_rx) = bounded(1);
        let root_proof = tmux_graphics::LocalImages {
            root: root.to_str().unwrap().into(),
            generation: generation.clone(),
        };
        let lease = uuid::Uuid::new_v4().to_string();
        let peer = thread::spawn(move || {
            let mut socket = accept(listener);
            transaction(&mut socket, 0, false);
            ack(&mut socket, 0);
            let mut state = graphics_state();
            state["images"][0]["digest"] = json!(&hash[..32]);
            state["images"][0]["width"] = json!(width);
            state["images"][0]["height"] = json!(height);
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
            let blob = json!({"digest":&hash[..32],"format":"rgba","width":width,"height":height,"total":total,"offset":0});
            send(
                &mut socket,
                json!({"type":"terminal-graphics-local","pane":"pane.test","generation":generation,"leaseId":lease,"path":path,"expiresAt":if mode=="expired"{now-1}else{now+30_000},"blob":blob}),
            );
            let release: Value =
                serde_json::from_str(&socket.read().unwrap().into_text().unwrap()).unwrap();
            assert_eq!(
                release,
                json!({"type":"terminal-graphics-local-release","pane":"pane.test","generation":generation,"leaseId":lease})
            );
            if mode != "valid" {
                let fallback: Value =
                    serde_json::from_str(&socket.read().unwrap().into_text().unwrap()).unwrap();
                assert_eq!(
                    fallback,
                    json!({"type":"terminal-graphics-request","pane":"pane.test","digests":[&hash[..32]],"preferInline":true})
                );
                for (index, chunk) in data.chunks(tmux_graphics::CHUNK_BYTES).enumerate() {
                    let mut part = blob.clone();
                    part["offset"] = json!(index * tmux_graphics::CHUNK_BYTES);
                    let header =
                        serde_json::to_vec(&json!({"pane":"pane.test","blob":part})).unwrap();
                    let mut bytes = b"TGB1".to_vec();
                    bytes.extend((header.len() as u32).to_be_bytes());
                    bytes.extend(header);
                    bytes.extend(chunk);
                    socket.send(Message::Binary(bytes.into())).unwrap();
                }
            }
            released_tx.send(()).unwrap();
            done_rx.recv_timeout(WAIT).unwrap();
        });
        let session =
            NativeSession::spawn_with_local_images(options, "workspace".into(), root_proof)
                .unwrap();
        released_rx.recv_timeout(WAIT).unwrap();
        until(|| {
            session
                .shared
                .lock()
                .unwrap()
                .graphics
                .iter()
                .any(|event| matches!(event,GraphicsEvent::Chunk(chunk) if chunk.complete_verified))
                .then_some(())
        });
        let updates = session.drain().unwrap();
        assert!(updates.controls.is_empty());
        let mut assembled = Vec::new();
        let mut complete = false;
        let mut invalidated = false;
        for event in updates.graphics {
            match event {
                GraphicsEvent::Invalidate(_) => {
                    assembled.clear();
                    invalidated = true;
                }
                GraphicsEvent::Chunk(chunk) => {
                    assembled.extend(chunk.bytes);
                    complete = chunk.complete_verified;
                }
            }
        }
        assert!(complete);
        assert_eq!(assembled, (0..total).map(|v| v as u8).collect::<Vec<_>>());
        if mode != "valid" {
            assert!(invalidated);
        }
        session.cancel();
        done_tx.send(()).unwrap();
        peer.join().unwrap();
        fs::remove_dir_all(root).unwrap();
    }
}
