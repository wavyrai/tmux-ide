use super::*;

#[gpui::test]
fn sidebar_reveals_new_selection_once_and_respects_manual_scroll(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    cx.simulate_resize(size(px(640.), px(400.)));
    cx.update(|window, cx| {
        view.update(cx, |view, _| {
            view.browser_state.sessions = (0..40)
                .map(|i| {
                    choice(
                        &format!("s{i}"),
                        &"Long duplicate session 日本語 ".repeat(5),
                    )
                })
                .collect();
            view.browser_state.selected_session = Some("s35".into());
        });
        window.draw(cx).clear(cx);
        window.draw(cx).clear(cx);
    });
    receiver.try_iter().for_each(drop);
    crate::tmux_snapshot::fit_test_support::settle(&view, cx, &receiver);
    let list = cx.debug_bounds("session-list").unwrap();
    let selected = cx.debug_bounds("tmux-sidebar-row-35").unwrap();
    assert!(selected.top() >= list.top() && selected.bottom() <= list.bottom());
    let label = cx.debug_bounds("tmux-sidebar-label-35").unwrap();
    assert!(label.left() >= list.left() && label.right() <= list.right());
    // Actual wheel input scrolls away from selection, then unrelated repaints
    // and status updates must not pull the list back.
    cx.simulate_event(ScrollWheelEvent {
        position: list.center(),
        delta: ScrollDelta::Pixels(point(px(0.), px(5000.))),
        modifiers: Modifiers::default(),
        touch_phase: TouchPhase::Moved,
    });
    cx.update(|window, cx| window.draw(cx).clear(cx));
    let manually_scrolled = view.read_with(cx, |view, _| view.sidebar_keyboard.scroll.offset());
    assert_eq!(manually_scrolled.y, px(0.));
    cx.update(|window, cx| {
        view.update(cx, |view, _| {
            view.browser_state.status = "Unrelated status update".into()
        });
        window.draw(cx).clear(cx);
        window.draw(cx).clear(cx);
    });
    view.read_with(cx, |view, _| {
        assert_eq!(view.sidebar_keyboard.scroll.offset(), manually_scrolled)
    });
    cx.update(|window, cx| {
        view.update(cx, |view, _| {
            view.browser_state.selected_session = Some("s30".into())
        });
        window.draw(cx).clear(cx);
    });
    let changed = cx.debug_bounds("tmux-sidebar-row-30").unwrap();
    assert!(changed.top() >= list.top() && changed.bottom() <= list.bottom());
    assert!(
        receiver.try_recv().is_err(),
        "selection reveal and sidebar wheel never grant terminal input"
    );
}

#[gpui::test]
fn sidebar_keyboard_reveal_is_not_undone_on_escape_or_row_reorder(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    cx.simulate_resize(size(px(640.), px(400.)));
    cx.update(|window, cx| {
        view.update(cx, |view, _| {
            view.browser_state.sessions = (0..40)
                .map(|i| choice(&format!("s{i}"), "Same label"))
                .collect();
            view.browser_state.selected_session = Some("s0".into());
            view.input_interrupted = true;
        });
        window.draw(cx).clear(cx);
        window.draw(cx).clear(cx);
    });
    receiver.try_iter().for_each(drop);
    crate::tmux_snapshot::fit_test_support::settle(&view, cx, &receiver);
    cx.simulate_keystrokes("ctrl-g end escape");
    cx.update(|window, cx| window.draw(cx).clear(cx));
    let offset = view.read_with(cx, |view, _| view.sidebar_keyboard.scroll.offset());
    assert!(offset.y < px(0.));
    cx.update(|window, cx| {
        view.update(cx, |view, _| view.browser_state.sessions.swap(0, 1));
        window.draw(cx).clear(cx);
        window.draw(cx).clear(cx);
    });
    view.read_with(cx, |view, _| {
        assert_eq!(view.sidebar_keyboard.scroll.offset(), offset);
        assert!(view.input_interrupted);
    });
    assert!(receiver.try_recv().is_err());
}
