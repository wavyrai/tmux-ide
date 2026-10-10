#![allow(clippy::unwrap_used)]
use super::*;
use crate::tmux_snapshot::{browser, decode};
use core::prelude::v1::test;
use std::{
    cell::RefCell,
    rc::Rc,
    sync::{Arc, mpsc},
};

#[gpui::test]
fn composition_commits_once_and_rejects_retired_input(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(32);
    let (view, cx) = cx.add_window_view(|window, cx| {
        let focus = cx.focus_handle();
        focus.focus(window, cx);
        let mut presence = crate::tmux_snapshot::presence::Presence::new(true);
        presence.flush(&sender);
        presence.acknowledge(1);
        SnapshotView {
            presence,
            _activation: None,
            _appearance: None,
            last_system: None,
            glass: Default::default(),
            last_workspace_session: None,
            frame: Some(Arc::new(
                decode::frame(include_bytes!("../../../../../fixtures/snapshot.json")).unwrap(),
            )),
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
            input_geometry: None,
            input_cell_width: None,
            painted_frame: None,
            selection: None,
            divider: None,
            wheel: crate::terminal::WheelRemainder::default(),
            browser_request: 7,
            browser_state: browser::State {
                input_ready: true,
                selected_pane: Some("pane-a".into()),
                ..Default::default()
            },
            browser_commands: Some(sender),
            _browser_task: None,
            _task: None,
            painter: Rc::new(RefCell::new(
                crate::terminal_painter::TerminalPainter::default(),
            )),
        }
    });
    while let Ok(command) = receiver.try_recv() {
        assert!(matches!(
            command,
            browser::Command::Input {
                input: Input::Resize { .. },
                ..
            } | browser::Command::Presence { .. }
        ));
    }
    cx.update(|window, cx| view.update(cx, |view, cx| {
        view.replace_and_mark_text_in_range(None, "界🌍", Some(1..3), window, cx);
        assert!(receiver.try_recv().is_err());
        assert_eq!(view.marked_text_range(window, cx), Some(0..3));
        assert_eq!(view.selected_text_range(false, window, cx).unwrap().range, 1..3);
        assert_eq!(view.text_for_range(1..3, &mut None, window, cx), Some("🌍".into()));
        view.replace_text_in_range(None, "界🌍", window, cx);
        let command = receiver.try_recv().unwrap();
        assert!(matches!(command, browser::Command::Input { request:7, input: Input::Text(ref t), .. } if t == "界🌍"));
        assert!(receiver.try_recv().is_err());
        assert!(view.marked.is_empty());
        view.replace_and_mark_text_in_range(None, "a🌍c", None, window, cx);
        view.replace_and_mark_text_in_range(Some(1..3), "界", Some(0..1), window, cx);
        assert_eq!(view.marked, "a界c");
        assert_eq!(view.marked_selection, Some(1..2));
        assert!(receiver.try_recv().is_err());
        view.replace_text_in_range(Some(1..2), "X", window, cx);
        assert!(matches!(receiver.try_recv().unwrap(), browser::Command::Input { input: Input::Text(ref t), .. } if t == "aXc"));
        view.replace_and_mark_text_in_range(None, "a🌍c", None, window, cx);
        view.replace_text_in_range(Some(1..2), "X", window, cx);
        assert!(receiver.try_recv().is_err(), "split surrogate must not send text");
        view.replace_and_mark_text_in_range(None, "old", None, window, cx);
        view.browser_state.input_ready = false;
        view.discard_composition(cx);
        view.replace_text_in_range(None, "late", window, cx);
        assert!(receiver.try_recv().is_err());
    }));
}

#[test]
fn replacement_bounds_apply_to_the_complete_composition() {
    assert_eq!(replacement("abc", Some(1..2), ""), Some(("ac".into(), 1)));
    assert!(replacement("a🌍c", Some(2..3), "x").is_none());
    assert!(replacement("abc", Some(4..4), "x").is_none());
    assert!(replacement("abc", Some(Range { start: 2, end: 1 }), "x").is_none());
    assert!(replacement("abc", None, "\0").is_none());
    let full = "x".repeat(1024);
    assert!(replacement(&full, Some(0..0), "x").is_none());
    assert!(replacement(&full, Some(0..1), "界").is_some());
}
