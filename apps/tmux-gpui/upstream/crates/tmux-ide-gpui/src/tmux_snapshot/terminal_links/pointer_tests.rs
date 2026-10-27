use super::*;
fn prepare(view: &mut SnapshotView) {
    historical_selection_tests::history(view);
    let mut frame = view.frame.as_ref().unwrap().legacy().as_ref().clone();
    for cell in &mut frame.cells {
        cell.symbol = " ".into();
        cell.skip = false;
    }
    for (cell, c) in frame.cells.iter_mut().zip("https://example.com/ ".chars()) {
        cell.symbol = c.to_string();
    }
    let frame = Arc::new(frame);
    view.frame = Some(crate::tmux_snapshot::display_frame::DisplayFrame::Legacy(
        frame.clone(),
    ));
    view.browser_state.frame = Some(crate::tmux_snapshot::display_frame::DisplayFrame::Legacy(
        frame.clone(),
    ));
    view.painted_frame = Some(crate::tmux_snapshot::display_frame::DisplayFrame::Legacy(
        frame,
    ));
}
#[gpui::test]
fn modifier_click_opens_without_input_or_rearming(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(32);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    receiver.try_iter().for_each(drop);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            prepare(view);
            let mut event = MouseDownEvent {
                position: point(px(45.), px(5.)),
                ..Default::default()
            };
            event.modifiers.platform = true;
            view.terminal_click(&event, window, cx);
            assert!(view.input_interrupted);
            assert!(view.selection.is_none());
            assert_eq!(view.browser_request, 7);
            assert!(receiver.try_recv().is_err());
        })
    });
    assert_eq!(cx.opened_url().as_deref(), Some("https://example.com/"));
}
#[gpui::test]
fn link_admission_refuses_stale_overlay_inactive_and_other_pane(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(32);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    receiver.try_iter().for_each(drop);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            for refusal in 0..6 {
                prepare(view);
                view.browser_state.request = view.browser_request;
                view.marked.clear();
                view.picker = None;
                view.browser_state.selected_pane = Some("pane-a".into());
                view.presence = Presence::new(true);
                view.presence.flush(view.browser_commands.as_ref().unwrap());
                view.presence.acknowledge(1);
                receiver.try_iter().for_each(drop);
                match refusal {
                    0 => view.browser_state.request += 1,
                    1 => view.painted_frame = None,
                    2 => {
                        view.presence.set_active(false);
                    }
                    3 => view.marked = "composition".into(),
                    4 => view.browser_state.selected_pane = Some("other-pane".into()),
                    _ => view.open_picker(window, cx),
                }
                assert!(view.terminal_web_link(point(px(45.), px(5.))).is_none());
            }
            assert!(receiver.try_recv().is_err());
        })
    });
}
