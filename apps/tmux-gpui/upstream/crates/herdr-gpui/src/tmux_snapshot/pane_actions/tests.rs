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
        pending_session_open: None,
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
            request: 7,
            surface: browser::Surface::Workspace,
            selected_session: Some("session-a".into()),
            pane_actions: Some(browser::PaneActions {
                token: "312b2c16-a13d-4411-82e5-1fdb58adab92".into(),
                id: "pane-a".into(),
                zoomed: false,
            }),
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
fn bounded_titles_and_exact_zoom_wire() {
    assert_eq!(name("  窓 title  ").as_deref(), Some("窓 title"));
    for invalid in ["".to_owned(), " ".into(), "x\ny".into(), "界".repeat(81)] {
        assert!(name(&invalid).is_none());
    }
    assert!(name(&"界".repeat(80)).is_some());
    assert!(name(&"😀".repeat(40)).is_some());
    assert!(name(&"😀".repeat(41)).is_none());
    let command = browser::Command::PaneAction {
        request: 7,
        id: "pane-a".into(),
        token: "token".into(),
        action: Action::Zoom {
            desired: Zoom::Unzoomed,
        },
    };
    assert_eq!(
        serde_json::to_value(command).unwrap(),
        serde_json::json!({"type":"pane-action","request":7,"id":"pane-a","token":"token","action":"zoom","desired":"unzoomed"})
    );
}
#[gpui::test]
fn captured_target_zoom_is_absolute_once_and_never_rearms_input(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    receiver.try_iter().for_each(drop);
    cx.update(|window,cx|view.update(cx,|view,cx|{
        view.input_interrupted=true;
        view.browser_state.pane_actions.as_mut().unwrap().zoomed=true;
        view.open_pane_actions(window,cx);
        view.send_pane_action(false,window,cx);
        assert!(matches!(receiver.try_recv().unwrap(),browser::Command::PaneAction{request:7,id,action:Action::Zoom{desired:Zoom::Unzoomed},..} if id=="pane-a"));
        view.send_pane_action(false,window,cx);
        view.open_pane_actions(window,cx);
        assert!(receiver.try_recv().is_err());
        assert!(view.pane_actions.is_none());assert!(view.input_interrupted);
    }));
}
#[gpui::test]
fn stale_capability_or_availability_dismisses_without_sending(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    receiver.try_iter().for_each(drop);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            let original = view.browser_state.clone();
            for case in 0..5 {
                view.browser_state = original.clone();
                view.browser_request = 7;
                view.open_pane_actions(window, cx);
                assert!(view.pane_actions.is_some());
                match case {
                    0 => view.browser_request = 8,
                    1 => view.browser_state.selected_session = Some("other".into()),
                    2 => {
                        view.browser_state.pane_actions.as_mut().unwrap().token =
                            "replacement".into()
                    }
                    3 => view.browser_state.pane_actions.as_mut().unwrap().zoomed = true,
                    _ => view.browser_state.input_ready = false,
                }
                view.send_pane_action(false, window, cx);
                assert!(view.pane_actions.is_none());
                assert!(receiver.try_recv().is_err());
            }
        })
    });
}
#[gpui::test]
fn rename_uses_real_search_input_and_ime_never_submits_or_leaks(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    receiver.try_iter().for_each(drop);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.input_interrupted = true;
            view.open_pane_actions(window, cx);
            view.edit_pane_name(window, cx);
        });
        window.draw(cx).clear(cx);
    });
    cx.simulate_input("New name");
    assert!(receiver.try_recv().is_err());
    cx.update(|window,cx|view.update(cx,|view,cx|{
        let input=view.pane_actions.as_ref().unwrap().input.clone().unwrap();
        input.update(cx,|input,cx|input.replace_and_mark_text_in_range(None,"界",None,window,cx));
        for key in ["enter","escape"] {
            view.pane_actions_key(&KeyDownEvent{keystroke:Keystroke::parse(key).unwrap(),is_held:false,prefer_character_input:false},window,cx);
            assert!(view.pane_actions.is_some());assert!(receiver.try_recv().is_err());
        }
        view.replace_text_in_range(None,"must not enter terminal",window,cx);
        view.queue_input(super::super::keys::Input::Paste("must not paste".into()),cx);
        assert!(receiver.try_recv().is_err());
        input.update(cx,|input,cx|{input.unmark_text(window,cx);input.set_text_selected("  New name  ",cx);});
        view.send_pane_action(true,window,cx);
        assert!(matches!(receiver.try_recv().unwrap(),browser::Command::PaneAction{action:Action::Rename{name},..} if name=="New name"));
        assert!(receiver.try_recv().is_err());assert!(view.input_interrupted);
    }));
}

#[gpui::test]
fn opening_menu_and_editor_does_not_resize_terminal_canvas(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    cx.simulate_resize(size(px(640.), px(400.)));
    cx.update(|window, cx| {
        window.draw(cx).clear(cx);
    });
    receiver.try_iter().for_each(drop);
    let before = view.read_with(cx, |view, _| view.input_geometry.unwrap().0);
    for editor in [false, true] {
        cx.update(|window, cx| {
            view.update(cx, |view, cx| {
                if editor {
                    view.edit_pane_name(window, cx)
                } else {
                    view.open_pane_actions(window, cx)
                }
            });
            window.draw(cx).clear(cx);
        });
        let after = view.read_with(cx, |view, _| view.input_geometry.unwrap().0);
        assert_eq!(
            before, after,
            "menu must overlay, never change daemon geometry"
        );
        assert!(receiver.try_recv().is_err());
        assert!(view.read_with(cx, |view, _| view.pane_actions.is_some()));
    }
}

mod split;
