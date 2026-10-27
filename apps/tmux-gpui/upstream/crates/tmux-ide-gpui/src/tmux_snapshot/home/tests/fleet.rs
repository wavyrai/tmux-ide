use super::*;

#[gpui::test]
fn fleet_click_uses_current_token_and_retires_terminal_input(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    receiver.try_iter().for_each(drop);
    let fixture: serde_json::Value = serde_json::from_slice(include_bytes!(
        "../../../../../../../fixtures/browser-fleet.json"
    ))
    .unwrap();
    cx.update(|window, cx| view.update(cx, |view, cx| {
        view.browser_state.fleet = Some(serde_json::from_value(fixture["fleet"].clone()).unwrap());
        let token = view.browser_state.fleet.as_ref().unwrap().groups[0].sessions[0].selection.clone().unwrap();
        view.open_fleet_session(6, &token, window, cx);
        view.open_fleet_session(7, "forged", window, cx);
        assert!(receiver.try_recv().is_err());
        view.open_fleet_session(7, &token, window, cx);
        assert!(matches!(receiver.try_recv().unwrap(), browser::Command::FleetSession { request: 8, selection } if selection == token));
        assert!(!view.browser_state.input_ready);
        assert!(view.frame.is_none());
        assert_eq!(view.pending_session_open, Some(crate::tmux_snapshot::session_open::Intent::exact(8, "$1".into())));
        assert!(receiver.try_recv().is_err());
    }));
}
