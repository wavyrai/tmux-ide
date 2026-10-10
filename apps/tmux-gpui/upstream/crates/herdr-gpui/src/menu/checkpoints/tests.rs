#![allow(clippy::unwrap_used)]

use crate::HerdrWindow;

mod timeline;

/// The fixture's w4 (a linked worktree on `worktree/sidebar-child`) on
/// this machine's own daemon.
pub(super) fn local(view: &mut HerdrWindow) {
    view.live.status = crate::state::ConnectionStatus::Connected;
    view.live.local_daemon_peer = true;
    view.endpoints[0].connection.target = herdr_client::ConnectTarget::Local;
    let snapshot = std::sync::Arc::make_mut(view.live.snapshot.as_mut().unwrap());
    snapshot.workspaces = crate::sidebar::layout_tests::snapshot(7).workspaces;
    for workspace in &mut snapshot.workspaces {
        if let Some(tree) = &mut workspace.worktree {
            tree.key = "/repo/.git".into();
        }
    }
}

fn offered(view: &HerdrWindow) -> bool {
    view.workspace_items()
        .iter()
        .any(|(action, _)| *action == super::super::WorkspaceMenuAction::Checkpoints)
}

#[gpui::test]
fn checkpoints_are_offered_only_where_git_may_run(cx: &mut gpui::TestAppContext) {
    let scriptable = cfg!(any(target_os = "linux", target_os = "macos"));
    let (view, cx) = cx.add_window_view(crate::sidebar::layout_tests::fixture_window);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            local(view);
            view.open_workspace_menu("w4", Default::default(), window, cx);
            assert_eq!(offered(view), scriptable);
            view.dismiss_menu(window, cx);
            // A workspace with no checkout has nothing to snapshot.
            view.open_workspace_menu("w0", Default::default(), window, cx);
            assert!(!offered(view));
            view.dismiss_menu(window, cx);
            // Another user's daemon may name any path; Git never runs there.
            view.live.local_daemon_peer = false;
            view.open_workspace_menu("w4", Default::default(), window, cx);
            assert!(!offered(view));
            view.dismiss_menu(window, cx);
        })
    });
}

// Host scripts need a POSIX client, so other clients offer no dialog.
// Fixture windows never poll, so no job queued here reaches a worker.
#[cfg(any(target_os = "linux", target_os = "macos"))]
mod dialog {
    use super::local;
    use crate::{
        checkpoint::{Checkpoint, Diff, Listing},
        menu::Page,
    };
    use herdr_client::protocol::AgentStatus;

    fn checkpoint(id: &str, branch: &str) -> Checkpoint {
        Checkpoint {
            id: id.into(),
            created: 0,
            label: format!("turn {id}"),
            branch: Some(branch.into()),
            diff: Diff {
                files: 2,
                additions: 7,
                deletions: 1,
            },
        }
    }

    #[gpui::test]
    fn a_restore_is_confirmed_and_warns_of_working_agents(cx: &mut gpui::TestAppContext) {
        let (view, cx) = cx.add_window_view(crate::sidebar::layout_tests::fixture_window);
        cx.update(|window, cx| {
            view.update(cx, |view, cx| {
                local(view);
                let snapshot = std::sync::Arc::make_mut(view.live.snapshot.as_mut().unwrap());
                snapshot.agents[0].workspace_id = "w4".into();
                snapshot.agents[0].agent_status = AgentStatus::Working;
                view.open_workspace_menu("w4", Default::default(), window, cx);
                view.activate_workspace_menu(
                    crate::menu::page::WorkspaceMenuAction::Checkpoints,
                    window,
                    cx,
                );
                assert_eq!(view.menu.page, Some(Page::Checkpoints));
                let checkpoints = view.checkpoints.view.as_mut().unwrap();
                assert_eq!(checkpoints.checkout.branch, "worktree/sidebar-child");
                checkpoints.listing = Listing::Ready(vec![
                    checkpoint("2", "worktree/sidebar-child"),
                    checkpoint("1", "worktree/sidebar-child"),
                ]);
            })
        });
        cx.run_until_parked();
        assert!(cx.debug_bounds("checkpoint-1").is_some());
        assert!(cx.debug_bounds("checkpoints-restore").is_none());
        cx.simulate_keystrokes("down down enter");
        cx.run_until_parked();
        cx.update(|_, cx| {
            let view = view.read(cx).checkpoints.view.as_ref().unwrap();
            assert_eq!(view.confirming.as_deref(), Some("1"));
            assert!(!view.restoring);
        });
        assert!(cx.debug_bounds("checkpoints-agent-working").is_some());
        let panel = cx.debug_bounds("menu-panel").unwrap();
        let restore = cx.debug_bounds("checkpoints-restore").unwrap();
        assert!(panel.contains(&restore.origin));
        // Escape backs out of the confirmation, not the dialog.
        cx.simulate_keystrokes("escape");
        cx.update(|_, cx| {
            let view = view.read(cx);
            assert_eq!(view.menu.page, Some(Page::Checkpoints));
            assert!(view.checkpoints.view.as_ref().unwrap().confirming.is_none());
        });
        cx.simulate_keystrokes("enter enter");
        cx.update(|_, cx| {
            assert!(view.read(cx).checkpoints.view.as_ref().unwrap().restoring);
        });
        cx.update(|window, cx| {
            view.update(cx, |view, cx| {
                view.dismiss_menu(window, cx);
                view.close_stale_checkpoints();
                assert!(view.checkpoints.view.is_none());
            })
        });
    }
}
