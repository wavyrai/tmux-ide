#![allow(clippy::unwrap_used)]
use super::*;
use crate::tmux_delivery::{Cell, Color, History, Row, Snapshot, Update, decode_compact};
use serde_json::json;
use std::sync::Arc;
const UUID: &str = "12345678-1234-4234-8234-123456789abc";
fn scope() -> Scope {
    Scope {
        lifetime: 1,
        workspace_name: "workspace".into(),
        pane: "pane".into(),
        generation: UUID.into(),
        incarnation: "incarnation".into(),
    }
}
fn proof(revision: u64) -> Proof {
    Proof {
        workspace_name: "workspace".into(),
        semantic_pane_id: "pane".into(),
        generation: UUID.into(),
        incarnation: "incarnation".into(),
        revision,
        state_hash: format!("{revision:016x}"),
    }
}
/// A row of `cols` cells, each the grapheme `text`, as the wire's
/// `[0, [[cols, text, 1, 0, 0, 0]]]`.
fn row(text: &str, cols: usize) -> Arc<Row> {
    Arc::new(Row::new(
        vec![
            Cell {
                grapheme: text.into(),
                width: 1,
                foreground: Color::Default,
                background: Color::Default,
                attributes: 0,
            };
            cols
        ],
        false,
    ))
}
fn snapshot(history: usize, cols: usize) -> Arc<Snapshot> {
    with_history(
        (0..history).map(|i| row(&i.to_string(), cols)).collect(),
        cols,
    )
}
fn with_history(history: Vec<Arc<Row>>, cols: usize) -> Arc<Snapshot> {
    let row = |s: &str| json!([0, [[cols, s, 1, 0, 0, 0]]]);
    let bytes=serde_json::to_vec(&json!({"v":1,"k":"terminal-semantic-compact","f":"s","r":0,
        "s":[cols,2,[row("A"),row("B")],[],[0,0,0,"block",0],[0,0,0,0,0,0,1,0,null,null,0],[],["authoritative-stream","observed-from-start"]]})).unwrap();
    let Update::Seed { mut snapshot, .. } = decode_compact(&bytes).unwrap() else {
        panic!("seed")
    };
    snapshot.history = History::from(history);
    Arc::new(snapshot)
}
#[test]
fn scroll_uses_shared_rows_and_unique_identity_survives_append() {
    let first = snapshot(5, 2);
    let mut viewport = Viewport::default();
    viewport.update(scope(), first.clone());
    viewport.scroll(Scroll::Wheel(2));
    let anchor = first.history.materialized().unwrap()[3].clone();
    assert_eq!(viewport.capture_index(), Some(3));
    assert!(Arc::ptr_eq(&viewport.view().unwrap().grid[0], &anchor));
    let mut next = (*first).clone();
    next.history
        .materialized_mut()
        .unwrap()
        .push(first.grid[0].clone());
    viewport.update(scope(), Arc::new(next));
    assert_eq!(viewport.offset(), 3);
    assert!(Arc::ptr_eq(&viewport.view().unwrap().grid[0], &anchor));
    assert!(viewport.view().unwrap().cursor.hidden);
    viewport.update(scope(), snapshot(6, 2));
    assert_eq!(viewport.offset(), 0); // Same text never proves canonical identity.
}
#[test]
fn pages_bounds_duplicate_anchor_and_lifetime_reset() {
    let first = snapshot(MAX_ROWS + 100, 1);
    let mut v = Viewport::default();
    v.update(scope(), first.clone());
    v.scroll(Scroll::Home);
    assert_eq!(v.offset(), MAX_ROWS);
    assert_eq!(v.capture_index(), Some(100));
    v.scroll(Scroll::End);
    assert_eq!(v.offset(), 0);
    v.scroll(Scroll::PageUp);
    assert_eq!(v.offset(), 1);
    v.scroll(Scroll::PageDown);
    assert_eq!(v.offset(), 0);
    let mut next = (*first).clone();
    let a = next.history.materialized().unwrap().last().unwrap().clone();
    next.history.materialized_mut().unwrap().push(a);
    v.update(scope(), Arc::new(next));
    v.scroll(Scroll::Wheel(1));
    assert_eq!(v.capture_index(), None);
    let mut newer = scope();
    newer.lifetime = 2;
    v.update(newer, first);
    assert_eq!(v.offset(), 0);
}
/// The scrollback holds the newest `MAX_ROWS` rows: one more drops the
/// oldest, and Home shows the oldest row held at the top of the view.
#[test]
fn ten_thousand_rows_scroll_to_the_oldest_and_one_more_drops_the_oldest() {
    assert_eq!(MAX_ROWS, 10_000);
    for extra in [0, 1, 2] {
        let s = snapshot(MAX_ROWS + extra, 80);
        let history = s.history.materialized().unwrap();
        let mut v = Viewport::default();
        v.update(scope(), s.clone());
        assert_eq!(v.history_len(), MAX_ROWS);
        v.scroll(Scroll::Home);
        assert_eq!(v.offset(), MAX_ROWS);
        let view = v.view().unwrap();
        assert!(Arc::ptr_eq(&view.grid[0], &history[extra]));
        assert!(Arc::ptr_eq(&view.grid[1], &history[extra + 1]));
        assert_eq!(v.capture_index(), Some(extra));
        // Back down a page at a time to the live screen.
        let mut pages = 0;
        while v.offset() > 0 {
            v.scroll(Scroll::PageDown);
            pages += 1;
        }
        assert_eq!(pages, MAX_ROWS);
        assert!(Arc::ptr_eq(&v.view().unwrap().grid[0], &s.grid[0]));
    }
}
/// The byte bound counts each row's memory: rows that fill `MAX_BYTES`
/// exactly are all held, and one more row drops the oldest.
#[test]
fn the_byte_bound_holds_rows_up_to_exactly_max_bytes() {
    let fixed = row("x", 1).heap_bytes() - 1;
    let cols = 2048 - fixed;
    let wide = row("x", cols);
    assert_eq!(wide.heap_bytes(), 2048);
    let fit = MAX_BYTES / 2048;
    assert_eq!(fit * 2048, MAX_BYTES);
    assert!(fit < MAX_ROWS);
    for extra in [0, 1] {
        let mut history = vec![wide.clone(); fit + extra];
        let oldest = row("o", cols);
        history[extra] = oldest.clone();
        let mut v = Viewport::default();
        v.update(scope(), with_history(history, cols));
        assert_eq!(v.history_len(), fit);
        v.scroll(Scroll::Home);
        assert!(Arc::ptr_eq(&v.view().unwrap().grid[0], &oldest));
    }
}
/// The byte bound keeps the newest rows: past it, an old wide row is dropped
/// while the narrow newer rows stay.
#[test]
fn the_byte_bound_drops_the_oldest_rows_first() {
    let fixed = row("x", 1).heap_bytes() - 1;
    let cols = 2048 - fixed;
    let narrow = row(" ", cols);
    let wide = row("123", cols);
    assert!(wide.heap_bytes() > 2 * narrow.heap_bytes());
    let fit = MAX_BYTES / narrow.heap_bytes();
    let mut history = vec![wide.clone(); 2];
    history.extend(vec![narrow.clone(); fit - 1]);
    let mut v = Viewport::default();
    v.update(scope(), with_history(history, cols));
    assert_eq!(v.history_len(), fit - 1);
    v.scroll(Scroll::Home);
    assert!(Arc::ptr_eq(&v.view().unwrap().grid[0], &narrow));
}
#[test]
fn byte_cap_and_alternate_screen_clear_history() {
    // Each row holds 4096 cells of a three-byte grapheme: about 28 KiB.
    let first = with_history(vec![row("123", 4096); 1000], 4096);
    let mut v = Viewport::default();
    v.update(scope(), first.clone());
    v.scroll(Scroll::Home);
    assert!(v.offset() > 0 && v.offset() < 1000);
    let mut next = (*first).clone();
    next.modes.alternate_screen = true;
    v.update(scope(), Arc::new(next));
    v.scroll(Scroll::Home);
    assert_eq!(v.offset(), 0);
}
#[test]
fn capture_restore_and_stale_response_fencing() {
    let first = snapshot(10, 2);
    let mut v = Viewport::default();
    v.update(scope(), first.clone());
    let mut r = Restoration::default();
    r.observe(proof(1), &mut v, 0);
    v.scroll(Scroll::Wheel(3));
    let old = r.capture(proof(1), &v).unwrap();
    let current = r.capture(proof(1), &v).unwrap();
    assert!(!r.complete(
        &old.ticket,
        Some(AnchorResult::Captured { token: UUID.into() }),
        &mut v,
        0
    ));
    assert!(r.complete(
        &current.ticket,
        Some(AnchorResult::Captured { token: UUID.into() }),
        &mut v,
        0
    ));
    assert_eq!(r.token(), Some(UUID));
    v.scroll(Scroll::End);
    let action = r.restore(proof(1), &v, UUID.into(), 100).unwrap();
    assert!(r.complete(
        &action.ticket,
        Some(AnchorResult::Resolved {
            proof: proof(1),
            history_index: 7
        }),
        &mut v,
        200
    ));
    assert_eq!(v.offset(), 3);
    assert_eq!(r.state(), HistoryState::Historical);
    let action = r.restore(proof(1), &v, UUID.into(), 1000).unwrap();
    r.tick(4000);
    assert_eq!(r.state(), HistoryState::Unavailable);
    assert!(!r.complete(
        &action.ticket,
        Some(AnchorResult::Resolved {
            proof: proof(1),
            history_index: 7
        }),
        &mut v,
        4001
    ));
}
#[test]
fn response_can_precede_matching_publication_but_not_selection_lifetime() {
    let first = snapshot(10, 2);
    let mut v = Viewport::default();
    v.update(scope(), first.clone());
    let mut r = Restoration::default();
    r.observe(proof(1), &mut v, 0);
    let action = r.restore(proof(1), &v, UUID.into(), 0).unwrap();
    r.complete(
        &action.ticket,
        Some(AnchorResult::Resolved {
            proof: proof(2),
            history_index: 8,
        }),
        &mut v,
        1,
    );
    assert_eq!(r.state(), HistoryState::Restoring);
    r.observe(proof(2), &mut v, 0);
    assert_eq!(v.offset(), 2);
    let action = r.restore(proof(2), &v, UUID.into(), 0).unwrap();
    let mut changed = scope();
    changed.lifetime = 2;
    v.update(changed, first);
    r.observe(proof(2), &mut v, 0);
    assert!(!r.complete(
        &action.ticket,
        Some(AnchorResult::Resolved {
            proof: proof(2),
            history_index: 8
        }),
        &mut v,
        1
    ));
    assert_eq!(r.state(), HistoryState::Live);
}
#[test]
fn strict_owner_response_is_bounded_and_server_fenced() {
    let server = "tmux-server.0123456789abcdef0123456789abcdef";
    let mut response = json!({"version":1,"server":{"serverId":server,"generation":UUID},"result":{"status":"captured","token":UUID}});
    let parse =
        |v: &serde_json::Value| decode_result(&serde_json::to_vec(v).unwrap(), server, UUID);
    assert!(parse(&response).is_ok());
    response["result"]["extra"] = json!(true);
    assert!(parse(&response).is_err());
    response["result"] = json!({"status":"resolved","proof":proof(1),"historyIndex":8});
    assert!(parse(&response).is_ok());
    response["server"]["generation"] = json!("22345678-1234-4234-8234-123456789abc");
    assert!(parse(&response).is_err());
    assert!(decode_result(&vec![b' '; 16 * 1024 + 1], server, UUID).is_err());
}
#[test]
fn late_publication_cannot_complete_expired_restore() {
    let first = snapshot(10, 2);
    let mut v = Viewport::default();
    v.update(scope(), first);
    let mut r = Restoration::default();
    r.observe(proof(1), &mut v, 0);
    let action = r.restore(proof(1), &v, UUID.into(), 0).unwrap();
    assert!(r.complete(
        &action.ticket,
        Some(AnchorResult::Resolved {
            proof: proof(2),
            history_index: 8
        }),
        &mut v,
        1
    ));
    assert!(!r.complete(
        &action.ticket,
        Some(AnchorResult::Resolved {
            proof: proof(2),
            history_index: 3
        }),
        &mut v,
        2
    ));
    r.observe(proof(2), &mut v, 3000);
    assert_eq!(r.state(), HistoryState::Unavailable);
    assert_eq!(v.offset(), 0);
}
#[test]
fn restore_fails_closed_after_width_change_or_anchor_retirement() {
    let first = snapshot(10, 2);
    let mut v = Viewport::default();
    v.update(scope(), first);
    let mut r = Restoration::default();
    r.observe(proof(1), &mut v, 0);
    let action = r.restore(proof(1), &v, UUID.into(), 0).unwrap();
    v.update(scope(), snapshot(10, 3));
    assert!(r.complete(
        &action.ticket,
        Some(AnchorResult::Resolved {
            proof: proof(1),
            history_index: 8
        }),
        &mut v,
        1
    ));
    assert_eq!(r.state(), HistoryState::Lost);
    assert_eq!(v.offset(), 0);
}
#[test]
fn anchor_requests_match_capture_and_resolve_wire_contracts() {
    let mut v = Viewport::default();
    v.update(scope(), snapshot(2, 2));
    v.scroll(Scroll::Home);
    let mut r = Restoration::default();
    let live = "live-session.0123456789abcdef0123";
    let capture = r.capture(proof(1), &v).unwrap();
    let body: serde_json::Value =
        serde_json::from_slice(&capture.request_body(live).unwrap()).unwrap();
    assert_eq!(body["proof"]["revision"], 1);
    assert_eq!(body["operation"]["historyIndex"], 0);
    let restore = r.restore(proof(1), &v, UUID.into(), 0).unwrap();
    let body: serde_json::Value =
        serde_json::from_slice(&restore.request_body(live).unwrap()).unwrap();
    assert!(body["proof"].get("revision").is_none());
    assert!(body["proof"].get("stateHash").is_none());
    assert!(restore.request_body("../owner").is_err());
}

/// Capability 122: indexes name rows of the whole history, so a partial
/// history's unloaded rows come before its loaded ones, in a capture and in
/// a restore alike.
#[test]
fn a_partial_history_captures_and_restores_whole_history_indexes() {
    use crate::tmux_delivery::{DeferredHistory, History, PartialHistory};
    let mut partial = (*snapshot(10, 2)).clone();
    let loaded = partial.history.materialized().unwrap().to_vec();
    partial.history = History::Partial(PartialHistory {
        unloaded: DeferredHistory {
            rows: 300,
            digest: "0".repeat(16),
        },
        loaded: loaded.into(),
    });
    let partial = Arc::new(partial);
    let mut v = Viewport::default();
    v.update(scope(), partial.clone());
    let mut r = Restoration::default();
    r.observe(proof(1), &mut v, 0);
    v.scroll(Scroll::Wheel(3));
    // The fourth-newest of ten loaded rows: index 7 of them, 307 of all.
    assert_eq!(v.capture_index(), Some(307));
    let capture = r.capture(proof(1), &v).unwrap();
    assert!(matches!(
        capture.operation,
        AnchorOperation::Capture { history_index: 307 }
    ));
    v.scroll(Scroll::End);
    let action = r.restore(proof(1), &v, UUID.into(), 100).unwrap();
    assert!(r.complete(
        &action.ticket,
        Some(AnchorResult::Resolved {
            proof: proof(1),
            history_index: 307
        }),
        &mut v,
        200
    ));
    assert_eq!(v.offset(), 3);
    assert_eq!(r.state(), HistoryState::Historical);
}
