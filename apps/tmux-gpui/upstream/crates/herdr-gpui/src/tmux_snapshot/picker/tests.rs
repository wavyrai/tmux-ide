#![allow(clippy::unwrap_used)]
use super::*;
use crate::tmux_snapshot::{decode, presence::Presence};
use core::prelude::v1::test;
use std::{
    cell::RefCell,
    rc::Rc,
    sync::{Arc, mpsc},
};
fn choice(id: &str, label: &str) -> browser::Choice {
    browser::Choice {
        id: id.into(),
        label: label.into(),
        pane_count: None,
        window_id: None,
        window_label: None,
    }
}
fn make_view(
    window: &mut Window,
    cx: &mut Context<SnapshotView>,
    sender: mpsc::SyncSender<browser::Command>,
) -> SnapshotView {
    let focus = cx.focus_handle();
    focus.focus(window, cx);
    let mut presence = Presence::new(true);
    presence.flush(&sender);
    presence.acknowledge(1);
    let frame = Arc::new(
        decode::frame(include_bytes!("../../../../../../fixtures/snapshot.json")).unwrap(),
    );
    SnapshotView {
        presence,
        _activation: None,
        _appearance: None,
        last_system: None,
        glass: Default::default(),
        last_workspace_session: None,
        frame: Some(frame.clone()),
        browsing: true,
        terminal_focus: focus,
        input_interrupted: false,
        picker: None,
        pane_actions: None,
        new_session: None,
        new_session_queued: None,
        window_reveal: Default::default(),
        resize_gesture: Default::default(),
        last_resize: None,
        marked: String::new(),
        marked_selection: None,
        input_geometry: Some((
            Bounds::new(point(px(0.), px(0.)), size(px(500.), px(500.))),
            Bounds::default(),
        )),
        input_cell_width: Some(10.),
        painted_frame: Some(frame.clone()),
        selection: None,
        divider: None,
        wheel: crate::terminal::WheelRemainder::default(),
        browser_request: 7,
        browser_state: browser::State {
            input_ready: true,
            sessions: vec![choice("session-a", "Session Alpha")],
            panes: vec![choice("pane-a", "Editor")],
            selected_pane: Some("pane-a".into()),
            frame: Some(frame),
            regions: serde_json::from_str(
                r#"[{"id":"pane-a","left":0,"top":0,"width":1,"height":1}]"#,
            )
            .unwrap(),
            ..Default::default()
        },
        browser_commands: Some(sender),
        _browser_task: None,
        _task: None,
        painter: Rc::new(RefCell::new(
            crate::terminal_painter::TerminalPainter::default(),
        )),
    }
}

#[test]
fn ranking_is_bounded_and_identity_based() {
    let state = browser::State {
        sessions: (0..100)
            .map(|i| choice(&format!("id-{i}"), "same label"))
            .collect(),
        ..Default::default()
    };
    assert_eq!(rows(&state, "").len(), 32);
    assert_eq!(
        rows(&state, "^Session")[0].target,
        Target::Session("id-0".into())
    );
    assert!(!current(&state, &Target::Pane("id-0".into())));
    assert!(rows(&state, "notpresent").is_empty());
}
#[gpui::test]
fn search_input_owns_typing_composition_and_selection_revalidates(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    cx.update(|window, cx| {
        view.update(cx, |view, cx| view.open_picker(window, cx));
        window.draw(cx).clear(cx);
    });
    cx.simulate_input("Editor");
    view.read_with(cx, |view, cx| {
        assert_eq!(
            view.picker.as_ref().unwrap().search.read(cx).text(),
            "Editor"
        )
    });
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            let search = view.picker.as_ref().unwrap().search.clone();
            search.update(cx, |input, cx| {
                input.replace_and_mark_text_in_range(None, "界", Some(1..1), window, cx)
            });
            for key in ["enter", "escape", "cmd-k"] {
                view.picker_key(
                    &KeyDownEvent {
                        keystroke: Keystroke::parse(key).unwrap(),
                        is_held: false,
                        prefer_character_input: false,
                    },
                    window,
                    cx,
                );
                assert!(view.picker.is_some());
            }
            view.replace_text_in_range(None, "must not reach terminal", window, cx);
            view.queue_input(
                crate::tmux_snapshot::keys::Input::Paste("blocked".into()),
                cx,
            );
            view.browser_state.panes.clear();
            view.choose_picker(Target::Pane("pane-a".into()), window, cx);
            assert_eq!(view.browser_request, 7);
            view.close_picker(window, cx);
            assert!(view.terminal_focus.is_focused(window));
        })
    });
    assert!(receiver.try_iter().all(|command| matches!(
        command,
        browser::Command::Presence { .. }
            | browser::Command::Input {
                input: crate::tmux_snapshot::keys::Input::Resize { .. },
                ..
            }
    )));
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.open_picker(window, cx);
            view.choose_picker(Target::Session("session-a".into()), window, cx);
            assert!(view.picker.is_none());
        })
    });
    assert!(
        matches!(receiver.try_recv().unwrap(),browser::Command::Session{id,..} if id=="session-a")
    );
}

#[gpui::test]
fn paste_escape_and_catalog_retirement_preserve_input_latch(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.input_interrupted = true;
            view.open_picker(window, cx);
        });
        cx.write_to_clipboard(ClipboardItem::new_string("Editor".into()));
        window.draw(cx).clear(cx);
    });
    cx.simulate_keystrokes("cmd-v");
    view.read_with(cx, |view, cx| {
        assert_eq!(
            view.picker.as_ref().unwrap().search.read(cx).text(),
            "Editor"
        )
    });
    cx.simulate_keystrokes("escape");
    view.read_with(cx, |view, _| {
        assert!(view.picker.is_none());
        assert!(view.input_interrupted);
    });
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.open_picker(window, cx);
            view.browser_request += 1;
            view.refresh_picker(cx);
            assert!(view.picker.is_none());
            view.open_picker(window, cx);
            view.browser_commands = None;
            view.refresh_picker(cx);
            assert!(view.picker.is_none());
            assert!(view.input_interrupted);
        })
    });
    assert!(receiver.try_iter().all(|command| !matches!(
        command,
        browser::Command::Input {
            input: crate::tmux_snapshot::keys::Input::Text(_)
                | crate::tmux_snapshot::keys::Input::Paste(_)
                | crate::tmux_snapshot::keys::Input::Key(_)
                | crate::tmux_snapshot::keys::Input::Bytes(_),
            ..
        }
    )));
}

#[gpui::test]
fn shortcut_opens_from_unselected_no_focus_and_after_selection_blur(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = make_view(window, cx, sender);
        window.blur(cx);
        view.frame = None;
        view.browser_state = browser::State {
            sessions: vec![choice("session-a", "Session Alpha")],
            ..Default::default()
        };
        view.presence = Presence::new(true);
        view
    });
    cx.update(|window, cx| {
        window.draw(cx).clear(cx);
    });
    cx.simulate_keystrokes("cmd-k");
    view.read_with(cx, |view, _| {
        assert!(
            view.picker.is_some(),
            "initial unfocused browser must receive CmdK"
        )
    });
    cx.simulate_input("Session");
    cx.simulate_keystrokes("enter");
    view.read_with(cx, |view, _| {
        assert!(view.picker.is_none());
        assert!(!view.browser_state.input_ready);
    });
    cx.update(|window, cx| {
        window.draw(cx).clear(cx);
    });
    cx.simulate_keystrokes("cmd-k");
    view.read_with(cx, |view, _| {
        assert!(
            view.picker.is_some(),
            "selection blur must retain browser shortcuts"
        )
    });
    cx.simulate_keystrokes("escape");
    cx.simulate_input("must not enter terminal");
    assert!(receiver.try_iter().all(|command| matches!(
        command,
        browser::Command::Presence { .. } | browser::Command::Session { .. }
    )));
}

#[gpui::test]
fn theme_picker_isolated_and_selection_waits_for_publication(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    while receiver.try_recv().is_ok() {}
    cx.update(|window,cx| {
        view.update(cx,|view,cx| {
            view.browser_state.appearance=Some(serde_json::from_value(serde_json::json!({
                "selected":"dark","system":"dark","error":null,
                "theme":{"canvas":1,"background":2,"foreground":3,"cursor":4,"surface":5,"active":6,"muted":7,"accent":8,"palette":vec![9;256]},
                "options":[{"id":"dark","name":"Dark"},{"id":"light","name":"Light"}]
            })).unwrap());
            view.open_theme_picker(window,cx);
        });
        window.draw(cx).clear(cx);
    });
    while receiver.try_recv().is_ok() {}
    cx.simulate_input("Light");
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            assert_eq!(
                view.picker.as_ref().unwrap().search.read(cx).text(),
                "Light"
            );
            let request = view.browser_request;
            let pane = view.browser_state.selected_pane.clone();
            view.choose_picker(Target::Theme("light".into()), window, cx);
            assert_eq!(view.browser_request, request);
            assert_eq!(view.browser_state.selected_pane, pane);
            assert_eq!(
                view.browser_state.appearance.as_ref().unwrap().selected,
                "dark"
            );
            let search = view.picker.as_ref().unwrap().search.clone();
            search.update(cx, |input, cx| {
                input.replace_and_mark_text_in_range(None, "界", None, window, cx)
            });
            view.picker_key(
                &KeyDownEvent {
                    keystroke: Keystroke::parse("enter").unwrap(),
                    is_held: false,
                    prefer_character_input: false,
                },
                window,
                cx,
            );
            assert!(view.picker.is_some());
            assert!(view.marked.is_empty());
        })
    });
    assert!(matches!(receiver.try_recv().unwrap(),browser::Command::Theme{id} if id=="light"));
    assert!(receiver.try_recv().is_err());
    cx.update(|_, cx| {
        view.update(cx, |view, cx| {
            let query = view
                .picker
                .as_ref()
                .unwrap()
                .search
                .read(cx)
                .text()
                .to_owned();
            let interrupted = view.input_interrupted;
            view.browser_state.appearance.as_mut().unwrap().selected = "light".into();
            view.refresh_picker(cx);
            assert_eq!(view.picker.as_ref().unwrap().search.read(cx).text(), query);
            assert_eq!(view.input_interrupted, interrupted);
            assert_eq!(view.theme().background, 2);
        })
    });
    drop(receiver);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.choose_picker(Target::Theme("dark".into()), window, cx);
            assert_eq!(
                view.picker.as_ref().unwrap().error,
                Some("Theme command queue unavailable — try again")
            );
            assert_eq!(
                view.browser_state.appearance.as_ref().unwrap().selected,
                "light"
            );
        })
    });
}

#[gpui::test]
fn system_notifications_are_change_only_and_do_not_select(cx: &mut TestAppContext) {
    use crate::tmux_snapshot::appearance::System;
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    while receiver.try_recv().is_ok() {}
    cx.update(|_, cx| {
        view.update(cx, |view, _| {
            let request = view.browser_request;
            view.publish_system(System::Dark);
            view.publish_system(System::Dark);
            view.publish_system(System::Light);
            view.publish_system(System::Light);
            assert_eq!(view.browser_request, request);
        })
    });
    assert!(matches!(
        receiver.try_recv().unwrap(),
        browser::Command::Appearance {
            system: System::Dark
        }
    ));
    assert!(matches!(
        receiver.try_recv().unwrap(),
        browser::Command::Appearance {
            system: System::Light
        }
    ));
    assert!(receiver.try_recv().is_err());
}
