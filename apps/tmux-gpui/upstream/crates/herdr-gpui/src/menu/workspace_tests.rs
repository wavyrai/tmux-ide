#![allow(clippy::unwrap_used)]

use super::{WorkspaceAction, WorkspaceMenuAction, WorkspaceTarget, state::Deletion};
use crate::{HerdrWindow, dialog_input::DialogInput, sidebar, worktree_scripts::ArchiveCheck};
use herdr_client::Method;

mod close;
mod dialog_layout;
mod dispatch;
mod naming;
mod pull_requests;
mod scripts;
mod targets;
mod tiles;
mod worktree_create;
mod worktree_delete;

/// Presses the open workspace dialog's submit, for `endpoint::lifecycle_tests`.
#[cfg(unix)]
pub(crate) fn submit_dialog(
    view: &mut HerdrWindow,
    window: &mut gpui::Window,
    cx: &mut gpui::Context<HerdrWindow>,
) {
    view.submit_workspace_dialog(window, cx);
}

/// Whether the open workspace menu offers a note, for tests outside this module.
pub(crate) fn offers_note(view: &HerdrWindow) -> bool {
    view.workspace_items()
        .iter()
        .any(|(action, _)| *action == WorkspaceMenuAction::Dialog(WorkspaceAction::Note))
}

/// The workspace a menu currently targets, for tests outside this module.
pub(crate) fn target_id(view: &HerdrWindow) -> Option<&str> {
    view.menu.target.as_ref().map(|target| target.id.as_str())
}

// Drives the workspace menu for `endpoint::lifecycle_tests`, which needs POSIX
// sockets and processes and is therefore compiled there only.
#[cfg(unix)]
pub(crate) fn submit_focus_change(
    view: &mut HerdrWindow,
    method: Method,
    window: &mut gpui::Window,
    cx: &mut gpui::Context<HerdrWindow>,
) {
    let action = match method {
        Method::WorkspaceClose => WorkspaceAction::Close,
        Method::WorktreeCreate => WorkspaceAction::NewWorktree,
        Method::WorktreeOpen => WorkspaceAction::OpenWorktree,
        Method::WorktreeRemove => WorkspaceAction::DeleteWorktree,
        _ => panic!("unexpected fixture action"),
    };
    let snapshot = std::sync::Arc::make_mut(view.live.snapshot.as_mut().unwrap());
    snapshot.workspaces = sidebar::layout_tests::snapshot(7).workspaces;
    let index = if action == WorkspaceAction::DeleteWorktree {
        4
    } else {
        3
    };
    let target = WorkspaceTarget::new(snapshot, &snapshot.workspaces[index]);
    let close_check = (action == WorkspaceAction::Close).then(|| {
        super::workspace_close::CloseCheck::fixture(
            snapshot,
            &target,
            Some(super::workspace_close::Report {
                dirty: true,
                unpushed: true,
                unknown: false,
            }),
        )
    });
    view.open_menu(window, cx);
    view.menu.target = Some(target);
    view.menu.page = Some(super::Page::Dialog(action));
    if let Some(check) = close_check {
        view.menu.close_check = Some(check);
        view.menu.input = Some(DialogInput::new("close".into()));
    }
    if action == WorkspaceAction::DeleteWorktree {
        view.menu.deletion = Some(Deletion {
            path: Some("/fixture/checkout".into()),
            archive: ArchiveCheck::Read(None),
            ..Deletion::new(None, false)
        });
    }
    if action == WorkspaceAction::OpenWorktree {
        use gpui::AppContext;
        let mut picker =
            super::worktree_open::Picker::new(cx.new(crate::search_input::SearchInput::new));
        picker.pending = Some("list".into());
        view.menu.worktree_open = Some(picker);
        view.menu.apply_worktree_list_response("list", Ok(serde_json::json!({"result": {
            "type": "worktree_list", "source": {"repo_key":"/fixture/agent-launcher/.git", "repo_name":"agent-launcher", "source_workspace_id":"w3"},
            "worktrees": [{"path": "/endpoint/existing checkout ",
                "label": "existing", "is_bare": false, "is_prunable": false, "is_detached": true}]
        }})));
    }
    view.submit_workspace_dialog(window, cx);
    assert!(view.menu.error.is_none() && view.local_error.is_none());
    // A creation waits for its correlated response in the open dialog; a
    // removal is queued and its dialog closes, leaving the id on the window.
    let pending = match action {
        WorkspaceAction::DeleteWorktree => {
            assert!(view.menu.page.is_none());
            view.removal.as_ref().unwrap().pending.clone()
        }
        WorkspaceAction::NewWorktree | WorkspaceAction::OpenWorktree => view.menu.creation.clone(),
        _ => None,
    };
    if pending.is_some() {
        let inbox = view.endpoints[view.selected_endpoint]
            .connection
            .inbox
            .lock()
            .unwrap();
        assert_eq!(
            inbox.dialog_response.as_ref().map(|(id, _)| id),
            pending.as_ref()
        );
    }
    view.dismiss_menu(window, cx);
}

pub(crate) fn check_pr_fences(view: &gpui::Entity<HerdrWindow>, cx: &mut gpui::VisualTestContext) {
    use std::sync::{Arc, Mutex};
    cx.update(|_, cx| {
        view.update(cx, |view, _| {
            view.menu.github = crate::github::Auth::connected_fixture();
            let snapshot = view.live.snapshot.clone();
            let inbox = view.endpoints[view.selected_endpoint]
                .connection
                .inbox
                .clone();
            let status = view.live.status;
            let target_id = view.menu.target.as_ref().unwrap().id.clone();
            for change in 0..5 {
                view.live.snapshot = snapshot.clone();
                view.live.status = status;
                view.endpoints[view.selected_endpoint].connection.inbox = inbox.clone();
                view.menu.pr_connection = Some(Arc::downgrade(&inbox));
                view.menu.pr.value = Some(crate::pull_request::fixture().unwrap());
                view.menu.pr.message = None;
                let snapshot = Arc::make_mut(view.live.snapshot.as_mut().unwrap());
                match change {
                    0 => snapshot.boot_id = "restarted".into(),
                    1 => snapshot
                        .workspaces
                        .retain(|workspace| workspace.workspace_id != target_id),
                    2 => {
                        snapshot
                            .workspaces
                            .iter_mut()
                            .find(|workspace| workspace.workspace_id == target_id)
                            .unwrap()
                            .branch = Some("other".into())
                    }
                    3 => {
                        view.endpoints[view.selected_endpoint].connection.inbox =
                            Arc::new(Mutex::new(Default::default()))
                    }
                    _ => view.live.status = crate::state::ConnectionStatus::Detached,
                }
                assert!(view.update_workspace_pr());
                assert!(view.menu.pr.value.is_none());
            }
            view.live.snapshot = snapshot;
            view.live.status = status;
            view.endpoints[view.selected_endpoint].connection.inbox = inbox;
            view.menu.pr_connection = None;
            view.menu.pr.clear();
            let connection_target = view.endpoints[view.selected_endpoint]
                .connection
                .target
                .clone();
            let local_peer = view.live.local_daemon_peer;
            for target in [
                herdr_client::ConnectTarget::Local,
                herdr_client::ConnectTarget::Socket("/local-or-forwarded.sock".into()),
            ] {
                view.endpoints[view.selected_endpoint].connection.target = target;
                view.live.local_daemon_peer = false;
                view.refresh_workspace_pr();
                assert!(
                    view.menu
                        .pr
                        .message
                        .as_deref()
                        .unwrap()
                        .contains("requires your owned local session socket")
                );
                view.live.local_daemon_peer = true;
                view.refresh_workspace_pr();
                // Menu open is cache-only; the worker resolves the checkout from Git.
                assert!(view.menu.pr.loading);
                assert!(view.menu.pr.message.is_none());
            }
            view.refresh_workspace_pr();
            assert!(
                view.menu.pr.loading,
                "local daemon uses Git registry worker"
            );
            assert!(
                view.live.dialog_response.is_none(),
                "no daemon request or dialog slot registration"
            );
            assert!(
                view.menu.pr_connection.is_some(),
                "fallback keeps reconnect fence"
            );
            view.endpoints[view.selected_endpoint].connection.target = connection_target;
            view.live.local_daemon_peer = local_peer;
            view.menu.pr.clear();
        })
    });
}

pub(crate) fn check_menu_interactions(
    view: &gpui::Entity<HerdrWindow>,
    cx: &mut gpui::VisualTestContext,
) {
    use gpui::{Modifiers, point, px};
    let selection = |view: &HerdrWindow| {
        if view.menu.page == Some(super::Page::Workspace) {
            view.menu.workspace_selected.and_then(|selected| {
                view.workspace_menu_actions()
                    .iter()
                    .position(|action| *action == selected)
            })
        } else {
            view.menu.selected
        }
    };
    let (page, count, first, second) = cx.update(|_, cx| {
        let view = view.read(cx);
        assert_eq!(view.menu.selected, None);
        if view.menu.page == Some(super::Page::Workspace) {
            // The first two actions in keyboard order, whichever tiles they are.
            let items = view.workspace_items();
            (
                super::Page::Workspace,
                items.len(),
                // Debug selectors are static; leaking two test labels is fine.
                &*format!("workspace-menu-{}", items[0].1).leak(),
                &*format!("workspace-menu-{}", items[1].1).leak(),
            )
        } else {
            (
                super::Page::Menu,
                view.menu_items().len(),
                "menu-settings",
                "menu-shortcuts",
            )
        }
    });
    cx.simulate_keystrokes("enter");
    cx.update(|_, cx| {
        assert!(view.read(cx).menu.page == Some(page));
        assert_eq!(view.read(cx).menu.selected, None);
        assert!(view.read(cx).menu.input.is_none());
    });
    let first = cx.debug_bounds(first).unwrap().center();
    let second = cx.debug_bounds(second).unwrap().center();
    let outside = point(px(790.), px(590.));
    for (position, selected) in [(second, Some(1)), (first, Some(0)), (outside, None)] {
        cx.simulate_mouse_move(position, None, Modifiers::default());
        cx.update(|window, cx| {
            window.draw(cx).clear(cx);
            assert_eq!(selection(view.read(cx)), selected);
        });
    }
    // Leaving the hovered row also leaves Enter inert.
    cx.simulate_keystrokes("enter");
    cx.update(|_, cx| assert!(view.read(cx).menu.page == Some(page)));
    for (keys, selected) in [
        ("up", count - 1),
        ("down", 0),
        ("up", count - 1),
        ("down down", 1),
    ] {
        cx.simulate_keystrokes(keys);
        cx.update(|window, cx| {
            window.draw(cx).clear(cx);
            assert_eq!(selection(view.read(cx)), Some(selected));
        });
    }
    cx.simulate_mouse_move(first, None, Modifiers::default());
    cx.update(|window, cx| {
        window.draw(cx).clear(cx);
        assert_eq!(selection(view.read(cx)), Some(0));
    });
    // Keyboard selection replaces hover even while the pointer stays on the first row.
    cx.simulate_keystrokes("down");
    cx.update(|window, cx| {
        window.draw(cx).clear(cx);
        assert_eq!(selection(view.read(cx)), Some(1));
    });
    cx.simulate_mouse_move(second, None, Modifiers::default());
    cx.update(|window, cx| {
        window.draw(cx).clear(cx);
        assert_eq!(selection(view.read(cx)), Some(1));
    });
    cx.simulate_mouse_move(outside, None, Modifiers::default());
    cx.update(|window, cx| {
        window.draw(cx).clear(cx);
        assert_eq!(selection(view.read(cx)), None);
    });
    cx.simulate_keystrokes("down");
    cx.update(|_, cx| assert_eq!(selection(view.read(cx)), Some(0)));
    cx.simulate_mouse_move(second, None, Modifiers::default());
    cx.update(|window, cx| {
        window.draw(cx).clear(cx);
        assert_eq!(selection(view.read(cx)), Some(1));
    });
    let second_action = cx.update(|_, cx| {
        let view = view.read(cx);
        (page == super::Page::Workspace).then(|| view.workspace_items()[1].0)
    });
    cx.simulate_keystrokes("enter");
    cx.update(|_, cx| {
        let opened = view.read(cx).menu.page;
        match second_action {
            Some(WorkspaceMenuAction::Dialog(action)) => {
                assert!(opened == Some(super::Page::Dialog(action)))
            }
            Some(_) => assert!(opened != Some(page), "the second action did not run"),
            None => assert!(opened == Some(super::Page::Keybinds)),
        }
    });
    cx.simulate_mouse_move(outside, None, Modifiers::default());
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            let anchor = view.menu.anchor;
            let target = view.menu.target.as_ref().map(|target| target.id.clone());
            view.dismiss_menu(window, cx);
            if let Some(target) = target {
                view.open_workspace_menu(&target, anchor, window, cx);
            } else {
                view.open_menu(window, cx);
            }
            assert_eq!(view.menu.selected, None);
        });
        window.draw(cx).clear(cx);
    });
}
