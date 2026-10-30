use super::*;
#[gpui::test]
fn direct_expand_uses_current_target_and_close_requires_confirmation(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (_view, cx) = cx.add_window_view(|window, cx| header_view(window, cx, sender));
    cx.simulate_resize(size(px(900.), px(700.)));
    cx.update(|window, cx| {
        window.draw(cx).clear(cx);
    });
    receiver.try_iter().for_each(drop);
    let expand = cx.debug_bounds("pane-expand:pane-a").unwrap();
    let close = cx.debug_bounds("pane-close:pane-a").unwrap();
    assert!(expand.right() <= close.left());
    // The two hit areas sit edge to edge at the header's right end: a gap
    // between them would be a dead strip in the header.
    assert_eq!(expand.right(), close.left());
    assert_eq!(expand.size, close.size);
    // The pane title is a Bezel tab filling the header row, not Bezel's
    // 24 pt chip floating in it.
    let title = cx.debug_bounds("pane-title:pane-a").unwrap();
    assert_eq!(title.size.height, close.size.height);
    assert_eq!(title.top(), close.top());
    cx.simulate_click(close.center(), Modifiers::default());
    assert!(
        receiver.try_recv().is_err(),
        "Close must wait for confirmation"
    );
    cx.update(|window, cx| {
        window.draw(cx).clear(cx);
    });
    assert!(cx.debug_bounds("pane-close-confirmation").is_some());
    cx.simulate_keystrokes("escape");
    cx.update(|window, cx| {
        window.draw(cx).clear(cx);
    });
    cx.simulate_click(expand.center(), Modifiers::default());
    assert!(
        matches!(receiver.try_recv().unwrap(), browser::Command::PaneAction { id, action: Action::Zoom { desired: Zoom::Zoomed }, .. } if id == "pane-a")
    );
    assert!(receiver.try_recv().is_err());
}

#[gpui::test]
fn closing_an_unselected_header_waits_for_that_panes_authority(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| header_view(window, cx, sender));
    cx.simulate_resize(size(px(900.), px(700.)));
    cx.update(|window, cx| {
        window.draw(cx).clear(cx);
    });
    receiver.try_iter().for_each(drop);
    let close = cx.debug_bounds("pane-close:pane-b").unwrap();
    cx.simulate_click(close.center(), Modifiers::default());
    assert!(
        matches!(receiver.try_recv().unwrap(), browser::Command::Pane { request: 8, id } if id == "pane-b")
    );
    assert!(receiver.try_recv().is_err());
    cx.update(|window, cx| {
        view.update(cx, |v, cx| {
            v.browser_state.request = 8;
            v.browser_state.selected_pane = Some("pane-b".into());
            v.browser_state.input_ready = true;
            v.browser_state.pane_actions = Some(browser::PaneActions {
                id: "pane-b".into(),
                token: "new-token".into(),
                zoomed: false,
            });
            v.finish_header_actions(window, cx);
        });
        window.draw(cx).clear(cx);
    });
    assert!(cx.debug_bounds("pane-close-confirmation").is_some());
    assert!(receiver.try_recv().is_err());
    cx.simulate_keystrokes("enter");
    assert!(
        matches!(receiver.try_recv().unwrap(), browser::Command::PaneAction { request: 8, id, token, action: Action::Close } if id == "pane-b" && token == "new-token")
    );
    assert!(receiver.try_recv().is_err());
}
