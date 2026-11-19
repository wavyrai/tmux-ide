//! #718: a plain terminal browser has no header controls, and its header
//! says so; a browser with controls and any other pane say nothing.
#![allow(clippy::unwrap_used)]
use super::bezel::header_view;
use super::*;
use std::sync::mpsc;

fn draw(cx: &mut VisualTestContext) {
    cx.update(|window, cx| window.draw(cx).clear(cx));
}

#[gpui::test]
fn a_plain_browsers_header_says_it_has_no_controls(cx: &mut TestAppContext) {
    let (sender, _receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = header_view(window, cx, sender);
        // pane-b is a plain browser; pane-c a browser with its controls,
        // which win if the layout still calls it plain.
        view.browser_state.plain_browsers = ["pane-b".to_owned(), "pane-c".to_owned()].into();
        view
    });
    cx.simulate_resize(size(px(900.), px(700.)));
    draw(cx);
    assert!(
        cx.debug_bounds("pane-title:pane-b").is_some(),
        "the title stays"
    );
    assert!(cx.debug_bounds("pane-plain-browser:pane-b").is_some());
    assert!(cx.debug_bounds("pane-plain-browser:pane-a").is_none());
    assert!(cx.debug_bounds("pane-plain-browser:pane-c").is_none());
    assert!(cx.debug_bounds("browser-address").is_some());
    let text = view.read_with(cx, |_, _| PLAIN_BROWSER);
    assert_eq!(text, "This browser has no Tmux IDE controls");
    // The browser exits: the line goes.
    view.update(cx, |v, cx| {
        v.browser_state.plain_browsers.clear();
        cx.notify();
    });
    draw(cx);
    assert!(cx.debug_bounds("pane-plain-browser:pane-b").is_none());
}
