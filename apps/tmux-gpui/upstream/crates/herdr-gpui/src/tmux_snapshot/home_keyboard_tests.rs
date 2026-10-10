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
    let frame =
        Arc::new(decode::frame(include_bytes!("../../../../../fixtures/snapshot.json")).unwrap());
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
            surface: browser::Surface::Home,
            home_phase: browser::HomePhase::Live,
            input_ready: true,
            sessions: vec![choice("session-a", "Session Alpha")],
            panes: vec![choice("pane-a", "Editor")],
            selected_session: Some("session-a".into()),
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

#[gpui::test]
fn home_without_terminal_surface_owns_shortcuts_and_picker_text(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = make_view(window, cx, sender);
        view.frame = None;
        view.painted_frame = None;
        view.browser_state.input_ready = false;
        view.browser_state.selected_session = None;
        view.browser_state.selected_pane = None;
        view.browser_state.frame = None;
        view.browser_state.panes.clear();
        view.browser_state.regions.clear();
        view.browser_state.copy_region = None;
        view.input_interrupted = true;
        window.blur(cx);
        view
    });
    receiver.try_iter().for_each(drop);
    cx.update(|window, cx| {
        window.draw(cx).clear(cx);
    });
    cx.simulate_keystrokes("cmd-k");
    view.read_with(cx, |view, _| {
        assert!(
            view.picker.is_some(),
            "Home must own CmdK dispatch without a terminal subtree"
        )
    });
    cx.simulate_input("Session");
    assert!(
        receiver.try_recv().is_err(),
        "picker text must not dispatch terminal input"
    );
    cx.simulate_keystrokes("escape");
    view.read_with(cx, |view, _| {
        assert!(view.picker.is_none());
        assert!(view.input_interrupted);
        assert_eq!(view.browser_state.surface, browser::Surface::Home);
    });
    cx.simulate_keystrokes("cmd-k");
    cx.simulate_input("Session");
    cx.simulate_keystrokes("enter");
    assert!(
        matches!(receiver.try_recv().unwrap(), browser::Command::Session {request:8,id} if id == "session-a")
    );
    assert!(receiver.try_recv().is_err());
    view.read_with(cx, |view, _| {
        assert!(view.input_interrupted);
        assert!(!view.browser_state.input_ready);
    });
}
