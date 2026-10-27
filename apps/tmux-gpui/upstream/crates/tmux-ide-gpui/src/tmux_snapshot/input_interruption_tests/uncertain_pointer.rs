use super::*;

fn rejected_pointer_cannot_keep_previous_keyboard_target(
    cx: &mut TestAppContext,
    missing_geometry: bool,
) {
    let (sender, receiver) = mpsc::sync_channel(32);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    receiver.try_iter().for_each(drop);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.browser_state.input_ready = true;
            view.browser_state.regions = serde_json::from_str(
                r#"[{"id":"pane-a","left":0,"top":0,"width":1,"height":1},{"id":"pane-b","left":1,"top":0,"width":1,"height":1}]"#,
            )
            .unwrap();
            assert!(view.terminal_input_ready());
            assert!(!view.input_interrupted);
            let position = point(px(15.), px(5.));
            assert_eq!(
                crate::tmux_snapshot::hit_regions::hit(
                    &view.browser_state.regions,
                    15.,
                    5.,
                    10.,
                    view.terminal_height(),
                ),
                Some("pane-b"),
                "the click intends the other pane, not the current keyboard target"
            );
            if missing_geometry {
                view.input_geometry = None;
            } else {
                view.painted_frame = None;
            }
            view.terminal_click(
                &MouseDownEvent {
                    position,
                    button: MouseButton::Left,
                    ..Default::default()
                },
                window,
                cx,
            );
            view.replace_text_in_range(None, "intended-for-pane-b", window, cx);
            view.terminal_key(&key("enter"), window, cx);
            if let Ok(command) = receiver.try_recv() {
                match command {
                    browser::Command::Input { id, .. } => panic!(
                        "unverifiable click intended pane-b emitted input to {id}; previous target was pane-a"
                    ),
                    _ => panic!("unverifiable click unexpectedly emitted a browser command"),
                }
            }
            assert!(view.input_interrupted);
            assert_eq!(view.browser_state.selected_pane.as_deref(), Some("pane-a"));
        });
    });
}

#[gpui::test]
fn ready_unpainted_click_cannot_send_to_previous_pane(cx: &mut TestAppContext) {
    rejected_pointer_cannot_keep_previous_keyboard_target(cx, false);
}

#[gpui::test]
fn ready_geometry_missing_click_cannot_send_to_previous_pane(cx: &mut TestAppContext) {
    rejected_pointer_cannot_keep_previous_keyboard_target(cx, true);
}
