use super::*;
use herdr_client::protocol::CellData;
fn live() -> State {
    State {
        request: 4,
        surface: Surface::Workspace,
        input_ready: true,
        selected_session: Some("session".into()),
        selected_pane: Some("old".into()),
        resize_token: Some("not-retainable".into()),
        frame: Some(DisplayFrame::Native(Arc::new(NativeFrame {
            width: 1,
            height: 1,
            cursor: None,
            rows: vec![Arc::from([CellData {
                symbol: "x".into(),
                fg: 0,
                bg: 0,
                modifier: 0,
                skip: false,
                hyperlink: None,
            }])],
        }))),
        ..State::default()
    }
}
fn opening(request: u64) -> State {
    State {
        request,
        surface: Surface::Workspace,
        selected_session: Some("session".into()),
        status: "Opening terminal".into(),
        ..State::default()
    }
}
#[test]
fn handoff_retains_pixels_without_authority_then_replaces_atomically() {
    let mut t = Transition::default();
    let old = live();
    t.begin(&old, 5, 0);
    let pending = opening(5);
    let shown = t.publication(&pending, true, 10);
    assert!(shown.frame.is_some());
    assert!(shown.retained_preview);
    assert!(!shown.input_ready);
    assert!(shown.resize_token.is_none());
    assert!(shown.input_targets.is_empty());
    assert!(shown.pane_actions.is_none());
    assert_eq!(shown.selected_pane.as_deref(), Some("old"));
    assert!(pending.frame.is_none());
    let mut fresh = live();
    fresh.request = 5;
    fresh.selected_pane = Some("new".into());
    let shown = t.publication(&fresh, true, 20);
    assert!(!shown.retained_preview);
    assert_eq!(shown.selected_pane.as_deref(), Some("new"));
    assert!(t.0.is_none());
}
#[test]
fn preview_expires_and_never_crosses_session_presence_or_request() {
    for case in 0..5 {
        let mut t = Transition::default();
        t.begin(&live(), 5, 0);
        let mut pending = opening(5);
        match case {
            0 => pending.request = 6,
            1 => pending.presence_revision = 1,
            2 => pending.selected_session = Some("elsewhere".into()),
            _ => {}
        }
        let shown = t.publication(&pending, case != 3, if case == 4 { 2000 } else { 10 });
        assert!(shown.frame.is_none());
        assert!(t.0.is_none());
    }
}
#[test]
fn failures_are_not_hidden_by_retained_pixels() {
    let mut t = Transition::default();
    t.begin(&live(), 5, 0);
    let mut failed = opening(5);
    failed.status = "Connection unavailable".into();
    let shown = t.publication(&failed, true, 20);
    assert!(shown.frame.is_none());
    assert_eq!(shown.status, failed.status);
}
/// The real sequence after a split: the worker records the outcome, revokes
/// the stream and publishes. That publication is this preview, and it must
/// carry the outcome to the view (review of #361, round 2).
#[test]
fn the_preview_carries_the_split_outcome() {
    let mut t = Transition::default();
    t.begin(&live(), 5, 0);
    let mut pending = opening(5);
    pending.pane_split = Some(crate::tmux_snapshot::browser::PaneSplit {
        nonce: uuid::Uuid::new_v4(),
        created: Some("pane.new".into()),
    });
    let shown = t.publication(&pending, true, 10);
    assert!(shown.retained_preview, "the preview is what the view sees");
    assert!(shown.pane_split == pending.pane_split);
}
/// The second loss path (review of #361, round 3): after the preview that
/// carries the outcome, Local's open() publishes its own state and the worker
/// adopts it. For the same request the outcome survives, so the next
/// publication carries it again; for another request it is gone.
#[test]
fn the_split_outcome_survives_the_catalog_state_for_the_same_request() {
    let split = Some(crate::tmux_snapshot::browser::PaneSplit {
        nonce: uuid::Uuid::new_v4(),
        created: Some("pane.new".into()),
    });
    // The worker: the split completed, the stream was revoked, the preview
    // published the outcome.
    let mut t = Transition::default();
    let mut state = live();
    t.begin(&state, 4, 0);
    state.frame = None;
    state.status = "Opening terminal".into();
    state.pane_split = split.clone();
    assert!(t.publication(&state, true, 10).pane_split == split);
    // Local's open() for the same request: "Opening terminal", no outcome.
    adopt(&mut state, opening(4));
    let shown = t.publication(&state, true, 20);
    assert!(shown.retained_preview);
    assert!(
        shown.pane_split == split,
        "the latest publication still carries it"
    );
    // A later, unrelated request never inherits it.
    adopt(&mut state, opening(5));
    assert!(state.pane_split.is_none());
}
