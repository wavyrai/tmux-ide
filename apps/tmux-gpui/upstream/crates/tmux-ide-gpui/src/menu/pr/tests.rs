#![allow(clippy::unwrap_used)]
use crate::pull_request::{Origin, repository_input};
use herdr_client::protocol::ClientShellWorktree;

#[test]
fn metadata_priority_alternates_with_round_robin_and_skips_ineligible_workspaces() {
    let mut snapshot = crate::sidebar::layout_tests::snapshot(6);
    snapshot.focused_workspace_id = Some("w5".into());
    // A saved device requires daemon metadata, so only metadata decides here.
    let origin = Origin::Ssh("device".into());
    let branches = |snapshot: &super::ClientShellSnapshot, open, cursor| {
        super::workspace_pr_inputs(snapshot, &origin, open, cursor)
            .map(|input| input.branch)
            .collect::<Vec<_>>()
    };
    assert_eq!(
        branches(&snapshot, None, 0)[0],
        "worktree/sidebar-child-with-a-long-readable-branch-name"
    );
    assert_eq!(
        branches(&snapshot, Some("w4"), 0)[0],
        "worktree/sidebar-child"
    );
    assert_eq!(
        branches(&snapshot, Some("w4"), 1)[0],
        "develop",
        "every other admission serves the rest"
    );
    assert_eq!(
        branches(&snapshot, None, 5)[0],
        "worktree/sidebar-child-with-a-long-readable-branch-name"
    );
    snapshot.workspaces[3].worktree.as_mut().unwrap().key = "relative".into();
    snapshot.workspaces[4].branch = None;
    assert_eq!(branches(&snapshot, None, 1).len(), 1);
    snapshot.workspaces.clear();
    assert!(branches(&snapshot, None, 0).is_empty());
}

#[gpui::test]
fn cached_menu_open_is_immediate_and_does_not_touch_deletion_response(
    cx: &mut gpui::TestAppContext,
) {
    let (view, cx) = cx.add_window_view(crate::sidebar::layout_tests::fixture_window);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.live.status = crate::state::ConnectionStatus::Connected;
            view.open_workspace_menu("w3", Default::default(), window, cx);
            view.workspace_pr_fixture(crate::pull_request::fixture().unwrap())
                .unwrap();
            view.dismiss_menu(window, cx);
            let pending = Some(("delete-request".into(), None));
            view.live.dialog_response = pending.clone();
            view.endpoints[0]
                .connection
                .inbox
                .lock()
                .unwrap()
                .dialog_response = pending.clone();
            view.open_workspace_menu("w3", Default::default(), window, cx);
            assert_eq!(view.menu.pr.value.as_ref().unwrap().number, 8);
            assert!(!view.menu.pr.loading);
            assert_eq!(view.menu.workspace_selected, None);
            assert!(
                matches!(&view.live.dialog_response, Some((id, None)) if id == "delete-request")
            );
            assert!(matches!(
                &view.endpoints[0]
                    .connection
                    .inbox
                    .lock()
                    .unwrap()
                    .dialog_response,
                Some((id, None)) if id == "delete-request"
            ));
            // Switching repository/branch never reuses this cached PR.
            view.dismiss_menu(window, cx);
            view.open_workspace_menu("w4", Default::default(), window, cx);
            assert!(view.menu.pr.value.is_none());
            assert!(view.menu.pr.loading);
        })
    });
}

#[gpui::test]
fn compact_pr_is_the_only_metadata_action(cx: &mut gpui::TestAppContext) {
    use super::super::{Page, WorkspaceMenuAction};
    use gpui::{point, px, size};
    let (view, cx) = cx.add_window_view(crate::sidebar::layout_tests::fixture_window);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.live.status = crate::state::ConnectionStatus::Connected;
            view.open_workspace_menu("w3", point(px(620.), px(380.)), window, cx);
            view.menu.github = crate::github::Auth::connected_fixture();
            view.menu.pr.clear();
            view.menu.pr.loading = true;
            cx.notify();
        })
    });
    cx.run_until_parked();
    cx.simulate_keystrokes("down");
    cx.update(|_, cx| {
        view.update(cx, |view, cx| {
            view.menu.pr.loading = false;
            view.menu.pr.value = Some(crate::pull_request::fixture().unwrap());
            assert_eq!(
                view.menu.workspace_selected,
                view.workspace_items().first().map(|(action, _)| *action)
            );
            cx.notify();
        })
    });
    for width in [320., 640., 1200.] {
        cx.simulate_resize(size(px(width), px(400.)));
        cx.update(|window, cx| {
            window.draw(cx).clear(cx);
        });
        let panel = cx.debug_bounds("menu-panel").unwrap();
        let title = cx.debug_bounds("workspace-pr-title").unwrap();
        let header = cx.debug_bounds("workspace-menu-header").unwrap();
        assert!(
            panel.size.height < px(340.) + header.size.height + px(4.),
            "oversized popover: {panel:?}"
        );
        assert!(panel.left() >= px(0.) && panel.right() <= px(width));
        assert!(panel.bottom() <= px(400.));
        assert!(panel.contains(&title.origin) && title.right() <= panel.right());
        assert!(cx.debug_bounds("workspace-pr-open").is_none());
        assert!(cx.debug_bounds("workspace-pr-refresh").is_none());
    }
    // No O/R aliases, and no default activation when the result arrives.
    cx.update(|_, cx| view.update(cx, |view, _| view.menu.workspace_selected = None));
    cx.simulate_keystrokes("enter o r");
    assert!(cx.opened_url().is_none());
    cx.simulate_keystrokes("up");
    cx.update(|_, cx| {
        assert_eq!(
            view.read(cx).menu.workspace_selected,
            Some(WorkspaceMenuAction::PullRequest)
        );
    });
    // A stale target is rejected even before the asynchronous invalidation tick.
    cx.update(|_, cx| view.update(cx, |view, _| view.endpoints[0].generation += 1));
    cx.simulate_keystrokes("enter");
    assert!(cx.opened_url().is_none());
    cx.update(|_, cx| {
        view.update(cx, |view, cx| {
            assert!(view.update_workspace_pr());
            assert_eq!(view.menu.workspace_selected, None);
            view.endpoints[0].generation -= 1;
            view.menu.pr.clear();
            view.menu.pr.value = Some(crate::pull_request::fixture().unwrap());
            cx.notify();
        })
    });
    cx.update(|window, cx| {
        window.draw(cx).clear(cx);
    });
    let title = cx.debug_bounds("workspace-pr-title").unwrap().center();
    // Debug selectors are static; leaking one test label is fine.
    let first: &'static str = cx
        .update(|_, cx| format!("workspace-menu-{}", view.read(cx).workspace_items()[0].1).leak());
    let first = cx.debug_bounds(first).unwrap().center();
    cx.simulate_mouse_move(title, None, Default::default());
    cx.update(|_, cx| {
        assert_eq!(
            view.read(cx).menu.workspace_selected,
            Some(WorkspaceMenuAction::PullRequest)
        )
    });
    // Past the PR card, the arrows wrap to the first tile.
    cx.simulate_keystrokes("down");
    cx.update(|_, cx| {
        let view = view.read(cx);
        assert_eq!(
            view.menu.workspace_selected,
            view.workspace_items().first().map(|(action, _)| *action)
        )
    });
    cx.simulate_mouse_move(first, None, Default::default());
    cx.simulate_keystrokes("up enter");
    let expected = cx.update(|_, cx| view.read(cx).menu.pr.value.as_ref().unwrap().url.clone());
    assert_eq!(cx.opened_url(), Some(expected.clone()));
    cx.simulate_click(title, Default::default());
    assert_eq!(cx.opened_url(), Some(expected));
    cx.update(|_, cx| {
        view.update(cx, |view, cx| {
            view.menu.github = Default::default();
            view.update_workspace_pr();
            assert_eq!(view.menu.workspace_selected, None);
            assert!(
                !view
                    .workspace_menu_actions()
                    .contains(&WorkspaceMenuAction::PullRequest)
            );
            assert!(view.menu.page == Some(Page::Workspace));
            cx.notify();
        })
    });
    cx.run_until_parked();
    cx.update(|window, cx| {
        window.draw(cx).clear(cx);
    });
    // GPUI retains removed debug selectors; measure the remaining action panel.
    // Seven actions, in the tile grid and the rows below it, and the target
    // header: no PR section or stale metadata.
    let rows = cx.update(|_, cx| view.read(cx).workspace_menu_actions().len());
    assert_eq!(rows, 7);
    let panel = cx.debug_bounds("menu-panel").unwrap().size.height;
    let header = cx
        .debug_bounds("workspace-menu-header")
        .unwrap()
        .size
        .height
        + px(4.);
    let tiles = cx.debug_bounds("workspace-menu-tiles").unwrap().size.height;
    assert!(panel - header - tiles < px(35. * rows as f32), "{panel:?}");
}

/// Explicitly selected running daemon only: no start, focus, resize, input,
/// credential writes, or terminal surface subscription. Do not log metadata.
#[cfg(all(feature = "integration-test", target_os = "macos"))]
#[test]
#[allow(clippy::expect_used)]
#[ignore = "requires explicit HERDR_TEST_PR_SOCKET/REPO_KEY/BRANCH; HERDR_TEST_PR_GITHUB=1 additionally uses existing sign-in"]
fn live_local_pr_lookup() {
    use herdr_client::{ClientEvent, ConnectOptions, ConnectTarget, connect_with_connector};
    use std::{
        env,
        path::PathBuf,
        time::{Duration, Instant},
    };

    let socket = env::var_os("HERDR_TEST_PR_SOCKET").expect("explicit PR socket required");
    let repo_key = env::var("HERDR_TEST_PR_REPO_KEY").expect("explicit repository key required");
    let branch = env::var("HERDR_TEST_PR_BRANCH").expect("explicit branch required");
    let client = connect_with_connector(
        ConnectTarget::Socket(PathBuf::from(socket)),
        ConnectOptions::default(),
        false,
        |target, stop| {
            let (stream, local) =
                crate::daemon::connect(target, stop, || panic!("must not start daemon"))?;
            if !local {
                return Err(std::io::Error::other("local endpoint validation failed"));
            }
            eprintln!("Live local endpoint validation passed.");
            Ok(stream)
        },
    )
    .unwrap();
    let deadline = Instant::now() + Duration::from_secs(20);
    let snapshot = loop {
        let event = client
            .events
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .expect("snapshot deadline");
        match event {
            ClientEvent::Snapshot(snapshot) => break snapshot,
            ClientEvent::Disconnected { reason, .. } => panic!("local connection failed: {reason}"),
            _ => {}
        }
    };
    let workspace = snapshot
        .workspaces
        .iter()
        .find(|workspace| {
            workspace.branch.as_deref() == Some(&branch)
                && workspace
                    .worktree
                    .as_ref()
                    .is_some_and(|tree| tree.key == repo_key)
        })
        .expect("requested repository/branch not present in daemon snapshot");
    // The checkout comes from Git's worktree registry, never the daemon.
    let input = repository_input(workspace.worktree.as_ref(), workspace.branch.as_deref()).unwrap();
    client.handle.disconnect();
    crate::pull_request::local_repository(
        &input,
        Instant::now() + Duration::from_secs(15),
        &|| false,
    )
    .unwrap();
    eprintln!("Live checkout common-directory, branch, and GitHub origin validation passed.");
    if env::var_os("HERDR_TEST_PR_GITHUB").as_deref() != Some(std::ffi::OsStr::new("1")) {
        eprintln!("Authenticated GitHub lookup not requested (set HERDR_TEST_PR_GITHUB=1).");
        return;
    }
    let mut auth = crate::github::Auth::default();
    auth.initialize(&crate::config::Config::default());
    let deadline = Instant::now() + Duration::from_secs(45);
    while auth.loading_profile() && Instant::now() < deadline {
        auth.poll();
        std::thread::sleep(Duration::from_millis(10));
    }
    let profile = auth
        .profile
        .as_ref()
        .expect("existing GitHub sign-in unavailable");
    let mut lookup = crate::pull_request::Lookup::default();
    lookup.request(input, Origin::Local, profile.token.clone());
    let deadline = Instant::now() + Duration::from_secs(20);
    while lookup.loading && Instant::now() < deadline {
        lookup.poll();
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(!lookup.loading, "PR worker deadline");
    assert!(
        lookup.message.is_none(),
        "PR lookup failed: {:?}",
        lookup.message
    );
    assert!(lookup.checked.is_some());
    eprintln!(
        "Live local endpoint, checkout identity/branch, and authenticated PR lookup passed (PR present: {}).",
        lookup.value.is_some()
    );
}

#[test]
fn snapshot_metadata_is_the_lookup_key_and_leaves_checkout_to_git() {
    let repo_key = std::env::temp_dir()
        .join("repo/.git")
        .to_str()
        .unwrap()
        .to_owned();
    let tree = ClientShellWorktree {
        key: repo_key.clone(),
        label: "repo".into(),
        is_linked_worktree: true,
    };
    let input = repository_input(Some(&tree), Some("feature")).unwrap();
    // No daemon request supplies a path; the worker resolves it from the
    // repository's own worktree registry.
    assert!(input.checkout.is_none());
    assert_eq!(input.repo_key, Some(repo_key));
    assert_eq!(input.branch, "feature");
    assert!(matches!(
        repository_input(None, Some("feature")),
        Err(crate::Error::PrMetadata)
    ));
    for branch in [None, Some(""), Some("bad\nbranch")] {
        assert!(matches!(
            repository_input(Some(&tree), branch),
            Err(crate::Error::PrBranch)
        ));
    }
    let relative = ClientShellWorktree {
        key: "repo/.git".into(),
        ..tree
    };
    assert!(matches!(
        repository_input(Some(&relative), Some("feature")),
        Err(crate::Error::PrAbsolutePath)
    ));
}
