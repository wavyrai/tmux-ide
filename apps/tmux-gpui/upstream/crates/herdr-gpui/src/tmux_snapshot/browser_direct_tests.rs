#![allow(clippy::unwrap_used)]
use super::*;
use herdr_client::{
    tmux_delivery::{Snapshot, Update, decode_compact},
    tmux_native_session::{CommittedIdentity, CommittedPane},
    tmux_topology::{CopyRegion, Region, WindowPaint},
};
use serde_json::json;
fn snapshot() -> Arc<Snapshot> {
    let row = json!([
        0,
        [
            [1, "界", 2, 0, 0, 1],
            [1, "", 0, 0, 0, 0],
            [1, "a", 1, 0, 0, 0]
        ]
    ]);
    let value = json!({"v":1,"k":"terminal-semantic-compact","f":"s","r":0,"s":[3,2,[row,[1,[[3,"b",1,0,0,0]]]],[],[2,1,0,"block",0],[0,0,0,0,0,0,1,0,null,null,0],[],["authoritative-stream","observed-from-start"]]});
    let Update::Seed { snapshot, .. } =
        decode_compact(&serde_json::to_vec(&value).unwrap()).unwrap()
    else {
        panic!("seed")
    };
    Arc::new(snapshot)
}
fn window(snapshot: Arc<Snapshot>, revision: u64, incarnation: &str) -> PresentedWindow {
    let mut cursor = snapshot.cursor.clone();
    cursor.y += 1;
    let paint = WindowPaint {
        window: "window".into(),
        selected_pane: "pane".into(),
        cols: 3,
        rows: 3,
        copy_region: CopyRegion {
            pane: "pane".into(),
            left: 0,
            top: 1,
            width: 3,
            height: 2,
            wrapped: snapshot.grid.iter().map(|row| row.wrapped()).collect(),
        },
        modes: snapshot.modes.clone(),
        cursor,
        mode_keys: None,
        zoomed: false,
        regions: vec![Region {
            pane: "pane".into(),
            left: 0,
            top: 0,
            width: 3,
            height: 3,
            content_top: 1,
            content_rows: 2,
            source: Arc::new(CommittedPane {
                snapshot: Some(snapshot),
                identity: Arc::new(CommittedIdentity {
                    generation: "12345678-1234-4234-8234-123456789abc".into(),
                    incarnation: incarnation.into(),
                    delivery_nonce: format!("nonce-{revision}"),
                    canonical_revision: revision,
                    canonical_state_hash: format!("{revision:016x}"),
                }),
            }),
        }],
    };
    PresentedWindow {
        paint: Arc::new(paint),
        coherent: true,
    }
}
fn state() -> browser::State {
    browser::State {
        selected_session: Some("session".into()),
        request: 17,
        sessions: vec![browser::Choice {
            id: "session".into(),
            label: "Human session".into(),
            pane_count: Some(1),
            window_id: None,
            window_label: None,
        }],
        panes: vec![browser::Choice {
            id: "pane".into(),
            label: "Human pane".into(),
            pane_count: None,
            window_id: Some("window".into()),
            window_label: Some("Editor".into()),
        }],
        ..Default::default()
    }
}
#[test]
fn native_overlay_preserves_catalog_and_uses_content_for_copy_hit_rect_for_panes() {
    let mut adapter = NativePresentation::new("scope", "workspace");
    let mut s = state();
    adapter
        .apply(&mut s, &window(snapshot(), 1, "one"), true, 4, 0)
        .unwrap();
    assert_eq!(s.request, 17);
    assert_eq!(s.sessions[0].label, "Human session");
    assert_eq!(s.panes[0].label, "Human pane");
    assert_eq!(s.regions[0].top, 0);
    assert_eq!(s.regions[0].height, 3);
    let copy = s.copy_region.as_ref().unwrap();
    assert_eq!(copy.top, 1);
    assert_eq!(copy.height, 2);
    let DisplayFrame::Native(frame) = s.frame.as_ref().unwrap() else {
        panic!("native")
    };
    assert!(Arc::ptr_eq(
        &frame.rows[1],
        adapter.projection.cached_row("pane", 0).unwrap()
    ));
    assert_eq!(frame.cursor.as_ref().unwrap().y, 2);
    assert_eq!(
        copy.text_view(s.frame.as_ref().unwrap().view()).unwrap(),
        "界abbb"
    );
    assert_eq!(s.presence_revision, 4);
    assert!(s.input_ready);
}
#[test]
fn cursor_and_revision_updates_keep_input_and_selection_proof_and_rows() {
    let source = snapshot();
    let mut adapter = NativePresentation::new("scope", "workspace");
    let mut s = state();
    adapter
        .apply(&mut s, &window(source.clone(), 1, "one"), true, 4, 0)
        .unwrap();
    let first = s.frame.clone().unwrap();
    let token = s.input_targets[0].token.clone();
    let selection = s.selection_identity.clone();
    adapter
        .apply(&mut s, &window(source.clone(), 2, "one"), true, 4, 0)
        .unwrap();
    assert!(first.same(s.frame.as_ref().unwrap()));
    assert_eq!(selection, s.selection_identity);
    let mut changed = (*source).clone();
    changed.cursor.x = 0;
    adapter
        .apply(&mut s, &window(Arc::new(changed), 3, "one"), true, 4, 0)
        .unwrap();
    assert_eq!(token, s.input_targets[0].token);
    assert_eq!(selection, s.selection_identity);
    assert!(adapter.resolve("pane", Some(&token)).is_some());
    assert!(adapter.resolve("pane", None).is_some());
    assert!(adapter.resolve("other", None).is_none());
    let (DisplayFrame::Native(a), DisplayFrame::Native(b)) = (&first, s.frame.as_ref().unwrap())
    else {
        panic!("native")
    };
    assert!(Arc::ptr_eq(&a.rows[1], &b.rows[1]));
    assert!(Arc::ptr_eq(&a.rows[2], &b.rows[2]));
}
#[test]
fn changed_rows_retire_selection_proof_but_lifetime_tokens_survive() {
    let mut adapter = NativePresentation::new("scope", "workspace");
    let mut s = state();
    adapter
        .apply(&mut s, &window(snapshot(), 1, "one"), true, 4, 0)
        .unwrap();
    let token = s.input_targets[0].token.clone();
    let selection = s.selection_identity.clone();
    adapter
        .apply(&mut s, &window(snapshot(), 2, "one"), true, 4, 0)
        .unwrap();
    assert_ne!(selection, s.selection_identity);
    assert_eq!(token, s.input_targets[0].token);
    adapter
        .apply(&mut s, &window(snapshot(), 3, "two"), true, 4, 0)
        .unwrap();
    assert_ne!(token, s.input_targets[0].token);
    assert!(adapter.resolve("pane", Some(&token)).is_none());
}
#[test]
fn retained_skew_and_authority_loss_never_authorize_input() {
    let source = snapshot();
    let mut adapter = NativePresentation::new("scope", "workspace");
    let mut s = state();
    adapter
        .apply(&mut s, &window(source.clone(), 1, "one"), true, 4, 0)
        .unwrap();
    let mut retained = window(source.clone(), 1, "one");
    retained.coherent = false;
    adapter.apply(&mut s, &retained, true, 4, 0).unwrap();
    assert!(!s.input_ready);
    assert!(s.input_targets.is_empty());
    assert!(s.selection_identity.is_none());
    assert!(adapter.resolve("pane", None).is_none());
    adapter
        .apply(&mut s, &window(source, 2, "one"), false, 4, 0)
        .unwrap();
    assert!(!s.input_ready);
    assert!(adapter.resolve("pane", None).is_none());
}
#[test]
fn stale_node_grants_are_cleared_and_invalid_copy_rect_retires_targets() {
    let mut adapter = NativePresentation::new("scope", "workspace");
    let mut s = state();
    s.resize_token = Some("stale".into());
    s.resize_gesture_supported = true;
    s.pane_actions = Some(browser::PaneActions {
        token: "stale".into(),
        id: "pane".into(),
        zoomed: false,
    });
    adapter
        .apply(&mut s, &window(snapshot(), 1, "one"), true, 4, 0)
        .unwrap();
    assert!(s.resize_token.is_none());
    assert!(!s.resize_gesture_supported);
    assert!(s.pane_actions.is_none());
    let mut invalid = window(snapshot(), 2, "one");
    Arc::get_mut(&mut invalid.paint).unwrap().copy_region.top = 0;
    assert!(adapter.apply(&mut s, &invalid, true, 4, 0).is_err());
    assert!(adapter.resolve("pane", None).is_none());
}
fn with_history() -> Arc<Snapshot> {
    let mut source = (*snapshot()).clone();
    source.history = vec![snapshot().grid[1].clone(), snapshot().grid[0].clone()].into();
    Arc::new(source)
}
#[test]
fn local_history_scroll_only_changes_selected_rows_and_never_mutates_canonical() {
    let source = with_history();
    let canonical_rows = source.grid.clone();
    let history_rows = source.history.clone();
    let mut shown = window(source.clone(), 1, "one");
    let other = window(snapshot(), 1, "other-incarnation");
    let paint = Arc::get_mut(&mut shown.paint).unwrap();
    paint.rows = 6;
    paint.regions.push(Region {
        pane: "other".into(),
        left: 0,
        top: 3,
        width: 3,
        height: 3,
        content_top: 4,
        content_rows: 2,
        source: other.paint.regions[0].source.clone(),
    });
    let mut adapter = NativePresentation::new("scope", "workspace");
    let mut s = state();
    adapter.apply(&mut s, &shown, true, 4, 0).unwrap();
    let first = s.frame.clone().unwrap();
    adapter.scroll(Scroll::Home);
    assert!(adapter.resolve("pane", None).is_none());
    adapter.apply(&mut s, &shown, true, 4, 0).unwrap();
    assert_eq!(adapter.history_offset(), 2);
    assert_eq!(s.history_offset, 2);
    assert!(!s.input_ready);
    assert!(s.input_targets.is_empty());
    assert!(s.pointer_modes.is_none());
    let (DisplayFrame::Native(before), DisplayFrame::Native(after)) =
        (&first, s.frame.as_ref().unwrap())
    else {
        panic!("native")
    };
    assert!(after.cursor.is_none());
    assert_eq!(after.rows[1][0].symbol, "b");
    for row in [0, 3, 4, 5] {
        assert!(Arc::ptr_eq(&before.rows[row], &after.rows[row]));
    }
    for (before, after) in canonical_rows.iter().zip(&source.grid) {
        assert!(Arc::ptr_eq(before, after));
    }
    for (before, after) in history_rows
        .materialized()
        .unwrap()
        .iter()
        .zip(source.history.materialized().unwrap())
    {
        assert!(Arc::ptr_eq(before, after));
    }
    assert_eq!(s.copy_region.as_ref().unwrap().wrapped, vec![true, false]);
}
#[test]
fn output_while_anchored_keeps_displayed_rows_then_end_returns_live() {
    let source = with_history();
    let mut adapter = NativePresentation::new("scope", "workspace");
    let mut s = state();
    adapter
        .apply(&mut s, &window(source.clone(), 1, "one"), true, 4, 0)
        .unwrap();
    adapter.scroll(Scroll::Home);
    adapter
        .apply(&mut s, &window(source.clone(), 1, "one"), true, 4, 0)
        .unwrap();
    let before = s.frame.clone().unwrap();
    let selection = s.selection_identity.clone();
    let mut newer = (*source).clone();
    newer
        .history
        .materialized_mut()
        .unwrap()
        .push(source.grid[0].clone());
    adapter
        .apply(&mut s, &window(Arc::new(newer), 2, "one"), true, 4, 0)
        .unwrap();
    assert_eq!(adapter.history_offset(), 3);
    assert!(before.same(s.frame.as_ref().unwrap()));
    assert_eq!(selection, s.selection_identity);
    adapter.scroll(Scroll::End);
    adapter
        .apply(&mut s, &window(source.clone(), 3, "one"), true, 4, 0)
        .unwrap();
    assert_eq!(adapter.history_offset(), 0);
    assert!(s.input_ready);
    assert_eq!(s.history_offset, 0);
    assert!(s.frame.as_ref().unwrap().view().cursor().is_some());
    assert_eq!(
        s.frame.as_ref().unwrap().view().cell(0, 1).unwrap().symbol,
        "界"
    );
}
#[test]
fn alternate_screen_and_new_incarnation_reset_history() {
    let source = with_history();
    let mut adapter = NativePresentation::new("scope", "workspace");
    let mut s = state();
    adapter
        .apply(&mut s, &window(source.clone(), 1, "one"), true, 4, 0)
        .unwrap();
    adapter.scroll(Scroll::Home);
    adapter
        .apply(&mut s, &window(source.clone(), 2, "two"), true, 4, 0)
        .unwrap();
    assert_eq!(adapter.history_offset(), 0);
    adapter.scroll(Scroll::Home);
    let mut alternate = (*source).clone();
    alternate.modes.alternate_screen = true;
    adapter
        .apply(&mut s, &window(Arc::new(alternate), 3, "two"), true, 4, 0)
        .unwrap();
    assert_eq!(adapter.history_offset(), 0);
}

const HISTORY_TOKEN: &str = "12345678-1234-4234-8234-123456789abc";
#[test]
fn scroll_captures_metadata_and_owner_resolve_restores_exact_row() {
    let source = with_history();
    let mut adapter = NativePresentation::new("scope", "workspace");
    let mut s = state();
    adapter
        .apply(&mut s, &window(source.clone(), 1, "one"), true, 4, 0)
        .unwrap();
    adapter.scroll(Scroll::Home);
    let capture = adapter.take_history_action().unwrap();
    assert!(matches!(
        capture.operation,
        herdr_client::tmux_history::AnchorOperation::Capture { history_index: 0 }
    ));
    assert!(adapter.complete_history(
        &capture.ticket,
        Some(AnchorResult::Captured {
            token: HISTORY_TOKEN.into()
        }),
        1
    ));
    assert_eq!(adapter.history_token(), Some(HISTORY_TOKEN));
    adapter.scroll(Scroll::End);
    assert!(adapter.history_token().is_none());
    assert!(adapter.take_history_action().is_none());
    adapter.restore_history(HISTORY_TOKEN.into(), 10);
    let restore = adapter.take_history_action().unwrap();
    adapter
        .apply(&mut s, &window(source.clone(), 1, "one"), true, 4, 11)
        .unwrap();
    assert!(!s.input_ready);
    assert!(s.selection_identity.is_none());
    assert!(adapter.complete_history(
        &restore.ticket,
        Some(AnchorResult::Resolved {
            proof: restore.proof.clone(),
            history_index: 0
        }),
        12
    ));
    adapter
        .apply(&mut s, &window(source.clone(), 1, "one"), true, 4, 13)
        .unwrap();
    assert_eq!(adapter.history_offset(), 2);
    assert!(Arc::ptr_eq(
        &adapter.viewport.view().unwrap().grid[0],
        &source.history.materialized().unwrap()[0]
    ));
    assert_eq!(adapter.history_token(), Some(HISTORY_TOKEN));
}
#[test]
fn first_frame_restore_waits_for_proof_and_late_response_is_fenced() {
    let source = with_history();
    let mut adapter = NativePresentation::new("scope", "workspace");
    let mut s = state();
    adapter.restore_history(HISTORY_TOKEN.into(), 0);
    assert_eq!(adapter.history_token(), Some(HISTORY_TOKEN));
    assert_eq!(adapter.history_pane(), None);
    assert!(adapter.take_history_action().is_none());
    adapter
        .apply(&mut s, &window(source.clone(), 1, "one"), true, 4, 10)
        .unwrap();
    let pending = adapter.take_history_action().unwrap();
    assert!(!s.input_ready);
    assert!(adapter.tick_history(3000));
    assert!(!adapter.complete_history(
        &pending.ticket,
        Some(AnchorResult::Resolved {
            proof: pending.proof.clone(),
            history_index: 0
        }),
        3001
    ));
    adapter
        .apply(&mut s, &window(source.clone(), 1, "one"), true, 4, 3001)
        .unwrap();
    assert!(s.input_ready);
    assert_eq!(adapter.history_offset(), 0);
    adapter.scroll(Scroll::Home);
    let old = adapter.take_history_action().unwrap();
    adapter
        .apply(&mut s, &window(source.clone(), 2, "two"), true, 4, 3002)
        .unwrap();
    assert!(!adapter.complete_history(
        &old.ticket,
        Some(AnchorResult::Captured {
            token: HISTORY_TOKEN.into()
        }),
        3003
    ));
    assert!(adapter.history_token().is_none());
}
#[test]
fn superseded_scroll_capture_cannot_replace_current_anchor_token() {
    let source = with_history();
    let mut adapter = NativePresentation::new("scope", "workspace");
    let mut s = state();
    adapter
        .apply(&mut s, &window(source, 1, "one"), true, 4, 0)
        .unwrap();
    adapter.scroll(Scroll::Home);
    let old = adapter.take_history_action().unwrap();
    adapter.scroll(Scroll::Wheel(-1));
    let latest = adapter.take_history_action().unwrap();
    assert!(!adapter.complete_history(
        &old.ticket,
        Some(AnchorResult::Captured {
            token: HISTORY_TOKEN.into()
        }),
        1
    ));
    assert!(adapter.complete_history(
        &latest.ticket,
        Some(AnchorResult::Captured {
            token: HISTORY_TOKEN.into()
        }),
        1
    ));
    assert_eq!(adapter.history_token(), Some(HISTORY_TOKEN));
}

#[test]
fn idle_same_paint_skips_projection_but_authority_presence_and_request_refresh() {
    let mut adapter = NativePresentation::new("scope", "workspace");
    let mut s = state();
    let shown = window(snapshot(), 1, "one");
    assert!(adapter.apply(&mut s, &shown, true, 4, 0).unwrap());
    let frame = s.frame.clone().unwrap();
    let token = s.input_targets[0].token.clone();
    let selection = s.selection_identity.clone();
    for now in 1..101 {
        assert!(!adapter.apply(&mut s, &shown, true, 4, now).unwrap());
    }
    assert!(frame.same(s.frame.as_ref().unwrap()));
    assert_eq!(s.input_targets[0].token, token);
    assert_eq!(s.selection_identity, selection);
    assert!(adapter.apply(&mut s, &shown, false, 4, 101).unwrap());
    assert!(!s.input_ready);
    assert!(adapter.resolve("pane", Some(&token)).is_none());
    assert!(adapter.apply(&mut s, &shown, true, 5, 102).unwrap());
    assert!(s.input_ready);
    assert_eq!(s.presence_revision, 5);
    s.request += 1;
    assert!(adapter.apply(&mut s, &shown, true, 5, 103).unwrap());
}
#[test]
fn replaced_catalog_reapplies_overlay_without_changing_native_paint() {
    let mut adapter = NativePresentation::new("scope", "workspace");
    let mut s = state();
    let shown = window(snapshot(), 1, "one");
    adapter.apply(&mut s, &shown, true, 4, 0).unwrap();
    s = state();
    adapter.invalidate_overlay();
    assert!(adapter.resolve("pane", None).is_none());
    assert!(adapter.apply(&mut s, &shown, true, 4, 1).unwrap());
    assert!(s.frame.is_some() && s.input_ready);
    assert_eq!(s.panes[0].label, "Human pane");
}
#[test]
fn same_paint_history_restore_completion_failure_and_timeout_invalidate_cache() {
    let mut adapter = NativePresentation::new("scope", "workspace");
    let mut s = state();
    let shown = window(with_history(), 1, "one");
    adapter.apply(&mut s, &shown, true, 4, 0).unwrap();
    adapter.scroll(Scroll::Home);
    assert!(adapter.apply(&mut s, &shown, true, 4, 1).unwrap());
    assert!(s.history_offset > 0);
    adapter.scroll(Scroll::End);
    adapter.apply(&mut s, &shown, true, 4, 2).unwrap();
    adapter.restore_history(HISTORY_TOKEN.into(), 10);
    let restore = adapter.take_history_action().unwrap();
    assert!(adapter.apply(&mut s, &shown, true, 4, 11).unwrap());
    assert!(!s.input_ready);
    assert!(adapter.complete_history(
        &restore.ticket,
        Some(AnchorResult::Resolved {
            proof: restore.proof.clone(),
            history_index: 0,
        }),
        12
    ));
    assert!(adapter.apply(&mut s, &shown, true, 4, 13).unwrap());
    assert_eq!(s.history_offset, 2);
    adapter.scroll(Scroll::End);
    adapter.apply(&mut s, &shown, true, 4, 14).unwrap();
    adapter.restore_history(HISTORY_TOKEN.into(), 20);
    let failed = adapter.take_history_action().unwrap();
    adapter.apply(&mut s, &shown, true, 4, 21).unwrap();
    adapter.fail_history(&failed.ticket);
    assert!(adapter.apply(&mut s, &shown, true, 4, 22).unwrap());
    adapter.restore_history(HISTORY_TOKEN.into(), 30);
    adapter.apply(&mut s, &shown, true, 4, 31).unwrap();
    assert!(adapter.apply(&mut s, &shown, true, 4, 3030).unwrap());
    assert!(s.input_ready);
}

#[path = "browser_direct_focus_tests.rs"]
mod focus;

#[path = "browser_direct_projection_tests.rs"]
mod alternate_projection;

#[path = "browser_direct_tests/focus.rs"]
mod focus_tokens;
