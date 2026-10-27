use super::*;

/// A workspace that merely sits in a repository has a branch but no daemon
/// worktree metadata. Its GitHub tabs still ask for a listing, read from the
/// workspace directory on the worker, instead of reporting missing metadata.
#[gpui::test]
fn a_branch_only_workspace_still_lists_from_its_directory(cx: &mut gpui::TestAppContext) {
    let (view, cx) = cx.add_window_view(sidebar::layout_tests::fixture_window);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            let snapshot = std::sync::Arc::make_mut(view.live.snapshot.as_mut().unwrap());
            snapshot.workspaces = sidebar::layout_tests::snapshot(7).workspaces;
            assert!(snapshot.workspaces[0].worktree.is_none());
            // The fixture's `/tmp` is not an absolute path on Windows.
            snapshot.workspaces[0].new_workspace_cwd =
                std::env::temp_dir().to_string_lossy().into_owned();
            view.live.status = crate::state::ConnectionStatus::Connected;
            view.live.local_daemon_peer = true;
            view.menu.reset();
            view.menu.github = crate::github::Auth::connected_fixture();
            view.open_workspace_menu("w0", Default::default(), window, cx);
            view.open_workspace_dialog(WorkspaceAction::NewWorktree, window, cx);
            view.select_worktree_tab(Tab::Items(Kind::PullRequest), window, cx);
            let source = view.menu.worktree.as_ref().unwrap();
            assert_eq!(source.tab, Tab::Items(Kind::PullRequest));
            assert!(source.lookup.loading, "a listing was requested");
            assert_eq!(source.lookup.message, None);
        });
    });
}
