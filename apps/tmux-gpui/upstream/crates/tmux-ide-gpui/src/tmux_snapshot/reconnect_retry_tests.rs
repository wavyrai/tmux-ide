#![allow(clippy::unwrap_used)]
use super::*;
use core::prelude::v1::test;
use std::sync::mpsc;

fn view_state(attempt: Option<u32>) -> browser::State {
    browser::State {
        surface: browser::Surface::Workspace,
        request: 7,
        retained_preview: attempt.is_some(),
        reconnect_attempt: attempt,
        status: "Reconnecting… attempt 2".into(),
        ..Default::default()
    }
}

#[gpui::test]
fn retry_is_drawn_only_while_reconnecting_and_asks_for_this_request(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(32);
    let (view, cx) = cx.add_window_view(|window, cx| {
        crate::tmux_snapshot::fit_test_support::fixture_view(
            window,
            cx,
            sender,
            7,
            view_state(Some(2)),
        )
    });
    cx.update(|window, cx| window.draw(cx).clear(cx));
    assert!(cx.debug_bounds("tmux-reconnect-retry").is_some());
    while receiver.try_recv().is_ok() {}
    view.read_with(cx, |view, _| {
        // A button drawn for an older request never retries a newer one.
        assert!(!view.retry_reconnect(6));
        assert!(view.retry_reconnect(7));
    });
    let sent: Vec<_> = receiver.try_iter().collect();
    assert_eq!(sent.len(), 1);
    assert_eq!(
        serde_json::to_value(&sent[0]).unwrap(),
        serde_json::json!({"type":"retry-reconnect","request":7})
    );
    cx.update(|window, cx| {
        view.update(cx, |view, _| view.browser_state = view_state(None));
        window.draw(cx).clear(cx);
    });
    assert!(cx.debug_bounds("tmux-reconnect-retry").is_none());
    view.read_with(cx, |view, _| assert!(!view.retry_reconnect(7)));
    assert!(receiver.try_recv().is_err());
}
