use super::*;

/// While Herdr reports that the focused pane wants every key, a key sent as a
/// key event is released on key-up, even after its modifier was let go first.
/// Without the report, nothing is held and no release is sent.
#[gpui::test]
fn keyboard_report_all_releases_sent_keys(cx: &mut gpui::TestAppContext) {
    let (fixture, cx) = cx.add_window_view(|window, cx| {
        Fixture(cx.new(|cx| crate::sidebar::layout_tests::fixture_window(window, cx)))
    });
    let view = fixture.update(cx, |fixture, _| fixture.0.clone());
    let (endpoint, mut server) = connected_endpoint("report-all");
    let down = |keystroke: &str| gpui::KeyDownEvent {
        keystroke: gpui::Keystroke::parse(keystroke).unwrap(),
        is_held: false,
        prefer_character_input: false,
    };
    let up = |keystroke: &str| gpui::KeyUpEvent {
        keystroke: gpui::Keystroke::parse(keystroke).unwrap(),
    };
    let key = |code, modifiers, kind, tracks_release| ClientMessage::ClientShellPaneInput {
        pane_id: "w1:p1".into(),
        events: vec![ClientPaneInputEvent::Key {
            code,
            modifiers,
            kind,
            repeat_count: 1,
            shifted_codepoint: None,
            generated_text: None,
            tracks_release,
            physical_key_id: None,
            windows_record: None,
        }],
    };
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            prepare_mouse(view, endpoint, cx);
            view.live.activation = Some(crate::state::SurfaceActivation {
                request: "activate-1".into(),
                boot: view.live.snapshot.as_ref().unwrap().boot_id.clone(),
                revision: Some(view.live.surface.as_ref().unwrap().projection_revision),
                failed: false,
                focus: None,
                active: true,
            });
            view.live.keyboard_report_all = true;
            view.key_down(&down("ctrl-c"), window, cx);
            view.key_up(&up("c"), window, cx);
            // A second key-up has nothing left to release.
            view.key_up(&up("c"), window, cx);
            // A pane key presses and releases the key it sends instead.
            view.config.keybindings = crate::keymap::Keymap::with_overrides(
                &Default::default(),
                &[("cmd-backspace".into(), "ctrl-u".into())].into(),
                &crate::keymap::DaemonKeys::default(),
            )
            .unwrap();
            view.key_down(&down("cmd-backspace"), window, cx);
            view.key_up(&up("backspace"), window, cx);
            view.live.keyboard_report_all = false;
            view.key_down(&down("left"), window, cx);
            view.key_up(&up("left"), window, cx);
            view.send(ClientPaneInputEvent::TextCommit("sentinel".into()), cx);
        });
    });
    use ClientKeyKind::{Press, Release};
    assert_eq!(
        server.receive(),
        key(ClientKeyCode::Char('c'), 2, Press, true)
    );
    assert_eq!(
        server.receive(),
        key(ClientKeyCode::Char('c'), 2, Release, true)
    );
    for kind in [Press, Release] {
        assert_eq!(
            server.receive(),
            key(ClientKeyCode::Char('u'), 2, kind, true)
        );
    }
    assert_eq!(server.receive(), key(ClientKeyCode::Left, 0, Press, false));
    assert_eq!(
        server.receive(),
        ClientMessage::ClientShellPaneInput {
            pane_id: "w1:p1".into(),
            events: vec![ClientPaneInputEvent::TextCommit("sentinel".into())],
        }
    );
}

/// The daemon's custom command shortcuts and Herdr's resize mode answer
/// typed keys with endpoint requests: a custom command's chord invokes it by
/// ID on the focused target, and resize mode turns `h` into a resize.
#[gpui::test]
fn custom_command_and_resize_mode_keys_send_endpoint_requests(cx: &mut gpui::TestAppContext) {
    let (fixture, cx) = cx.add_window_view(|window, cx| {
        Fixture(cx.new(|cx| crate::sidebar::layout_tests::fixture_window(window, cx)))
    });
    let view = fixture.update(cx, |fixture, _| fixture.0.clone());
    let press = |key: &str, cx: &mut gpui::VisualTestContext| {
        cx.update(|window, cx| window.dispatch_keystroke(gpui::Keystroke::parse(key).unwrap(), cx));
    };
    for resize in [false, true] {
        let (endpoint, mut server) = connected_endpoint("ssh:fixture");
        cx.update(|_, cx| {
            view.update(cx, |view, cx| {
                view.endpoints.truncate(1);
                view.endpoints.push(endpoint);
                view.selected_endpoint = 1;
                view.options = ConnectOptions::default();
                view.reset_selected(cx);
                view.activation_deadline = None;
                // The fixture's `prefix+x` is Close Pane's chord, which wins.
                let relabel = |snapshot: &mut Arc<ClientShellSnapshot>| {
                    Arc::make_mut(snapshot).commands[0].binding_labels = vec!["prefix+y".into()];
                };
                relabel(view.live.snapshot.as_mut().unwrap());
                let mut inbox = view.endpoints[1].connection.inbox.lock().unwrap();
                relabel(inbox.snapshot.as_mut().unwrap());
                drop(inbox);
                assert!(view.input_ready());
            })
        });
        let keys: &[&str] = if resize {
            &["ctrl-b", "r", "h"]
        } else {
            &["ctrl-b", "y"]
        };
        for key in keys {
            press(key, cx);
        }
        let ClientMessage::ClientShellEndpointRequest { request, .. } = server.receive() else {
            panic!("missing command");
        };
        let request: serde_json::Value = serde_json::from_str(&request).unwrap();
        let focused = snapshot();
        if resize {
            assert_eq!(request["method"], Method::PaneResize.as_str());
            assert_eq!(
                request["params"],
                serde_json::json!({"pane_id": focused.focused_pane_id, "direction": "left"})
            );
            assert!(view.read_with(cx, |view, _| view.resize_mode));
            press("escape", cx);
            assert!(view.read_with(cx, |view, _| !view.resize_mode));
        } else {
            assert_eq!(request["method"], Method::CommandInvoke.as_str());
            assert_eq!(
                request["params"],
                serde_json::json!({
                    "command_id": "command-v1",
                    "workspace_id": focused.focused_workspace_id,
                    "tab_id": focused.focused_tab_id,
                    "pane_id": focused.focused_pane_id,
                })
            );
        }
    }
}
