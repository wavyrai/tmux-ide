//! Remote copy in the window: a copy right after typing in the focused pane
//! lands on the pasteboard; any other copy is a button on its pane's header.
#![allow(clippy::unwrap_used)]
use super::bezel::header_view;
use super::*;
use crate::tmux_snapshot::browser;
use herdr_client::tmux_daemon::BridgeEvent;
use std::sync::mpsc;

fn copy(pane: &str, text: &str) -> BridgeEvent {
    BridgeEvent::Clipboard {
        session: "session-a".into(),
        pane_id: pane.into(),
        incarnation: "g:0".into(),
        text: text.into(),
    }
}

fn draw(cx: &mut VisualTestContext) {
    cx.update(|window, cx| window.draw(cx).clear(cx));
}

fn clipboard(cx: &mut VisualTestContext) -> Option<String> {
    cx.update(|_, cx| cx.read_from_clipboard().and_then(|item| item.text()))
}

/// pane-a focused in the key window, the pasteboard holding "before".
fn setup(
    cx: &mut TestAppContext,
) -> (
    Entity<SnapshotView>,
    &mut VisualTestContext,
    mpsc::Receiver<browser::Command>,
) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| header_view(window, cx, sender));
    cx.simulate_resize(size(px(900.), px(700.)));
    view.update(cx, |v, _| {
        v.browser_state.selected_pane = Some("pane-a".into());
        v.presence.set_active(true);
    });
    cx.update(|_, cx| cx.write_to_clipboard(ClipboardItem::new_string("before".into())));
    draw(cx);
    receiver.try_iter().for_each(drop);
    (view, cx, receiver)
}

fn type_into_focused_pane(view: &Entity<SnapshotView>, cx: &mut VisualTestContext) {
    cx.update(|window, cx| {
        view.update(cx, |v, cx| v.replace_text_in_range(None, "x", window, cx));
    });
}

fn deliver(view: &Entity<SnapshotView>, cx: &mut VisualTestContext, event: BridgeEvent) {
    cx.update(|_, cx| {
        view.update(cx, |v, cx| {
            let now = cx.background_executor().now();
            v.apply_remote_copies(vec![event], now, cx);
        });
    });
    draw(cx);
}

#[gpui::test]
fn a_copy_right_after_typing_in_the_focused_pane_lands_and_says_so(cx: &mut TestAppContext) {
    let (view, cx, _receiver) = setup(cx);
    type_into_focused_pane(&view, cx);
    deliver(&view, cx, copy("pane-a", "hi"));
    assert_eq!(clipboard(cx).as_deref(), Some("hi"));
    assert!(cx.debug_bounds("remote-copy-note:pane-a").is_some());
    assert!(cx.debug_bounds("remote-copy-accept:pane-a").is_none());
}

#[gpui::test]
fn a_copy_without_typing_is_a_button_that_copies_once(cx: &mut TestAppContext) {
    let (view, cx, _receiver) = setup(cx);
    deliver(&view, cx, copy("pane-a", "unasked"));
    assert_eq!(clipboard(cx).as_deref(), Some("before"));
    let accept = cx.debug_bounds("remote-copy-accept:pane-a").unwrap();
    cx.simulate_click(accept.center(), Modifiers::default());
    draw(cx);
    assert_eq!(clipboard(cx).as_deref(), Some("unasked"));
    assert!(cx.debug_bounds("remote-copy-accept:pane-a").is_none());
}

#[gpui::test]
fn a_copy_from_another_pane_waits_on_that_panes_header(cx: &mut TestAppContext) {
    let (view, cx, _receiver) = setup(cx);
    type_into_focused_pane(&view, cx);
    deliver(&view, cx, copy("pane-b", "background"));
    assert_eq!(clipboard(cx).as_deref(), Some("before"));
    assert!(cx.debug_bounds("remote-copy-accept:pane-b").is_some());
    assert!(cx.debug_bounds("remote-copy-accept:pane-a").is_none());
    // Dismissing it writes nothing.
    let dismiss = cx.debug_bounds("remote-copy-dismiss:pane-b").unwrap();
    cx.simulate_click(dismiss.center(), Modifiers::default());
    draw(cx);
    assert!(cx.debug_bounds("remote-copy-accept:pane-b").is_none());
    assert_eq!(clipboard(cx).as_deref(), Some("before"));
}

#[gpui::test]
fn typing_does_not_count_once_the_window_is_not_key(cx: &mut TestAppContext) {
    let (view, cx, _receiver) = setup(cx);
    type_into_focused_pane(&view, cx);
    view.update(cx, |v, _| v.presence.set_active(false));
    deliver(&view, cx, copy("pane-a", "elsewhere"));
    assert_eq!(clipboard(cx).as_deref(), Some("before"));
    assert!(cx.debug_bounds("remote-copy-accept:pane-a").is_some());
}

#[gpui::test]
fn typing_counts_for_two_seconds(cx: &mut TestAppContext) {
    let (view, cx, _receiver) = setup(cx);
    type_into_focused_pane(&view, cx);
    cx.executor()
        .advance_clock(std::time::Duration::from_millis(2100));
    deliver(&view, cx, copy("pane-a", "late"));
    assert_eq!(clipboard(cx).as_deref(), Some("before"));
    assert!(cx.debug_bounds("remote-copy-accept:pane-a").is_some());
}
