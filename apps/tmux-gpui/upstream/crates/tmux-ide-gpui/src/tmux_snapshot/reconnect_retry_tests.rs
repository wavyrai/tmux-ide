#![allow(clippy::unwrap_used)]
use super::*;
use core::prelude::v1::test;
use gpui::TestAppContext;
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

/// r1: no Retry button while the app retries by itself; a retry asks only for
/// the request it was offered for (the footer slot's offline button).
#[gpui::test]
fn no_retry_button_and_a_retry_asks_for_this_request_only(cx: &mut TestAppContext) {
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
    assert!(cx.debug_bounds("tmux-reconnect-retry").is_none());
    while receiver.try_recv().is_ok() {}
    view.read_with(cx, |view, _| {
        assert!(!view.retry_reconnect(6));
        assert!(view.retry_reconnect(7));
    });
    let sent: Vec<_> = receiver.try_iter().collect();
    assert_eq!(sent.len(), 1);
    assert_eq!(
        serde_json::to_value(&sent[0]).unwrap(),
        serde_json::json!({"type":"retry-reconnect","request":7})
    );
    cx.update(|_, cx| view.update(cx, |view, _| view.browser_state = view_state(None)));
    view.read_with(cx, |view, _| assert!(!view.retry_reconnect(7)));
    assert!(receiver.try_recv().is_err());
}

/// r1/r2: a reconnect puts nothing beside the tabs, before or after a key is
/// refused; the refusal is the pane's "Not sent" toast.
#[gpui::test]
fn a_key_refused_while_reconnecting_leaves_the_tab_strip_alone(cx: &mut TestAppContext) {
    let (sender, _receiver) = mpsc::sync_channel(32);
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
    view.read_with(cx, |view, _| assert_eq!(view.status_line(), ""));
    cx.update(|_, cx| {
        view.update(cx, |view, cx| {
            assert!(
                !view.offer_terminal_input(cx),
                "a held frame accepted a key"
            );
        })
    });
    view.read_with(cx, |view, _| assert_eq!(view.status_line(), ""));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    assert!(cx.debug_bounds("tmux-not-sent").is_some());
}

/// Review N4: a window switch shows a "Restoring terminal…" preview with no
/// reconnect attempt. A key there is refused, but the stream isn't
/// reconnecting, so the status doesn't say so.
#[gpui::test]
fn a_key_refused_while_restoring_a_window_keeps_the_restoring_status(cx: &mut TestAppContext) {
    let (sender, _receiver) = mpsc::sync_channel(32);
    let restoring = browser::State {
        retained_preview: true,
        reconnect_attempt: None,
        status: "Restoring terminal… window 2".into(),
        ..view_state(None)
    };
    let (view, cx) = cx.add_window_view(|window, cx| {
        crate::tmux_snapshot::fit_test_support::fixture_view(window, cx, sender, 7, restoring)
    });
    cx.update(|window, cx| window.draw(cx).clear(cx));
    cx.update(|_, cx| {
        view.update(cx, |view, cx| {
            assert!(!view.offer_terminal_input(cx), "a preview accepted a key");
        })
    });
    view.read_with(cx, |view, _| {
        assert_eq!(view.status_line(), "Restoring terminal… window 2");
    });
    cx.update(|window, cx| window.draw(cx).clear(cx));
    assert!(cx.debug_bounds("tmux-not-sent").is_none());
}
