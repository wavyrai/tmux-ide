#![allow(clippy::unwrap_used)]
use super::super::{LocalFrame, now_ms};
use super::*;
use crate::tmux_graphics::{Blob, Format};
use sha2::{Digest, Sha256};
use std::{
    fs,
    os::unix::fs::{PermissionsExt, symlink},
    path::PathBuf,
};
struct Fixture {
    parent: PathBuf,
    root: LocalImages,
    job: Arc<Job>,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.parent);
    }
}
fn fixture(bytes: &[u8]) -> Fixture {
    let parent = fs::canonicalize(std::env::temp_dir())
        .unwrap()
        .join(format!("native-image-test-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&parent).unwrap();
    let generation = uuid::Uuid::new_v4().to_string();
    let root = parent.join(format!("local-images-{generation}"));
    fs::create_dir(&root).unwrap();
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
    let store = root.join("local-images-Ab123x");
    fs::create_dir(&store).unwrap();
    fs::set_permissions(&store, fs::Permissions::from_mode(0o700)).unwrap();
    let hash = Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    let path = store.join(&hash);
    fs::write(&path, bytes).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o400)).unwrap();
    let root = LocalImages {
        root: root.to_str().unwrap().into(),
        generation: generation.clone(),
    };
    let frame=LocalFrame::parse(&serde_json::json!({"type":"terminal-graphics-local","pane":"pane","generation":generation,"leaseId":uuid::Uuid::new_v4().to_string(),"path":path,"expiresAt":now_ms()+30_000,"blob":{"digest":&hash[..32],"format":"png","width":1,"height":1,"total":bytes.len(),"offset":0}}).to_string(),&root).unwrap();
    Fixture {
        parent,
        root,
        job: Arc::new(Job {
            frame,
            incarnation: "pane:1".into(),
            cancelled: AtomicBool::new(false),
        }),
    }
}
fn read_fixture(f: &Fixture) -> std::io::Result<Vec<ReadEvent>> {
    let (send, receive) = bounded(8);
    read(&f.root, &f.job, &send, &AtomicBool::new(false))?;
    Ok(receive.try_iter().collect())
}
#[test]
fn exact_raw_bytes_are_chunked_and_final_only_after_full_digest() {
    let bytes = vec![255; CHUNK_BYTES + 3];
    let f = fixture(&bytes);
    let events = read_fixture(&f).unwrap();
    assert_eq!(events.len(), 2);
    let mut got = Vec::new();
    for (index, event) in events.into_iter().enumerate() {
        let ReadEvent::Chunk {
            offset,
            bytes,
            complete,
            ..
        } = event
        else {
            panic!("unexpected failure")
        };
        assert_eq!(offset, got.len());
        assert_eq!(complete, index == 1);
        got.extend(bytes);
    }
    assert_eq!(got, bytes);
}
#[test]
fn async_worker_returns_exact_file_and_stops_on_drop() {
    let f = fixture(&[0, 128, 255]);
    let reader = Reader::spawn(f.root.clone()).unwrap();
    assert!(reader.submit(Arc::clone(&f.job)));
    let event = reader.events.recv_timeout(Duration::from_secs(2)).unwrap();
    assert!(matches!(event,ReadEvent::Chunk{bytes,complete:true,..} if bytes==[0,128,255]));
}
#[test]
fn refuses_file_symlink_and_directory_symlink() {
    let f = fixture(&[1, 2, 3]);
    let path = PathBuf::from(&f.job.frame.path);
    let copy = f.parent.join("copy");
    fs::rename(&path, &copy).unwrap();
    symlink(&copy, &path).unwrap();
    assert!(read_fixture(&f).is_err());
    fs::remove_file(&path).unwrap();
    fs::rename(&copy, &path).unwrap();
    let store = path.parent().unwrap();
    let moved = f.parent.join("moved");
    fs::rename(store, &moved).unwrap();
    symlink(&moved, store).unwrap();
    assert!(read_fixture(&f).is_err());
}
#[test]
fn refuses_mutable_permissions_wrong_size_and_digest() {
    let f = fixture(&[1, 2, 3]);
    let path = &f.job.frame.path;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
    assert!(read_fixture(&f).is_err());
    fs::write(path, [1, 2]).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o400)).unwrap();
    assert!(read_fixture(&f).is_err());
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
    fs::write(path, [1, 2, 4]).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o400)).unwrap();
    assert!(read_fixture(&f).is_err());
}
#[test]
fn refuses_expired_and_cancelled_jobs_and_shared_roots() {
    let mut f = fixture(&[1]);
    Arc::get_mut(&mut f.job).unwrap().frame.expires_at = now_ms() - 1;
    assert!(read_fixture(&f).is_err());
    Arc::get_mut(&mut f.job).unwrap().frame.expires_at = now_ms() + 30_000;
    f.job.cancelled.store(true, Ordering::Release);
    assert!(read_fixture(&f).is_err());
    f.job.cancelled.store(false, Ordering::Release);
    fs::set_permissions(&f.root.root, fs::Permissions::from_mode(0o755)).unwrap();
    assert!(read_fixture(&f).is_err());
}
#[test]
fn schema_rejects_traversal_wrong_generation_and_unknown_metadata() {
    let f = fixture(&[1]);
    let valid = serde_json::json!({"type":"terminal-graphics-local","pane":"pane","generation":f.root.generation,"leaseId":uuid::Uuid::new_v4().to_string(),"path":f.job.frame.path,"expiresAt":now_ms()+30_000,"blob":Blob{digest:f.job.frame.blob.digest.clone(),format:Format::Png,width:1,height:1,total:1,offset:0}});
    for (key, value) in [
        (
            "generation",
            serde_json::json!(uuid::Uuid::new_v4().to_string()),
        ),
        (
            "path",
            serde_json::json!(format!("{}/../image", f.root.root)),
        ),
        ("extra", serde_json::json!(true)),
    ] {
        let mut bad = valid.clone();
        bad[key] = value;
        assert!(LocalFrame::parse(&bad.to_string(), &f.root).is_err());
    }
}

#[test]
fn job_admission_is_bounded_while_results_are_backpressured() {
    let f = fixture(&vec![1; CHUNK_BYTES * 8]);
    let reader = Reader::spawn(f.root.clone()).unwrap();
    assert!(reader.submit(Arc::clone(&f.job)));
    assert!(matches!(
        reader.events.recv_timeout(Duration::from_secs(2)).unwrap(),
        ReadEvent::Chunk { .. }
    ));
    for _ in 0..8 {
        assert!(reader.submit(Arc::clone(&f.job)));
    }
    assert!(!reader.submit(Arc::clone(&f.job)));
}
