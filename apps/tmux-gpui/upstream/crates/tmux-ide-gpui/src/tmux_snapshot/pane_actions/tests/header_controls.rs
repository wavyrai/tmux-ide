use super::*;
fn header_view(
    window: &mut Window,
    cx: &mut Context<SnapshotView>,
    sender: mpsc::SyncSender<browser::Command>,
) -> SnapshotView {
    let mut view = make_view(window, cx, sender);
    let mut frame = view.frame.as_ref().unwrap().legacy().as_ref().clone();
    frame.width = 40;
    frame.height = 20;
    let mut blank = frame.cells[0].clone();
    blank.symbol = " ".into();
    blank.modifier = 0;
    blank.skip = false;
    frame.cells = vec![blank; 800];
    frame.cursor = None;
    frame.graphics.clear();
    let frame = Arc::new(frame);
    view.frame = Some(crate::tmux_snapshot::display_frame::DisplayFrame::Legacy(
        frame.clone(),
    ));
    view.painted_frame = Some(crate::tmux_snapshot::display_frame::DisplayFrame::Legacy(
        frame.clone(),
    ));
    view.browser_state.frame = Some(crate::tmux_snapshot::display_frame::DisplayFrame::Legacy(
        frame,
    ));
    view.browser_state.panes = vec![
        choice("pane-a", "Same title"),
        choice("pane-b", "Same title"),
    ];
    view.browser_state.regions=serde_json::from_str(r#"[{"id":"pane-a","left":0,"top":0,"width":40,"height":9},{"id":"pane-b","left":0,"top":10,"width":40,"height":10}]"#).unwrap();
    view.input_interrupted = true;
    view
}
#[gpui::test]
fn lower_header_selects_exact_pane_then_opens_captured_context_without_input(
    cx: &mut TestAppContext,
) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| header_view(window, cx, sender));
    cx.simulate_resize(size(px(900.), px(700.)));
    cx.update(|window, cx| {
        window.draw(cx).clear(cx);
    });
    receiver.try_iter().for_each(drop);
    // Send the resized viewport's fit now: left pending, a draw sends it
    // after 150 ms of wall clock, among the messages this test counts.
    crate::tmux_snapshot::fit_test_support::settle(&view, cx, &receiver);
    let lower = cx.debug_bounds("pane-card-header:pane-b").unwrap();
    let terminal = view.read_with(cx, |v, _| v.input_geometry.unwrap().0);
    assert!(lower.origin.y >= terminal.origin.y);
    assert_eq!(
        lower.size.height,
        px(crate::tmux_snapshot::pane_cards::HEADER)
    );
    // The pane menu is a right-click on the title (#746).
    let title = cx.debug_bounds("pane-title:pane-b").unwrap();
    cx.simulate_mouse_down(title.center(), MouseButton::Right, Modifiers::default());
    assert!(
        matches!(receiver.try_recv().unwrap(),browser::Command::Pane{request:8,id} if id=="pane-b")
    );
    assert!(receiver.try_recv().is_err());
    assert!(view.read_with(cx, |v, _| v.picker.is_none()
        && v.divider.is_none()
        && v.input_interrupted));
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
            assert!(v.picker.is_some());
        })
    });
    cx.simulate_keystrokes("enter");
    view.read_with(cx, |v, _| {
        let menu = v.pane_actions.as_ref().unwrap();
        assert_eq!(menu.target.actions.id, "pane-b");
        assert_eq!(menu.target.actions.token, "new-token");
        assert!(menu.input.is_some());
        assert!(v.input_interrupted);
    });
    assert!(receiver.try_recv().is_err());
}
#[gpui::test]
fn header_history_mode_has_priority_and_restore_uses_absolute_current_target(
    cx: &mut TestAppContext,
) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| header_view(window, cx, sender));
    cx.simulate_resize(size(px(900.), px(700.)));
    cx.update(|window, cx| {
        view.update(cx, |v, _| {
            v.browser_state.history_offset = 12;
            v.browser_state.input_ready = false;
            v.browser_state.pane_actions.as_mut().unwrap().zoomed = true;
        });
        window.draw(cx).clear(cx);
    });
    receiver.try_iter().for_each(drop);
    let point = cx.debug_bounds("pane-mode:pane-a").unwrap().center();
    cx.simulate_click(point, Modifiers::default());
    assert!(
        matches!(receiver.try_recv().unwrap(),browser::Command::Input{input_target:None,request:7,id,input:crate::tmux_snapshot::keys::Input::Scroll(0)} if id=="pane-a")
    );
    cx.update(|window, cx| {
        view.update(cx, |v, _| {
            v.browser_state.history_offset = 0;
            v.browser_state.input_ready = true;
        });
        window.draw(cx).clear(cx);
    });
    // With input ready the resized viewport's fit is pending: send it now,
    // or a draw sends it after 150 ms of wall clock, ahead of the restore.
    crate::tmux_snapshot::fit_test_support::settle(&view, cx, &receiver);
    let point = cx.debug_bounds("pane-restore:pane-a").unwrap().center();
    cx.simulate_click(point, Modifiers::default());
    assert!(
        matches!(receiver.try_recv().unwrap(),browser::Command::PaneAction{request:7,id,action:Action::Zoom{desired:Zoom::Unzoomed},..} if id=="pane-a")
    );
    assert!(receiver.try_recv().is_err());
    assert!(view.read_with(cx, |v, _| v.input_interrupted));
}
#[gpui::test]
fn pending_header_menu_is_cancelled_by_competing_modal_or_navigation(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| header_view(window, cx, sender));
    cx.simulate_resize(size(px(900.), px(700.)));
    cx.update(|window, cx| {
        window.draw(cx).clear(cx);
    });
    receiver.try_iter().for_each(drop);
    // Send the resized viewport's fit now: left pending, a draw sends it
    // after 150 ms of wall clock, among the messages this test counts.
    crate::tmux_snapshot::fit_test_support::settle(&view, cx, &receiver);
    let point = cx.debug_bounds("pane-title:pane-b").unwrap().center();
    cx.simulate_mouse_down(point, MouseButton::Right, Modifiers::default());
    receiver.try_iter().for_each(drop);
    cx.update(|window, cx| {
        view.update(cx, |v, cx| {
            v.open_picker(window, cx);
            v.browser_state.request = v.browser_request;
            v.browser_state.selected_pane = Some("pane-b".into());
            v.browser_state.pane_actions = Some(browser::PaneActions {
                id: "pane-b".into(),
                token: "replacement".into(),
                zoomed: false,
            });
            v.browser_state.input_ready = true;
            v.finish_header_actions(window, cx);
            assert!(v.picker.is_some());
            assert!(v.pane_actions.is_none());
        })
    });
    assert!(receiver.try_recv().is_err());
}

mod back_to_live;

#[path = "header_buttons.rs"]
mod buttons;
#[path = "close_card_lifecycle.rs"]
mod close_card_lifecycle;
