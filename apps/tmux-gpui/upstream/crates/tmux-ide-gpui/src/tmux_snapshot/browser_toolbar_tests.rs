//! The pane header keeps its controls across a click and forwards older-revision clicks.
#![allow(clippy::unwrap_used)]
use super::*;
use core::prelude::v1::test;
use std::sync::mpsc;

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
            surface: browser::Surface::Workspace,
            input_ready: false,
            ..Default::default()
        },
    )
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
