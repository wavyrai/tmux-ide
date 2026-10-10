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

#[test]
fn phase_and_catalog_are_truthful_without_inventing_counts_or_targets() {
    let mut state = browser::State {
        surface: browser::Surface::Home,
        home_phase: browser::HomePhase::Loading,
        sessions: vec![choice("one", "same"), choice("two", "same")],
        ..Default::default()
    };
    assert_eq!(summary(&state, true), "Loading sessions…");
    assert!(!current(&state, true, 7, 7, "one"));
    state.home_phase = browser::HomePhase::Unavailable;
    assert_eq!(summary(&state, true), "Session catalog unavailable");
    assert!(!current(&state, true, 7, 7, "one"));
    state.home_phase = browser::HomePhase::Live;
    assert_eq!(summary(&state, true), "2 live sessions");
    assert!(current(&state, true, 7, 7, "two"));
    assert!(!current(&state, true, 7, 7, "same"));
    assert!(!current(&state, true, 8, 7, "two"));
    assert!(!current(&state, false, 7, 7, "two"));
    assert_eq!(summary(&state, false), "Session catalog unavailable");
    state.sessions.clear();
    assert_eq!(summary(&state, true), "No live sessions");
    assert!(!current(&state, true, 7, 7, "two"));
}

#[gpui::test]
fn home_dispatch_fences_request_surface_catalog_and_channel(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    receiver.try_iter().for_each(drop);
    cx.update(|window, cx| view.update(cx, |view, cx| {
        let frame = view.frame.clone().unwrap();
        view.home_select(6, "session-a", window, cx);
        view.home_select(7, "Session Alpha", window, cx);
        view.browser_state.surface = browser::Surface::Workspace;
        view.home_select(7, "session-a", window, cx);
        view.home_refresh(7, window, cx);
        view.browser_state.surface = browser::Surface::Home;
        view.browser_state.home_phase = browser::HomePhase::Unavailable;
        view.home_select(7, "session-a", window, cx);
        view.browser_state.home_phase = browser::HomePhase::Live;
        let sender = view.browser_commands.take();
        view.home_select(7, "session-a", window, cx);
        view.home_refresh(7, window, cx);
        view.browser_commands = sender;
        view.home_refresh(6, window, cx);
        assert_eq!(view.browser_request, 7);
        assert!(Arc::ptr_eq(view.frame.as_ref().unwrap(), &frame));
        assert!(view.browser_state.input_ready);
        assert!(receiver.try_recv().is_err());
        view.home_select(7, "session-a", window, cx);
        assert!(matches!(receiver.try_recv().unwrap(), browser::Command::Session { request: 8, id } if id == "session-a"));
        assert!(view.frame.is_none());
        assert!(!view.browser_state.input_ready);
        assert!(receiver.try_recv().is_err());
    }));
}

#[path = "tests/render.rs"]
mod render;
