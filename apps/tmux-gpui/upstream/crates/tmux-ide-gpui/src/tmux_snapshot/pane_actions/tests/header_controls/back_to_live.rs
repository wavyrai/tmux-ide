use super::*;
use crate::tmux_snapshot::{copy, keys::Input, pending_input::Target};

#[gpui::test]
fn back_to_live_click_holds_new_typing_until_live_authority(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| header_view(window, cx, sender));
    cx.simulate_resize(size(px(900.), px(700.)));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    receiver.try_iter().for_each(drop);
    crate::tmux_snapshot::fit_test_support::settle(&view, cx, &receiver);
    cx.update(|window, cx| {
        view.update(cx, |v, _| {
            v.browser_state.history_offset = 12;
            v.browser_state.input_ready = false;
            v.browser_state.presence_revision = 1;
            v.browser_state.native_focus_target = Some(Target {
                id: "pane-a".into(),
                token: "a".repeat(64),
            });
            v.browser_state.copy_region = Some(copy::Region {
                id: "pane-a".into(),
                left: 0,
                top: 0,
                width: 40,
                height: 9,
                wrapped: vec![false; 9],
            });
        });
        window.draw(cx).clear(cx);
    });
    receiver.try_iter().for_each(drop);
    let point = cx.debug_bounds("pane-mode:pane-a").unwrap().center();
    cx.simulate_click(point, Modifiers::default());
    assert!(matches!(
        receiver.try_recv().unwrap(),
        browser::Command::Input {
            input: Input::Scroll(0),
            ..
        }
    ));
    cx.simulate_input("new");
    cx.simulate_keystrokes("enter");
    assert!(
        receiver.try_recv().is_err(),
        "history cannot receive terminal input"
    );
    assert!(!view.read_with(cx, |v, _| v.input_interrupted));
    cx.update(|window, cx| {
        view.update(cx, |v, cx| {
            let mut state = v.browser_state.clone();
            state.history_offset = 0;
            state.input_ready = true;
            state.input_targets = vec![Target {
                id: "pane-a".into(),
                token: "a".repeat(64),
            }];
            v.apply_browser_state(Some(state), cx);
        });
        window.draw(cx).clear(cx);
    });
    let mut typed = String::new();
    for command in receiver.try_iter() {
        let browser::Command::Input {
            input,
            input_target: Some(token),
            ..
        } = command
        else {
            panic!("unexpected command");
        };
        assert_eq!(token, "a".repeat(64));
        match input {
            Input::Text(s) => typed.push_str(&s),
            Input::Key(key) if key == "Enter" => typed.push('\n'),
            _ => panic!("unexpected input"),
        }
    }
    assert_eq!(typed, "new\n");
}

#[gpui::test]
fn back_to_live_never_replays_after_scope_change_or_expiry(cx: &mut TestAppContext) {
    for refusal in 0..6 {
        let (sender, receiver) = mpsc::sync_channel(64);
        let (view, cx) = cx.add_window_view(|window, cx| header_view(window, cx, sender));
        cx.simulate_resize(size(px(900.), px(700.)));
        cx.update(|window, cx| window.draw(cx).clear(cx));
        receiver.try_iter().for_each(drop);
        crate::tmux_snapshot::fit_test_support::settle(&view, cx, &receiver);
        cx.update(|window, cx| {
            view.update(cx, |v, _| {
                v.browser_state.history_offset = 12;
                v.browser_state.input_ready = false;
                v.browser_state.presence_revision = 1;
                v.browser_state.native_focus_target = Some(Target {
                    id: "pane-a".into(),
                    token: "a".repeat(64),
                });
                v.browser_state.copy_region = Some(copy::Region {
                    id: "pane-a".into(),
                    left: 0,
                    top: 0,
                    width: 40,
                    height: 9,
                    wrapped: vec![false; 9],
                });
            });
            window.draw(cx).clear(cx);
        });
        receiver.try_iter().for_each(drop);
        let point = cx.debug_bounds("pane-mode:pane-a").unwrap().center();
        cx.simulate_click(point, Modifiers::default());
        assert!(matches!(
            receiver.try_recv().unwrap(),
            browser::Command::Input {
                input: Input::Scroll(0),
                ..
            }
        ));
        cx.simulate_input("held");
        assert!(receiver.try_recv().is_err());
        cx.update(|window, cx| {
            view.update(cx, |v, cx| {
                let mut state = v.browser_state.clone();
                state.history_offset = 0;
                state.input_ready = true;
                state.input_targets = vec![Target {
                    id: "pane-a".into(),
                    token: "a".repeat(64),
                }];
                match refusal {
                    0 => state.native_focus_target.as_mut().unwrap().token = "b".repeat(64),
                    1 => {
                        v.presence.set_active(false);
                    }
                    2 => v.age_pending_input(),
                    3 => v.browser_request += 1,
                    4 => state.history_offset = 13,
                    5 => state.selected_session = Some("replacement".into()),
                    _ => unreachable!(),
                }
                v.apply_browser_state(Some(state), cx);
                v.replace_text_in_range(None, "suffix", window, cx);
                assert!(v.input_interrupted, "case {refusal}");
                assert!(v.pending_input.is_none());
            });
        });
        assert!(receiver.try_recv().is_err(), "case {refusal}");
    }
}
