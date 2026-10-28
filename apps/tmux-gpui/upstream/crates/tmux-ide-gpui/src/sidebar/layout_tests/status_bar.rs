use super::*;

#[gpui::test]
fn healthy_connection_status_is_quiet_but_diagnostics_remain(cx: &mut gpui::TestAppContext) {
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = fixture_window(window, cx);
        view.live.status = crate::state::ConnectionStatus::Connected;
        view
    });
    cx.update(|window, cx| full_draw(window, cx).clear(cx));
    assert!(cx.debug_bounds("connection-message").is_none());
    assert!(cx.debug_bounds("status-theme").is_some());
    for status in [
        crate::state::ConnectionStatus::Connected,
        crate::state::ConnectionStatus::Disconnected,
    ] {
        cx.update(|window, cx| {
            view.update(cx, |view, cx| {
                view.live.status = status;
                view.local_error = Some("Local operation failed".into());
                view.live.error = Some("Connection interrupted".into());
                cx.notify();
            });
            full_draw(window, cx).clear(cx);
        });
        assert!(cx.debug_bounds("connection-message").unwrap().size.width > px(0.));
    }
}
