#![allow(clippy::unwrap_used)]
use super::*;

const REV: &str = "0123456789abcdef0123456789abcdef";

fn chunk(offset: u64, bytes: &[u8], revision: &str) -> ReaderChunk {
    ReaderChunk {
        revision: revision.into(),
        size: 10,
        offset,
        bytes: bytes.to_vec(),
    }
}

#[test]
fn pages_reassemble_in_order_and_a_gap_restarts_the_read() {
    let first = assemble(None, chunk(0, b"hello", REV)).unwrap();
    let whole = assemble(Some(first), chunk(5, b"world", REV)).unwrap();
    assert_eq!(whole.bytes, b"helloworld");
    let first = assemble(None, chunk(0, b"hello", REV)).unwrap();
    assert!(assemble(Some(first), chunk(6, b"orld", REV)).is_none());
    let first = assemble(None, chunk(0, b"hello", REV)).unwrap();
    assert!(assemble(Some(first), chunk(5, b"world", &"f".repeat(32))).is_none());
    assert!(assemble(None, chunk(5, b"world", REV)).is_none());
}

#[test]
fn the_next_page_resumes_where_the_held_bytes_end() {
    let held = Progress {
        revision: REV.into(),
        bytes: vec![0; 7],
    };
    assert_eq!(
        page_of(Some(&held)),
        Some(ReaderPage {
            revision: REV.into(),
            offset: 7
        })
    );
}

/// R28, R29 and review round 1, item 3: only visible readers are served, none
/// in the background, and in turn so that a later reader is not starved.
#[test]
fn readers_are_served_in_turn_only_when_visible_and_in_front() {
    let panes: Vec<String> = ["a", "b", "c", "d"].map(String::from).to_vec();
    let visible = |pane: &str| pane != "c";
    assert_eq!(order(true, panes.iter(), visible, None), ["a", "b", "d"]);
    assert_eq!(
        order(true, panes.iter(), visible, Some("a")),
        ["b", "d", "a"]
    );
    assert_eq!(
        order(true, panes.iter(), visible, Some("d")),
        ["a", "b", "d"]
    );
    // A reader that is gone or hidden does not stall the turn.
    assert_eq!(
        order(true, panes.iter(), visible, Some("c")),
        ["a", "b", "d"]
    );
    assert!(order(false, panes.iter(), visible, None).is_empty());
}
