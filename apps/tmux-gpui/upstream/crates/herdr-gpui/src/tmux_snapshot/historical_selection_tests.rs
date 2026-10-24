use super::*;

pub(super) fn history(view: &mut SnapshotView) {
    // Use the same geometry installation as the existing click fixture: rendering
    // may have replaced the constructor's placeholder bounds before this event.
    view.input_geometry = Some((
        Bounds::new(point(px(0.), px(0.)), size(px(600.), px(500.))),
        Bounds::default(),
    ));
    view.input_cell_width = Some(10.);
    let mut frame = view.frame.as_ref().unwrap().legacy().as_ref().clone();
    frame.cells[0].symbol = "界".into();
    frame.cells[1].symbol = " ".into();
    frame.cells[1].skip = true;
    frame.cells[2].symbol = "e\u{301}".into();
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
    view.browser_state.request = view.browser_request;
    view.browser_state.history_offset = 30;
    view.browser_state.input_ready = false;
    view.input_interrupted = true;
    view.browser_state.regions =
        serde_json::from_str(r#"[{"id":"pane-a","left":0,"top":0,"width":60,"height":20}]"#)
            .unwrap();
    view.browser_state.copy_region = Some(crate::tmux_snapshot::copy::Region {
        id: "pane-a".into(),
        left: 0,
        top: 0,
        width: 60,
        height: 20,
        wrapped: vec![false; 20],
    });
}

#[gpui::test]
fn historical_pointer_selection_copies_unicode_without_rearming_input(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(32);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    receiver.try_iter().for_each(drop);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            history(view);
            view.terminal_click(
                &MouseDownEvent {
                    position: point(px(1.), px(5.)),
                    button: MouseButton::Left,
                    ..Default::default()
                },
                window,
                cx,
            );
            view.terminal_drag(
                &MouseMoveEvent {
                    position: point(px(30.), px(5.)),
                    pressed_button: Some(MouseButton::Left),
                    ..Default::default()
                },
                window,
                cx,
            );
            assert_eq!(
                view.selection.as_ref().map(|s| s.text().unwrap()),
                Some("界e\u{301}".into())
            );
            view.terminal_key(&key("cmd-c"), window, cx);
            assert_eq!(
                cx.read_from_clipboard().and_then(|item| item.text()),
                Some("界e\u{301}".into())
            );
            assert!(view.input_interrupted);
            assert!(!view.terminal_input_ready());
            view.replace_text_in_range(None, "forbidden", window, cx);
            view.terminal_key(&key("enter"), window, cx);
            assert!(receiver.try_recv().is_err());
            assert_eq!(view.browser_state.history_offset, 30);
        })
    });
}

#[gpui::test]
fn historical_selection_rejects_stale_disconnected_unpainted_and_other_pane(
    cx: &mut TestAppContext,
) {
    for refusal in 0..7 {
        let (sender, receiver) = mpsc::sync_channel(32);
        let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
        receiver.try_iter().for_each(drop);
        cx.update(|window, cx| {
            view.update(cx, |view, cx| {
                history(view);
                match refusal {
                    0 => view.browser_state.request += 1,
                    1 => view.browser_commands = None,
                    2 => {
                        view.presence.set_active(false);
                    }
                    3 => view.painted_frame = None,
                    4 => view.browser_state.copy_region = None,
                    5 => {
                        view.browser_state.regions = serde_json::from_str(
                            r#"[{"id":"pane-b","left":0,"top":0,"width":60,"height":20}]"#,
                        )
                        .unwrap()
                    }
                    _ => {
                        view.browser_state.frame = Some(
                            Arc::new(view.frame.as_ref().unwrap().legacy().as_ref().clone()).into(),
                        )
                    }
                }
                view.terminal_click(
                    &MouseDownEvent {
                        position: point(px(1.), px(5.)),
                        button: MouseButton::Left,
                        ..Default::default()
                    },
                    window,
                    cx,
                );
                assert!(view.selection.is_none(), "refusal {refusal}");
                assert!(view.input_interrupted);
                assert_eq!(view.browser_request, 7);
                assert_eq!(view.browser_state.selected_pane.as_deref(), Some("pane-a"));
                assert!(receiver.try_recv().is_err());
            })
        });
    }
}

#[gpui::test]
fn historical_selection_joins_soft_wrap_but_preserves_hard_newline(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(32);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    receiver.try_iter().for_each(drop);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            history(view);
            let mut frame = view.frame.as_ref().unwrap().legacy().as_ref().clone();
            for cell in &mut frame.cells {
                cell.symbol = " ".into();
                cell.skip = false;
            }
            frame.cells[59].symbol = "λ".into();
            frame.cells[60].symbol = "界".into();
            frame.cells[61].skip = true;
            frame.cells[62].symbol = "e\u{301}".into();
            frame.cells[120].symbol = "Z".into();
            let frame = Arc::new(frame);
            view.frame = Some(crate::tmux_snapshot::display_frame::DisplayFrame::Legacy(
                frame.clone(),
            ));
            view.browser_state.frame = Some(
                crate::tmux_snapshot::display_frame::DisplayFrame::Legacy(frame.clone()),
            );
            view.painted_frame = Some(crate::tmux_snapshot::display_frame::DisplayFrame::Legacy(
                frame,
            ));
            view.browser_state.copy_region.as_mut().unwrap().wrapped[1] = true;
            view.input_geometry.as_mut().unwrap().0.size.width = px(600.);
            view.terminal_click(
                &MouseDownEvent {
                    position: point(px(590.), px(5.)),
                    button: MouseButton::Left,
                    ..Default::default()
                },
                window,
                cx,
            );
            view.terminal_drag(
                &MouseMoveEvent {
                    position: point(px(10.), px(view.terminal_height() * 2. + 1.)),
                    pressed_button: Some(MouseButton::Left),
                    ..Default::default()
                },
                window,
                cx,
            );
            assert_eq!(
                view.selection.as_ref().unwrap().text().unwrap(),
                "λ界e\u{301}\nZ"
            );
            assert!(view.input_interrupted);
            assert!(receiver.try_recv().is_err());
        })
    });
}
