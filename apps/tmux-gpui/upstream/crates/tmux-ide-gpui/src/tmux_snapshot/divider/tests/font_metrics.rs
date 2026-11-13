use super::*;
#[test]
fn row_drag_uses_captured_nondefault_height() {
    let s = state(Axis::Rows);
    let bounds = Bounds::new(point(px(10.), px(20.)), size(px(110.), px(270.)));
    let start = bounds.origin + point(px(20.), px(4.5 * 30.));
    let mut drag = Drag::begin(&s, bounds, 10., 30., start).unwrap();
    drag.update(start + point(px(0.), px(30.)));
    assert!(matches!(
        drag.command(),
        Some(browser::Command::ResizePane {
            axis: Axis::Rows,
            cells: 5,
            ..
        })
    ));
}
#[gpui::test]
fn font_change_cancels_active_resize_without_sending_queued_motion(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            let mut s = state(Axis::Cols);
            s.resize_gesture_supported = true;
            let drag = Drag::begin(
                &s,
                bounds(),
                10.,
                crate::terminal::CELL_HEIGHT,
                point_at(5.5, 2.),
            )
            .unwrap();
            view.resize_gesture.begin(&drag);
            view.resize_gesture
                .flush(view.browser_commands.as_ref().unwrap(), true, true);
            receiver.try_iter().for_each(drop);
            view.resize_gesture.offer(7, false);
            view.divider = Some(drag);
            view.terminal_font.config.size = 21.;
            view.invalidate_font_geometry(cx);
            assert!(view.divider.is_none());
            assert!(matches!(
                receiver.try_recv().unwrap(),
                browser::Command::ResizeGesture {
                    update: gesture::Update::Cancel,
                    ..
                }
            ));
            assert!(receiver.try_recv().is_err());
            let _ = window;
        })
    });
}

/// #649: a resize the service never answers ends the connection, and the
/// status says that and what to do, not "Pane resize connection unavailable".
#[gpui::test]
fn a_resize_that_is_never_answered_says_the_connection_is_lost(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    cx.update(|_, cx| {
        view.update(cx, |view, cx| {
            let mut s = state(Axis::Cols);
            s.resize_gesture_supported = true;
            let drag = Drag::begin(
                &s,
                bounds(),
                10.,
                crate::terminal::CELL_HEIGHT,
                point_at(5.5, 2.),
            )
            .unwrap();
            view.resize_gesture.begin(&drag);
            view.resize_gesture
                .flush(view.browser_commands.as_ref().unwrap(), true, true);
            view.divider = Some(drag);
            assert!(
                receiver
                    .try_iter()
                    .any(|command| matches!(command, browser::Command::ResizeGesture { .. }))
            );
            // Released, and then no answer for longer than the stall limit.
            view.resize_gesture.offer(7, true);
            view.resize_gesture
                .test_idle_for(std::time::Duration::from_secs(13));
            view.flush_resize_gesture(cx);
            assert!(view.browser_commands.is_none());
            assert!(view.divider.is_none());
            assert!(!view.browser_state.input_ready);
            assert_eq!(
                view.browser_state.status,
                "Connection lost. Reopen Tmux IDE to reconnect."
            );
        })
    });
}
