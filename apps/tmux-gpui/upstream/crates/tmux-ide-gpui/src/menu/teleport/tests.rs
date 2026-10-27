use super::*;
use crate::sidebar::layout_tests::{REPO_KEY, snapshot};
use crate::teleport::Repository;

#[test]
fn repositories_prefer_their_main_checkout_workspace() {
    // w3 is the main checkout; w4 and w5 are linked worktrees of it.
    let mut snapshot = snapshot(6);
    snapshot.workspaces.swap(3, 5);
    assert_eq!(
        open_repositories(&snapshot),
        [Repository {
            key: REPO_KEY.into(),
            label: "agent-launcher".into(),
            workspace_id: "w3".into(),
        }]
    );
    snapshot
        .workspaces
        .retain(|workspace| workspace.workspace_id != "w3");
    assert_eq!(open_repositories(&snapshot)[0].workspace_id, "w5");
}

fn teleport_items(view: &HerdrWindow) -> usize {
    view.workspace_items()
        .iter()
        .filter(|(action, _)| *action == super::super::WorkspaceMenuAction::Teleport)
        .count()
}

#[gpui::test]
fn teleport_is_offered_for_linked_worktrees_on_scriptable_hosts(cx: &mut gpui::TestAppContext) {
    // Host scripts need a POSIX client, so Windows never offers Teleport.
    let offered = usize::from(cfg!(any(target_os = "linux", target_os = "macos")));
    let (view, cx) = cx.add_window_view(crate::sidebar::layout_tests::fixture_window);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.live.status = crate::state::ConnectionStatus::Connected;
            let snapshot = std::sync::Arc::make_mut(view.live.snapshot.as_mut().unwrap());
            snapshot.workspaces = crate::sidebar::layout_tests::snapshot(7).workspaces;
            view.open_workspace_menu("w4", Default::default(), window, cx);
            assert_eq!(
                teleport_items(view),
                0,
                "a custom socket cannot be scripted"
            );
            view.dismiss_menu(window, cx);
            view.endpoints[0].connection.target = herdr_client::ConnectTarget::Local;
            view.open_workspace_menu("w4", Default::default(), window, cx);
            assert_eq!(
                teleport_items(view),
                offered,
                "offered even with no other host"
            );
            view.dismiss_menu(window, cx);

            let mut remote = crate::endpoint::Endpoint::new(
                "ssh:box".into(),
                "Box".into(),
                herdr_client::ConnectTarget::Ssh {
                    target: "me@box".into(),
                    session: "default".into(),
                },
                true,
            );
            remote.live = view.live.clone();
            view.endpoints.push(remote);
            view.open_workspace_menu("w4", Default::default(), window, cx);
            assert_eq!(teleport_items(view), offered);
            view.dismiss_menu(window, cx);
            // A main checkout is not a worktree that can move.
            view.open_workspace_menu("w3", Default::default(), window, cx);
            assert_eq!(teleport_items(view), 0);
            view.dismiss_menu(window, cx);
        })
    });
}

#[gpui::test]
fn hosts_are_listed_at_once_with_none_chosen_for_the_user(cx: &mut gpui::TestAppContext) {
    use super::super::WorkspaceMenuAction;
    let (view, cx) = cx.add_window_view(crate::sidebar::layout_tests::fixture_window);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.live.status = crate::state::ConnectionStatus::Connected;
            view.endpoints[0].connection.target = herdr_client::ConnectTarget::Local;
            let snapshot = std::sync::Arc::make_mut(view.live.snapshot.as_mut().unwrap());
            snapshot.workspaces = crate::sidebar::layout_tests::snapshot(7).workspaces;
            // Not connected, and unroutable: listing it must not wait on it.
            view.endpoints.push(crate::endpoint::Endpoint::new(
                "ssh:box".into(),
                "Box".into(),
                herdr_client::ConnectTarget::Ssh {
                    target: "nobody@invalid.invalid".into(),
                    session: "default".into(),
                },
                true,
            ));
            view.open_workspace_menu("w4", Default::default(), window, cx);
            view.activate_workspace_menu(WorkspaceMenuAction::Teleport, window, cx);
            assert_eq!(view.menu.page, Some(Page::Teleport));
        })
    });
    // The first frame already lists the host.
    cx.run_until_parked();
    let panel = cx.debug_bounds("menu-panel").unwrap();
    let row = cx.debug_bounds("teleport-host-0").unwrap();
    let dot = cx.debug_bounds("teleport-host-dot-0").unwrap();
    assert!(
        row.contains(&dot.center()),
        "the online dot sits in its row"
    );
    let submit = cx.debug_bounds("teleport-submit").unwrap();
    assert!(panel.contains(&row.origin) && panel.contains(&submit.origin));
    // No host is chosen for the user: Enter does nothing until one is.
    cx.simulate_keystrokes("enter");
    cx.update(|_, cx| {
        assert!(!view.read(cx).teleport.as_ref().unwrap().reviewing());
    });
    cx.simulate_keystrokes("down enter");
    cx.update(|_, cx| {
        assert!(view.read(cx).teleport.as_ref().unwrap().reviewing());
    });
    cx.simulate_keystrokes("escape");
    cx.update(|window, cx| {
        view.update(cx, |view, cx| view.poll_teleport(window, cx));
        assert!(view.read(cx).teleport.is_none(), "closing cancels a review");
        assert_eq!(view.read(cx).menu.page, None);
    });
}

#[gpui::test]
fn a_progress_bar_shows_the_review_and_fills_with_the_move(cx: &mut gpui::TestAppContext) {
    use super::super::WorkspaceMenuAction;
    let (view, cx) = cx.add_window_view(crate::sidebar::layout_tests::fixture_window);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.live.status = crate::state::ConnectionStatus::Connected;
            view.endpoints[0].connection.target = herdr_client::ConnectTarget::Local;
            let snapshot = std::sync::Arc::make_mut(view.live.snapshot.as_mut().unwrap());
            snapshot.workspaces = crate::sidebar::layout_tests::snapshot(7).workspaces;
            view.endpoints.push(crate::endpoint::Endpoint::new(
                "ssh:box".into(),
                "Box".into(),
                herdr_client::ConnectTarget::Ssh {
                    target: "nobody@invalid.invalid".into(),
                    session: "default".into(),
                },
                true,
            ));
            view.open_workspace_menu("w4", Default::default(), window, cx);
            view.activate_workspace_menu(WorkspaceMenuAction::Teleport, window, cx);
        })
    });
    cx.run_until_parked();
    assert!(
        cx.debug_bounds("teleport-progress").is_none(),
        "nothing runs while choosing"
    );
    cx.simulate_keystrokes("down enter");
    cx.run_until_parked();
    let panel = cx.debug_bounds("menu-panel").unwrap();
    let bar = cx.debug_bounds("teleport-progress").unwrap();
    assert!(panel.contains(&bar.origin) && bar.right() <= panel.right());
    assert!(cx.debug_bounds("teleport-progress-fill").is_some());

    cx.update(|_, cx| {
        view.update(cx, |view, cx| {
            view.teleport.as_mut().unwrap().fetching();
            cx.notify();
        })
    });
    cx.run_until_parked();
    let bar = cx.debug_bounds("teleport-progress").unwrap();
    let fill = cx.debug_bounds("teleport-progress-fill").unwrap();
    assert_eq!(fill.left(), bar.left());
    // Fetch starts after five of the thirteen move steps.
    assert!((fill.size.width - bar.size.width * (5. / 13.)).abs() < gpui::px(1.));
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.teleport = None;
            view.dismiss_menu(window, cx);
        })
    });
}

fn actions(view: &HerdrWindow) -> Vec<super::super::WorkspaceMenuAction> {
    view.workspace_items()
        .into_iter()
        .map(|(action, _)| action)
        .collect()
}

#[gpui::test]
fn a_teleported_worktree_offers_its_copy_and_can_be_cleared(cx: &mut gpui::TestAppContext) {
    use super::super::WorkspaceMenuAction;
    let (view, cx) = cx.add_window_view(crate::sidebar::layout_tests::fixture_window);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.live.status = crate::state::ConnectionStatus::Connected;
            view.live.supports_surface = true;
            view.endpoints[0].connection.target = herdr_client::ConnectTarget::Local;
            let snapshot = std::sync::Arc::make_mut(view.live.snapshot.as_mut().unwrap());
            snapshot.workspaces = crate::sidebar::layout_tests::snapshot(7).workspaces;
            view.endpoints[0].live = view.live.clone();
            view.endpoints.push(crate::endpoint::Endpoint::new(
                "ssh:box".into(),
                "Box".into(),
                herdr_client::ConnectTarget::Ssh {
                    target: "me@box".into(),
                    session: "default".into(),
                },
                true,
            ));
            // w4 is the linked worktree on `worktree/sidebar-child`.
            view.teleport_marks.add(Mark {
                endpoint: crate::endpoint::LOCAL.into(),
                repo_key: REPO_KEY.into(),
                branch: "worktree/sidebar-child".into(),
                destination: crate::teleport::MarkDestination {
                    endpoint: "ssh:box".into(),
                    label: "Box".into(),
                    repo_key: "/home/me/agent-launcher/.git".into(),
                    workspace_id: "w9".into(),
                },
            });

            view.open_workspace_menu("w4", Default::default(), window, cx);
            let offered = actions(view);
            assert!(offered.contains(&WorkspaceMenuAction::GoToTeleported));
            assert!(offered.contains(&WorkspaceMenuAction::ClearTeleported));
            assert!(!offered.contains(&WorkspaceMenuAction::Teleport));

            view.activate_workspace_menu(WorkspaceMenuAction::GoToTeleported, window, cx);
            assert_eq!(view.menu.page, None);
            assert!(view.teleport_follow.is_some());
            view.poll_teleport(window, cx);
            assert_eq!(view.endpoints[view.selected_endpoint].id, "ssh:box");

            // Back on the local host, clearing the mark offers Teleport again.
            view.teleport_follow = None;
            assert!(view.navigate_endpoint(
                crate::endpoint::LOCAL,
                crate::NavigationTarget::Workspace("w4"),
                cx,
            ));
            view.live.status = crate::state::ConnectionStatus::Connected;
            let snapshot = std::sync::Arc::make_mut(view.live.snapshot.get_or_insert_with(|| {
                std::sync::Arc::new(crate::sidebar::layout_tests::snapshot(7))
            }));
            snapshot.workspaces = crate::sidebar::layout_tests::snapshot(7).workspaces;
            view.open_workspace_menu("w4", Default::default(), window, cx);
            view.activate_workspace_menu(WorkspaceMenuAction::ClearTeleported, window, cx);
            assert!(
                view.teleport_marks
                    .find(crate::endpoint::LOCAL, REPO_KEY, "worktree/sidebar-child")
                    .is_none()
            );
            view.open_workspace_menu("w4", Default::default(), window, cx);
            assert!(
                actions(view).contains(&WorkspaceMenuAction::Teleport)
                    == cfg!(any(target_os = "linux", target_os = "macos"))
            );
        })
    });
}

#[gpui::test]
fn a_teleported_copy_offers_to_go_back_where_it_came_from(cx: &mut gpui::TestAppContext) {
    use super::super::WorkspaceMenuAction;
    let (view, cx) = cx.add_window_view(crate::sidebar::layout_tests::fixture_window);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.live.status = crate::state::ConnectionStatus::Connected;
            view.endpoints[0].connection.target = herdr_client::ConnectTarget::Local;
            let snapshot = std::sync::Arc::make_mut(view.live.snapshot.as_mut().unwrap());
            snapshot.workspaces = crate::sidebar::layout_tests::snapshot(7).workspaces;
            // w4's work arrived here from the box.
            view.teleport_marks.add(Mark {
                endpoint: "ssh:box".into(),
                repo_key: "/home/me/agent-launcher/.git".into(),
                branch: "worktree/sidebar-child".into(),
                destination: crate::teleport::MarkDestination {
                    endpoint: crate::endpoint::LOCAL.into(),
                    label: "Local".into(),
                    repo_key: REPO_KEY.into(),
                    workspace_id: "w4".into(),
                },
            });
            // Without the box among this window's hosts there is nowhere to go back to.
            view.open_workspace_menu("w4", Default::default(), window, cx);
            assert!(!actions(view).contains(&WorkspaceMenuAction::TeleportBack));
            view.dismiss_menu(window, cx);

            view.endpoints.push(crate::endpoint::Endpoint::new(
                "ssh:box".into(),
                "Box".into(),
                herdr_client::ConnectTarget::Ssh {
                    target: "nobody@invalid.invalid".into(),
                    session: "default".into(),
                },
                true,
            ));
            view.open_workspace_menu("w4", Default::default(), window, cx);
            let offered = actions(view);
            if !cfg!(any(target_os = "linux", target_os = "macos")) {
                assert!(!offered.contains(&WorkspaceMenuAction::TeleportBack));
                return;
            }
            assert!(offered.contains(&WorkspaceMenuAction::TeleportBack));
            assert!(offered.contains(&WorkspaceMenuAction::Teleport));
            view.activate_workspace_menu(WorkspaceMenuAction::TeleportBack, window, cx);
            assert_eq!(view.menu.page, Some(Page::Teleport));
            assert!(
                view.teleport.as_ref().unwrap().reviewing(),
                "goes straight to the review"
            );
        })
    });
}
