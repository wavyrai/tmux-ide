#![allow(clippy::unwrap_used)]
use super::super::{browser, browser_direct::NativePresentation};
use super::*;
use herdr_client::{
    tmux_delivery::{Snapshot, Update, decode_compact},
    tmux_native_session::{CommittedIdentity, CommittedPane},
    tmux_topology::{CopyRegion, PresentedWindow, Region, WindowPaint},
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
fn state() -> State {
    State {
        selected_session: Some("session".into()),
        request: 17,
        sessions: vec![browser::Choice {
            id: "session".into(),
            label: "Human session".into(),
            pane_count: Some(1),
            window_id: None,
            browser_icon: None,
            window_label: None,
        }],
        panes: vec![browser::Choice {
            id: "pane".into(),
            label: "Human pane".into(),
            pane_count: None,
            window_id: Some("window".into()),
            browser_icon: None,
            window_label: Some("Editor".into()),
        }],
        ..Default::default()
    }
}

fn fixture() -> (Route, PresentedWindow, State) {
    let scope = Route {
        key: "a".repeat(64),
        proof: "b".repeat(64),
    };
    let window = window(snapshot(), 1, "one");
    let mut state = state();
    NativePresentation::new("connection", "workspace")
        .apply(&mut state, &window, true, 1, 0)
        .unwrap();
    (scope, window, state)
}
fn unavailable(state: &mut State) {
    state.request += 1;
    state.frame = None;
    state.input_ready = false;
}
#[test]
fn preview_reuses_native_rows_and_removes_every_terminal_capability() {
    let (scope, _window, mut state) = fixture();
    let original = state.frame.clone().unwrap();
    let mut cache = Cache::default();
    assert!(cache.remember(&scope, &state));
    unavailable(&mut state);
    assert!(cache.show(&scope, &mut state, true, 100));
    let (DisplayFrame::Native(before), DisplayFrame::Native(after)) =
        (&original, state.frame.as_ref().unwrap())
    else {
        panic!("native")
    };
    assert!(Arc::ptr_eq(&before.rows[1], &after.rows[1]));
    assert!(after.cursor.is_none());
    assert!(state.retained_preview);
    assert!(state.selected_pane.is_none());
    assert!(!state.input_ready);
    assert!(state.input_targets.is_empty());
    assert!(state.selection_identity.is_none());
    assert!(state.copy_region.is_none());
    assert!(state.pointer_modes.is_none());
    assert!(state.regions.is_empty() && state.graphics.is_empty());
    assert!(state.pane_actions.is_none() && state.resize_token.is_none());
    assert!(!state.resize_gesture_supported);
    assert!(state.split_layout.is_none() && state.diagnostics.is_none());
}
#[test]
fn preview_expires_at_five_seconds_and_cannot_restart_on_same_request() {
    let (scope, _window, mut state) = fixture();
    let mut cache = Cache::default();
    assert!(cache.remember(&scope, &state));
    unavailable(&mut state);
    assert!(cache.show(&scope, &mut state, true, 100));
    assert!(cache.show(&scope, &mut state, true, 5099));
    assert!(!cache.show(&scope, &mut state, true, 5100));
    assert!(state.frame.is_none() && !state.retained_preview);
    assert!(!cache.show(&scope, &mut state, true, 6000));
    state.request += 1;
    assert!(cache.show(&scope, &mut state, true, 7000));
}
#[test]
fn changed_broker_route_epoch_or_theme_proof_never_reuses_stale_frame() {
    let (mut scope, _window, mut state) = fixture();
    let mut cache = Cache::default();
    assert!(cache.remember(&scope, &state));
    unavailable(&mut state);
    scope.proof = "c".repeat(64);
    assert!(!cache.show(&scope, &mut state, true, 1));
    assert!(state.frame.is_none());
    assert!(cache.entries.is_empty());
}
#[test]
fn live_frame_wins_and_background_or_route_invalidation_clears_preview() {
    let (scope, _window, mut state) = fixture();
    let mut cache = Cache::default();
    assert!(cache.remember(&scope, &state));
    let live = state.frame.clone().unwrap();
    assert!(!cache.show(&scope, &mut state, true, 1));
    assert!(state.frame.as_ref().unwrap().same(&live));
    unavailable(&mut state);
    assert!(cache.show(&scope, &mut state, true, 2));
    assert!(!cache.show(&scope, &mut state, false, 3));
    assert!(state.frame.is_none());
    assert!(!cache.show(&scope, &mut state, true, 4));
    state.request += 1;
    assert!(cache.show(&scope, &mut state, true, 5));
    cache.clear(&mut state);
    assert!(cache.entries.is_empty() && state.frame.is_none());
}
#[test]
fn cache_entry_bound_and_readonly_history_do_not_accumulate_previews() {
    let (scope, _window, mut state) = fixture();
    let mut cache = Cache::default();
    for i in 0..10 {
        let mut scope = scope.clone();
        scope.key = format!("{i:064x}");
        assert!(cache.remember(&scope, &state));
    }
    assert_eq!(cache.entries.len(), MAX_ENTRIES);
    state.history_offset = 1;
    assert!(!cache.remember(&scope, &state));
    state.history_offset = 0;
    state.retained_preview = true;
    assert!(!cache.remember(&scope, &state));
}

#[test]
fn idle_live_publication_retains_cached_frame_allocation() {
    let (scope, _, state) = fixture();
    let mut cache = Cache::default();
    assert!(cache.remember(&scope, &state));
    let frame = cache.entries[0].frame.clone();
    assert!(cache.remember(&scope, &state));
    assert!(Arc::ptr_eq(&frame, &cache.entries[0].frame));
    assert_eq!(cache.entries.len(), 1);
}
