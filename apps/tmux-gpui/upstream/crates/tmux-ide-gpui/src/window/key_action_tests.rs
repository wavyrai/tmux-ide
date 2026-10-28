//! Daemon key actions the window runs itself: renames and workspace closing
//! open the dialogs their menus open, and resize mode claims keys until it
//! ends.

#![allow(clippy::unwrap_used)]

use super::HerdrWindow;
use crate::{
    controls::Command,
    menu::{Page, WorkspaceAction},
    sidebar::layout_tests::fixture_window,
    state::ConnectionStatus,
};
use gpui::{Keystroke, TestAppContext, VisualTestContext};
use herdr_client::protocol::ClientShellSnapshot;
use std::sync::Arc;

fn connected(window: &mut gpui::Window, cx: &mut gpui::Context<HerdrWindow>) -> HerdrWindow {
    let mut view = fixture_window(window, cx);
    let snapshot: ClientShellSnapshot = serde_json::from_str(include_str!(
        "../../../herdr-protocol/tests/fixtures/endpoint-snapshot-v1.json"
    ))
    .unwrap();
    view.live.snapshot = Some(Arc::new(snapshot));
    view.live.status = ConnectionStatus::Connected;
    view
}

fn run(view: &gpui::Entity<HerdrWindow>, command: Command, cx: &mut VisualTestContext) {
    cx.update(|window, cx| view.update(cx, |view, cx| view.command(command, window, cx)));
}

fn dismiss(view: &gpui::Entity<HerdrWindow>, cx: &mut VisualTestContext) {
    cx.update(|window, cx| view.update(cx, |view, cx| view.dismiss_menu(window, cx)));
}

#[gpui::test]
fn renames_and_close_open_the_focused_targets_dialogs(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(connected);
    run(&view, Command::RenameTab, cx);
    view.read_with(cx, |view, _| {
        assert_eq!(view.menu.page, Some(Page::RenameTab));
    });
    dismiss(&view, cx);

    run(&view, Command::RenamePane, cx);
    view.read_with(cx, |view, _| {
        assert_eq!(view.menu.page, Some(Page::RenamePane));
    });
    dismiss(&view, cx);

    for (command, action) in [
        (Command::RenameWorkspace, WorkspaceAction::Rename),
        (Command::CloseWorkspace, WorkspaceAction::Close),
    ] {
        run(&view, command, cx);
        view.read_with(cx, |view, _| {
            assert_eq!(view.menu.page, Some(Page::Dialog(action)), "{command:?}");
        });
        dismiss(&view, cx);
    }

    // Nothing focused, nothing to open.
    cx.update(|_, cx| {
        view.update(cx, |view, _| {
            let snapshot = Arc::make_mut(view.live.snapshot.as_mut().unwrap());
            snapshot.focused_workspace_id = None;
            snapshot.focused_tab_id = None;
            snapshot.focused_pane_id = None;
        })
    });
    for command in [
        Command::RenameTab,
        Command::RenamePane,
        Command::RenameWorkspace,
        Command::CloseWorkspace,
    ] {
        run(&view, command, cx);
        view.read_with(cx, |view, _| {
            assert_eq!(view.menu.page, None, "{command:?}")
        });
    }
}

#[gpui::test]
fn resize_mode_claims_keys_until_it_ends(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(connected);
    let press = |key: &str, cx: &mut VisualTestContext| {
        cx.update(|window, cx| window.dispatch_keystroke(Keystroke::parse(key).unwrap(), cx))
    };
    cx.update(|window, cx| {
        window.focus(&view.read(cx).focus.clone(), cx);
        window.draw(cx).clear(cx);
    });
    let resizing = |cx: &mut VisualTestContext| view.read_with(cx, |view, _| view.resize_mode);

    // Herdr's default chord enters it, and every key but cmd ones is claimed.
    assert!(press("ctrl-b", cx));
    assert!(press("r", cx));
    assert!(resizing(cx));
    for key in ["h", "down", "x", "shift-q"] {
        assert!(press(key, cx), "{key}");
        assert!(resizing(cx), "{key}");
    }
    assert!(!press("cmd-y", cx), "platform keys pass through");
    for end in ["escape", "enter", "r"] {
        assert!(press(end, cx), "{end}");
        assert!(!resizing(cx), "{end}");
        run(&view, Command::ResizeMode, cx);
        assert!(resizing(cx));
    }
    // A menu takes keys of its own, so opening one ends the mode.
    cx.update(|window, cx| view.update(cx, |view, cx| view.open_keybinds(window, cx)));
    press("h", cx);
    assert!(!resizing(cx));
    dismiss(&view, cx);
    // As does leaving the window.
    run(&view, Command::ResizeMode, cx);
    view.update(cx, |view, _| view.disarm_prefix());
    assert!(!resizing(cx));
}
