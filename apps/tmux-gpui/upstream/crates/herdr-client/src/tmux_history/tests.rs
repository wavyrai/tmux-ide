#![allow(clippy::unwrap_used)]
use super::*;
use crate::tmux_delivery::{Snapshot, Update, decode_compact};
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
fn snapshot(history: usize, cols: usize) -> Arc<Snapshot> {
    let row = |s: String| json!([0, [[cols, s, 1, 0, 0, 0]]]);
    let bytes=serde_json::to_vec(&json!({"v":1,"k":"terminal-semantic-compact","f":"s","r":0,
        "s":[cols,2,[row("A".into()),row("B".into())],(0..history).map(|i|row(i.to_string())).collect::<Vec<_>>(),[0,0,0,"block",0],[0,0,0,0,0,0,1,0,null,null,0],[],["authoritative-stream","observed-from-start"]]})).unwrap();
    let Update::Seed { snapshot, .. } = decode_compact(&bytes).unwrap() else {
        panic!("seed")
    };
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
    let first = snapshot(1100, 1);
    let mut v = Viewport::default();
    v.update(scope(), first.clone());
    v.scroll(Scroll::Home);
    assert_eq!(v.offset(), 1000);
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
#[test]
fn byte_cap_and_alternate_screen_clear_history() {
    let first = snapshot(1000, 64);
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
fn row_size_matches_json_escaping_and_color_shapes() {
    let first = snapshot(1, 2);
    let r = &first.history.materialized().unwrap()[0];
    let c = &r.cells()[0];
    let cell = json!({"grapheme":&*c.grapheme,"width":c.width,"foreground":c.foreground,"background":c.background,"attributes":c.attributes});
    let expected = serde_json::to_vec(&json!({"wrapped":false,"cells":[cell.clone(),cell]}))
        .unwrap()
        .len();
    assert_eq!(size::Sizes::default().row(r), expected);
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
