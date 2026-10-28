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
