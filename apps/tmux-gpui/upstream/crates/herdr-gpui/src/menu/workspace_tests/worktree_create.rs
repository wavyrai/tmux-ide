use super::*;

/// Opening the dialog prepares the same branch and checkout the terminal
/// client proposes, rather than an empty field.
#[gpui::test]
fn new_worktree_dialog_proposes_a_branch_and_previews_its_checkout(cx: &mut gpui::TestAppContext) {
    let (view, cx) = cx.add_window_view(sidebar::layout_tests::fixture_window);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            let snapshot = std::sync::Arc::make_mut(view.live.snapshot.as_mut().unwrap());
            snapshot.workspaces = sidebar::layout_tests::snapshot(7).workspaces;
            snapshot.worktree_directory = "/endpoint/.herdr/worktrees".into();
            view.live.status = crate::state::ConnectionStatus::Connected;
            view.open_workspace_menu("w3", Default::default(), window, cx);
            view.open_workspace_dialog(WorkspaceAction::NewWorktree, window, cx);
            let branch = view.menu.input.as_ref().unwrap().text.clone();
            assert!(branch.starts_with("worktree/"), "{branch}");
            // Selected, so the first keystroke replaces the proposal.
            assert_eq!(view.menu.input.as_ref().unwrap().selection, 0..branch.len());
            assert_eq!(
                view.checkout_preview(),
                format!(
                    "/endpoint/.herdr/worktrees/agent-launcher/{}",
                    crate::worktree::branch_to_path_slug(&branch)
                )
            );
            // A blank field defers to the daemon instead of guessing a path.
            view.menu.input = Some(DialogInput::new("  ".into()));
            assert_eq!(view.checkout_preview(), "The daemon names the checkout.");
            view.menu.input = Some(DialogInput::new("feature/Login v2".into()));
            assert_eq!(
                view.checkout_preview(),
                "/endpoint/.herdr/worktrees/agent-launcher/feature-login-v2"
            );
            // Without a reported worktree directory no path is invented.
            std::sync::Arc::make_mut(view.live.snapshot.as_mut().unwrap())
                .worktree_directory
                .clear();
            assert_eq!(view.checkout_preview(), "The daemon chooses the checkout.");
        });
    });
}

/// The daemon switches only its own session, so the client follows the
/// created checkout itself; failures stay visible in the open dialog.
#[gpui::test]
fn worktree_creation_reports_failures_and_follows_the_created_checkout(
    cx: &mut gpui::TestAppContext,
) {
    let (view, cx) = cx.add_window_view(sidebar::layout_tests::fixture_window);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            let snapshot = std::sync::Arc::make_mut(view.live.snapshot.as_mut().unwrap());
            snapshot.workspaces = sidebar::layout_tests::snapshot(7).workspaces;
            view.live.status = crate::state::ConnectionStatus::Connected;
            view.open_workspace_menu("w3", Default::default(), window, cx);
            view.open_workspace_dialog(WorkspaceAction::NewWorktree, window, cx);
            view.menu.creation = Some("create".into());
            let dialog = Some(super::super::Page::Dialog(WorkspaceAction::NewWorktree));

            view.apply_creation_response(
                Ok(serde_json::json!({"error":{"code":"worktree_create_failed","message":"branch already checked out"}})),
                window,
                cx,
            );
            assert!(
                view.menu
                    .error
                    .as_deref()
                    .unwrap()
                    .contains("branch already checked out")
            );
            assert_eq!(view.menu.page, dialog);
            assert!(view.pending_navigation.is_none());

            view.apply_creation_response(
                Ok(serde_json::json!({"result":{"type":"worktree_list","worktrees":[]}})),
                window,
                cx,
            );
            assert!(
                view.menu
                    .error
                    .as_deref()
                    .unwrap()
                    .starts_with("Unexpected daemon response")
            );
            assert_eq!(view.menu.page, dialog);

            view.apply_creation_response(
                Err(std::sync::Arc::new(crate::Error::Client(
                    herdr_client::Error::Disconnected,
                ))),
                window,
                cx,
            );
            assert_eq!(view.menu.page, dialog);
            assert!(view.pending_navigation.is_none());

            // Only the correlated response closes the dialog and navigates.
            let created = serde_json::json!({"result":{"type":"worktree_created","workspace":{"workspace_id":"w6"},"tab":{"tab_id":"t9"}}});
            view.collapsed_repos
                .insert(sidebar::layout_tests::REPO_KEY.to_owned());
            view.menu.creation = Some("create".into());
            view.live.dialog_response = Some(("unrelated".into(), Some(Ok(created.clone()))));
            view.update_workspace_dialog(window, cx);
            assert_eq!(view.menu.page, dialog);
            assert_eq!(view.menu.creation.as_deref(), Some("create"));

            view.live.dialog_response = Some(("create".into(), Some(Ok(created))));
            view.update_workspace_dialog(window, cx);
            assert!(view.menu.page.is_none());
            assert!(view.menu.creation.is_none());
            assert_eq!(
                view.pending_navigation,
                Some(crate::NavigationTarget::Workspace("w6".into()))
            );
            // A folded group cannot hide the checkout that was just created.
            assert!(view.collapsed_repos.is_empty());
        });
    });
}

/// A linked checkout creates through its main checkout, the only source the
/// daemon accepts, but starts the new branch from its own branch.
#[test]
fn linked_checkouts_create_from_their_own_branch() {
    use super::super::workspace::NewWorktreeUnavailable;
    let mut snapshot = sidebar::layout_tests::snapshot(7);
    let main = WorkspaceTarget::for_new_worktree(&snapshot, &snapshot.workspaces[3]).unwrap();
    assert_eq!((main.id.as_str(), main.base_label()), ("w3", "HEAD"));

    let target = WorkspaceTarget::for_new_worktree(&snapshot, &snapshot.workspaces[4]).unwrap();
    assert_eq!(target.id, "w3");
    assert_eq!(target.base_label(), "worktree/sidebar-child");
    assert_eq!(
        target
            .request(&snapshot, WorkspaceAction::NewWorktree, "feature/next")
            .unwrap(),
        (
            Method::WorktreeCreate,
            serde_json::json!({"workspace_id": "w3", "base": "refs/heads/worktree/sidebar-child",
                "focus": true, "trust_repository": false, "branch": "feature/next"})
        )
    );
    // The branch came from the daemon, so it is checked like a typed one.
    let hostile = WorkspaceTarget {
        base: Some("-x".into()),
        ..WorkspaceTarget::new(&snapshot, &snapshot.workspaces[3])
    };
    assert!(matches!(
        hostile.request(&snapshot, WorkspaceAction::NewWorktree, ""),
        Err(crate::Error::InvalidBranchName)
    ));

    snapshot.workspaces[4].branch = None;
    assert_eq!(
        WorkspaceTarget::for_new_worktree(&snapshot, &snapshot.workspaces[4]).err(),
        Some(NewWorktreeUnavailable::Detached)
    );
    snapshot.workspaces.remove(3);
    assert_eq!(
        WorkspaceTarget::for_new_worktree(&snapshot, &snapshot.workspaces[4]).err(),
        Some(NewWorktreeUnavailable::MainCheckoutClosed)
    );
}

#[test]
fn branch_only_workspace_can_create_until_git_identity_disappears() {
    let mut snapshot = sidebar::layout_tests::snapshot(7);
    snapshot.workspaces[3].worktree = None;
    snapshot.workspaces[3].branch = Some("main".into());
    let target = WorkspaceTarget::new(&snapshot, &snapshot.workspaces[3]);
    assert!(target.can_create());
    assert!(!target.can_delete());
    assert_eq!(
        target
            .request(&snapshot, WorkspaceAction::NewWorktree, "feature/test")
            .unwrap(),
        (
            Method::WorktreeCreate,
            serde_json::json!({"workspace_id": "w3", "base": "HEAD", "focus": true,
                "trust_repository": false, "branch": "feature/test"})
        )
    );

    snapshot.workspaces[3].branch = None;
    assert!(!WorkspaceTarget::new(&snapshot, &snapshot.workspaces[3]).can_create());
    assert!(matches!(
        target.request(&snapshot, WorkspaceAction::NewWorktree, ""),
        Err(crate::Error::WorkspaceRepositoryChanged)
    ));

    snapshot.workspaces[3].branch = Some("main".into());
    snapshot.workspaces[3].worktree = snapshot.workspaces[4].worktree.clone();
    assert!(!WorkspaceTarget::new(&snapshot, &snapshot.workspaces[3]).can_create());
    assert!(matches!(
        target.request(&snapshot, WorkspaceAction::NewWorktree, ""),
        Err(crate::Error::WorkspaceRepositoryChanged)
    ));
}
