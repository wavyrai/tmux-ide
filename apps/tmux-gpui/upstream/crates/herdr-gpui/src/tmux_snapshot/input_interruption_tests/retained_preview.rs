use super::*;

#[gpui::test]
fn retained_preview_cannot_reuse_stale_input_geometry_or_capabilities(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    receiver.try_iter().for_each(drop);
    cx.update(|window, cx| {
        view.update(cx, |v, cx| {
            // Deliberately hostile local state: the marker must independently deny
            // authority even if old readiness, region and target fields survived.
            v.browser_state.retained_preview = true;
            v.browser_state.input_ready = true;
            v.browser_state.request = v.browser_request;
            v.browser_state.copy_region = Some(crate::tmux_snapshot::copy::Region {
                id: "pane-a".into(),
                left: 0,
                top: 0,
                width: 1,
                height: 1,
                wrapped: vec![false],
            });
            assert!(!v.terminal_input_ready());
            v.browser_state.history_offset = 1;
            assert!(!v.historical_selection_ready());
            assert!(
                crate::tmux_snapshot::selection::Capture::begin(&v.browser_state, 0., 0.).is_none()
            );
            assert!(v.terminal_web_link(point(px(2.), px(2.))).is_none());
            cx.write_to_clipboard(ClipboardItem::new_string("preview-copy-sentinel".into()));
            v.terminal_key(&key("cmd-shift-c"), window, cx);
            assert_eq!(
                cx.read_from_clipboard()
                    .and_then(|item| item.text())
                    .as_deref(),
                Some("preview-copy-sentinel")
            );
            click(v, window, cx);
            assert!(v.selection.is_none());
            assert!(v.input_interrupted);
            v.terminal_wheel(
                &ScrollWheelEvent {
                    position: point(px(2.), px(2.)),
                    delta: ScrollDelta::Lines(point(0., -1.)),
                    touch_phase: TouchPhase::Moved,
                    ..Default::default()
                },
                window,
                cx,
            );
            for input in [
                Input::Text("no".into()),
                Input::Paste("no".into()),
                Input::Key("Enter".into()),
                Input::Scroll(0),
                Input::Resize { cols: 80, rows: 24 },
            ] {
                v.queue_input(input, cx);
            }
            assert!(receiver.try_recv().is_err());
        });
        window.draw(cx).clear(cx);
    });
    assert!(
        receiver.try_recv().is_err(),
        "painting a preview must not request daemon resize"
    );
}
