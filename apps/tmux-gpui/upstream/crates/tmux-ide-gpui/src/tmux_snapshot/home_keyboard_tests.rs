#![allow(clippy::unwrap_used)]
use super::*;
use crate::tmux_snapshot::presence::Presence;
use core::prelude::v1::test;
use std::sync::mpsc;
fn choice(id: &str, label: &str) -> browser::Choice {
    browser::Choice {
        id: id.into(),
        label: label.into(),
        pane_count: None,
        window_id: None,
        browser_icon: None,
        window_label: None,
    }
}
fn make_view(
    window: &mut Window,
    cx: &mut Context<SnapshotView>,
    sender: mpsc::SyncSender<browser::Command>,
) -> SnapshotView {
    crate::tmux_snapshot::fit_test_support::fixture_view(
        window,
        cx,
        sender,
        7,
        browser::State {
            surface: browser::Surface::Home,
            home_phase: browser::HomePhase::Live,
            input_ready: true,
            sessions: vec![choice("session-a", "Session Alpha")],
            panes: vec![choice("pane-a", "Editor")],
            selected_session: Some("session-a".into()),
            ..Default::default()
        },
    )
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

#[path = "home_keyboard_tests/selection.rs"]
mod selection;

#[path = "home_keyboard_tests/recovery.rs"]
mod recovery;

#[path = "home_keyboard_tests/machine_filter.rs"]
mod machine_filter;

#[path = "home_keyboard_tests/action_focus.rs"]
mod action_focus;

#[path = "home_keyboard_tests/theme_readiness.rs"]
mod theme_readiness;
