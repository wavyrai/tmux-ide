use super::*;

#[gpui::test]
fn narrow_sidebar_keeps_controls_visible_while_end_reveals_exact_session(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    cx.simulate_resize(size(px(640.), px(400.)));
    cx.update(|window, cx| {
        view.update(cx, |view, _| {
            view.browser_state.sessions = (0..30)
                .map(|i| choice(&format!("s{i}"), "Duplicate session with long context"))
                .collect();
            view.browser_state.selected_session = Some("s0".into());
        });
        window.draw(cx).clear(cx);
    });
    receiver.try_iter().for_each(drop);
    crate::tmux_snapshot::fit_test_support::settle(&view, cx, &receiver);
    for selector in ["open-picker", "open-theme-picker", "refresh-sessions"] {
        let control = cx.debug_bounds(selector).unwrap();
        assert!(
            control.top() >= px(0.) && control.bottom() <= px(400.),
            "{selector} must remain inside the narrow viewport"
        );
        assert!(control.left() >= px(0.) && control.right() <= px(224.));
    }
    cx.simulate_keystrokes("ctrl-g end");
    cx.update(|window, cx| window.draw(cx).clear(cx));
    let list = cx.debug_bounds("session-list").unwrap();
    let last = cx.debug_bounds("tmux-sidebar-row-29").unwrap();
    let switch = cx.debug_bounds("open-picker").unwrap();
    assert!(last.top() >= list.top() && last.bottom() <= list.bottom());
    assert!(
        list.bottom() <= switch.top(),
        "scrolling rows must not cover fixed controls"
    );
    assert!(switch.bottom() <= px(400.));
    assert!(
        receiver.try_recv().is_err(),
        "focus/reveal must not send terminal input"
    );
    cx.simulate_click(switch.center(), Modifiers::default());
    view.read_with(cx, |view, _| {
        assert!(
            view.picker.is_some(),
            "fixed Switch control must receive the actual pointer click"
        );
    });
    assert!(
        receiver.try_recv().is_err(),
        "opening the switcher must not navigate or send input"
    );
    cx.simulate_keystrokes("escape ctrl-g end enter");
    assert!(
        matches!(receiver.try_recv().unwrap(), browser::Command::Session { request: 8, id } if id == "s29")
    );
    assert!(receiver.try_recv().is_err());
}

#[gpui::test]
fn sidebar_controls_survive_resize_and_scroll_return_without_rearming_input(
    cx: &mut TestAppContext,
) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    cx.update(|window, cx| {
        view.update(cx, |view, _| view.input_interrupted = true);
        window.draw(cx).clear(cx);
    });
    receiver.try_iter().for_each(drop);
    for dimensions in [(1000., 650.), (640., 400.), (1000., 650.), (640., 400.)] {
        cx.simulate_resize(size(px(dimensions.0), px(dimensions.1)));
        cx.update(|window, cx| window.draw(cx).clear(cx));
        let switch = cx.debug_bounds("open-picker").unwrap();
        assert!(switch.bottom() <= px(dimensions.1));
        cx.simulate_keystrokes("ctrl-g end home escape");
        view.read_with(cx, |view, _| assert!(view.input_interrupted));
    }
    assert!(
        receiver.try_iter().all(|command| matches!(
            command,
            browser::Command::Input {
                input: crate::tmux_snapshot::keys::Input::Resize { .. },
                ..
            }
        )),
        "resize may update owned geometry but never emit key or navigation commands"
    );
}
