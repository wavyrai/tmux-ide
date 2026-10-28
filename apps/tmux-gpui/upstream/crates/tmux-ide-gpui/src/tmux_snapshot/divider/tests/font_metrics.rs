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
