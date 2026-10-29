//! The pane header keeps its controls across a click and forwards older-revision clicks.
#![allow(clippy::unwrap_used)]
use super::*;
use crate::tmux_snapshot::{decode, presence::Presence};
use core::prelude::v1::test;
use std::{cell::RefCell, rc::Rc, sync::Arc, sync::mpsc};

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
        graphics: Default::default(),
        presence,
        _activation: None,
        _appearance: None,
        last_system: None,
        glass: Default::default(),
        last_workspace_session: None,
        pending_session_open: None,
        header_controls: Default::default(),
        frame: Some(crate::tmux_snapshot::display_frame::DisplayFrame::Legacy(
            frame.clone(),
        )),
        browsing: true,
        terminal_focus: focus,
        input_interrupted: false,
        pending_input: None,
        picker: None,
        attention: Default::default(),
        palette: Default::default(),
        session_history: Default::default(),
        session_tabs: Default::default(),
        workspace_fleet_agents: Default::default(),
        home_filter: None,
        pane_actions: None,
        browser_address: None,
        new_session: None,
        new_session_queued: None,
        agent_animation: Default::default(),
        sidebar_hidden: false,
        sidebar_keyboard: Default::default(),
        developer_mode: Default::default(),
        terminal_font: Default::default(),
        window_reveal: Default::default(),
        resize_gesture: Default::default(),
        last_resize: None,
        fit_settle: Default::default(),
        marked: String::new(),
        marked_selection: None,
        input_geometry: Some((
            Bounds::new(point(px(0.), px(0.)), size(px(500.), px(500.))),
            Bounds::default(),
        )),
        input_cell_width: Some(10.),
        painted_focus: None,
        painted_frame: Some(crate::tmux_snapshot::display_frame::DisplayFrame::Legacy(
            frame.clone(),
        )),
        pointer: Default::default(),
        selection: None,
        divider: None,
        wheel: crate::terminal::WheelRemainder::default(),
        browser_request: 7,
        browser_state: browser::State {
            surface: browser::Surface::Workspace,
            input_ready: false,
            selected_pane: Some("pane-a".into()),
            frame: Some(crate::tmux_snapshot::display_frame::DisplayFrame::Legacy(
                frame,
            )),
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
fn observed(revision: u64) -> BrowserState {
    BrowserState {
        version: 1,
        instance: "12345678-1234-4234-8234-123456789abc".into(),
        pane: "%1".into(),
        tab: 1,
        revision,
        enabled: true,
        url: "https://example.com".into(),
        title: format!("Example {revision}"),
        loading: false,
        can_go_back: true,
        can_go_forward: false,
    }
}
fn ready(view: &mut SnapshotView, state: BrowserState) {
    view.browser_state.request = view.browser_request;
    view.browser_state.input_ready = true;
    view.browser_state.panes = vec![browser::Choice {
        id: "pane-a".into(),
        label: "pane-a".into(),
        pane_count: None,
        window_id: Some("window-a".into()),
        window_label: None,
        browser_icon: None,
    }];
    view.browser_state
        .browser_controls
        .insert("pane-a".into(), state);
}
fn sent(receiver: &mpsc::Receiver<browser::Command>) -> Vec<(BrowserAction, u64)> {
    receiver
        .try_iter()
        .filter_map(|command| match command {
            browser::Command::BrowserControls {
                command: Some(command),
                ..
            } => Some((command.action, command.revision)),
            _ => None,
        })
        .collect()
}
#[gpui::test]
fn clicking_back_keeps_the_toolbar_until_the_next_read(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(32);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    receiver.try_iter().for_each(drop);
    cx.update(|_, cx| {
        view.update(cx, |view, cx| {
            ready(view, observed(7));
            let back = BrowserCommand::new(&observed(7), BrowserAction::Back, None);
            view.send_browser("pane-a", back.clone(), cx);
            assert!(sent(&receiver) == [(BrowserAction::Back, 7)]);
            // The header keeps the observed URL and history instead of collapsing to a title.
            assert!(view.browser_state.browser_controls.contains_key("pane-a"));
            assert!(view.browser_header("pane-a", cx).is_some());
        })
    });
}
#[gpui::test]
fn a_click_on_an_older_revision_is_forwarded_not_dropped(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(32);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    receiver.try_iter().for_each(drop);
    cx.update(|_, cx| {
        view.update(cx, |view, cx| {
            // The button was painted at revision 7; a title update arrived before the click.
            ready(view, observed(8));
            let reload = BrowserCommand::new(&observed(7), BrowserAction::Reload, None);
            view.send_browser("pane-a", reload, cx);
            assert!(sent(&receiver) == [(BrowserAction::Reload, 7)]);
        })
    });
}
#[path = "browser_toolbar_pending_tests.rs"]
mod pending;
