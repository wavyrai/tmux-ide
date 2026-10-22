#![allow(clippy::unwrap_used)]
use super::*;
use serde_json::{Value, json};
fn vectors() -> Value {
    serde_json::from_str(include_str!("../../../../../bridge/binary-vectors.json")).unwrap()
}
fn hex(s: &str) -> Vec<u8> {
    s.as_bytes()
        .chunks_exact(2)
        .map(|b| u8::from_str_radix(std::str::from_utf8(b).unwrap(), 16).unwrap())
        .collect()
}
fn frame(kind: u8, body: &[u8]) -> Vec<u8> {
    let mut out = b"TIGF\x01\x00\x00\x00".to_vec();
    out[5] = kind;
    out.extend((body.len() as u32).to_be_bytes());
    out.extend(body);
    out
}
fn publication(sequence: u64, vector: usize) -> Vec<u8> {
    let metadata=serde_json::to_vec(&json!({"version":1,"connection":"a","sequence":sequence,"request":4,"inputReady":true,"sessions":[{"id":"s","label":"Session"}],"panes":[{"id":"p","label":"Pane"}],"selectedSession":"s","selectedPane":"p","status":"Ready"})).unwrap();
    let mut body = (metadata.len() as u32).to_be_bytes().to_vec();
    body.extend(metadata);
    body.extend(hex(vectors()["cells"][vector]["hex"].as_str().unwrap()));
    frame(2, &body)
}
#[test]
fn binary_worker_applies_all_deltas_before_coalescing_and_accepts_raw_images() -> Result<(), Error>
{
    let kitty = super::super::super::kitty_graphics::Store::default();
    let mailbox = Arc::new(Mutex::new(None));
    let (tx, rx) = mpsc::sync_channel(32);
    let mut reader = Reader {
        delta: true,
        ..Reader::default()
    };
    let mut wire = publication(1, 0);
    wire.extend(publication(2, 1));
    wire.extend(publication(3, 2));
    let meta=serde_json::to_vec(&json!({"digest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","format":"rgba","width":2,"height":2,"total":16,"offset":0})).unwrap();
    let mut image = (meta.len() as u32).to_be_bytes().to_vec();
    image.extend(meta);
    image.extend([7u8; 16]);
    wire.extend(frame(3, &image));
    binary_loop(&mut wire.as_slice(), &mut reader, &kitty, &mailbox, &tx)?;
    let state = mailbox.lock().unwrap().take().unwrap().unwrap();
    assert!(state.input_ready);
    assert_eq!(state.request, 4);
    assert!(rx.try_recv().is_err());
    assert!(kitty.take_changed());
    let mut reference = decode::delta::Store::default();
    let mut expected = None;
    for value in vectors()["cells"].as_array().unwrap() {
        let decode::delta::Outcome::Ready(next) =
            reference.prepare(&serde_json::to_vec(&value["frame"]).unwrap())?
        else {
            panic!("unexpected missing base")
        };
        expected = Some(next.frame.clone());
        reference.commit(next);
    }
    assert_eq!(format!("{:?}", state.frame), format!("{expected:?}"));
    Ok(())
}
#[test]
fn binary_gap_revokes_input_and_full_recovers_same_request() -> Result<(), Error> {
    let kitty = super::super::super::kitty_graphics::Store::default();
    let mailbox = Arc::new(Mutex::new(None));
    let (tx, rx) = mpsc::sync_channel(32);
    let mut reader = Reader {
        delta: true,
        ..Reader::default()
    };
    binary_loop(
        &mut publication(1, 1).as_slice(),
        &mut reader,
        &kitty,
        &mailbox,
        &tx,
    )?;
    let state = mailbox.lock().unwrap().take().unwrap().unwrap();
    assert!(!state.input_ready);
    assert!(state.frame.is_none());
    assert!(matches!(
        rx.try_recv().unwrap(),
        Command::FrameResync {
            request: 4,
            base_seq: 0,
            ..
        }
    ));
    binary_loop(
        &mut publication(2, 0).as_slice(),
        &mut reader,
        &kitty,
        &mailbox,
        &tx,
    )?;
    let state = mailbox.lock().unwrap().take().unwrap().unwrap();
    assert!(state.input_ready);
    assert_eq!(state.selected_pane.as_deref(), Some("p"));
    assert_eq!(state.request, 4);
    Ok(())
}
#[test]
fn binary_fragment_never_admits_partial_publication_and_json_cannot_smuggle_cells() {
    let kitty = super::super::super::kitty_graphics::Store::default();
    let mailbox = Arc::new(Mutex::new(None));
    let (tx, _rx) = mpsc::sync_channel(32);
    let mut reader = Reader {
        delta: true,
        ..Reader::default()
    };
    let wire = publication(1, 0);
    assert!(
        binary_loop(
            &mut &wire[..wire.len() - 1],
            &mut reader,
            &kitty,
            &mailbox,
            &tx
        )
        .is_err()
    );
    assert!(mailbox.lock().unwrap().is_none());
    let mut control: Value =
        serde_json::from_slice(metadata(&wire[12..], 8 * 1024 * 1024).unwrap().0).unwrap();
    control["snapshot"] = vectors()["cells"][0]["frame"].clone();
    assert!(
        reader
            .accept_control(&serde_json::to_vec(&control).unwrap())
            .is_err()
    );
}
