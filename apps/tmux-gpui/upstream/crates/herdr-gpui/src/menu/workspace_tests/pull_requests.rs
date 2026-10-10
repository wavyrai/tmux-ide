use super::*;

#[gpui::test]
fn signed_out_workspace_has_no_github_section_or_requests(cx: &mut gpui::TestAppContext) {
    let (view, cx) = cx.add_window_view(sidebar::layout_tests::fixture_window);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.live.status = crate::state::ConnectionStatus::Connected;
            view.open_workspace_menu("w3", Default::default(), window, cx);
            view.refresh_workspace_pr();
            assert!(!view.menu.pr.loading);
            assert!(view.menu.pr.message.is_none());
            assert!(!view.menu.github.busy());
            assert!(!view.menu.github.loading_profile());
            cx.notify();
        })
    });
    cx.run_until_parked();
    assert!(cx.debug_bounds("workspace-pr").is_none());
}

#[gpui::test]
fn workspace_dialogs_and_prs_are_fenced_by_host_and_generation(cx: &mut gpui::TestAppContext) {
    let (view, cx) = cx.add_window_view(sidebar::layout_tests::fixture_window);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.menu.github = crate::github::Auth::connected_fixture();
            view.live.status = crate::state::ConnectionStatus::Connected;
            view.endpoints[0].live = view.live.clone();
            view.endpoints[0].live.supports_surface = true;
            let mut remote = crate::endpoint::Endpoint::new(
                "ssh:fixture".into(),
                "Remote".into(),
                herdr_client::ConnectTarget::Ssh {
                    target: "unused".into(),
                    session: "default".into(),
                },
                true,
            );
            // Identical boot/workspace IDs must not make different hosts interchangeable.
            remote.live = view.live.clone();
            remote.live.local_daemon_peer = true;
            view.endpoints.push(remote);
            view.open_workspace_menu("w3", Default::default(), window, cx);
            view.open_workspace_dialog(WorkspaceAction::Rename, window, cx);
            view.endpoints[0].generation += 1;
            view.submit_workspace_dialog(window, cx);
            assert_eq!(
                view.menu.error.as_deref(),
                Some("The selected connection changed or is not ready. Cancel and try again.")
            );
            assert!(view.select_endpoint("ssh:fixture", cx));
            assert!(view.menu.page.is_none());
            assert!(view.menu.input.is_none());
            view.open_workspace_menu("w3", Default::default(), window, cx);
            // A saved SSH host resolves its repository on that host, so its
            // lookup is accepted and scoped to it rather than to local Git.
            assert_eq!(
                view.pr_origin(),
                Some(crate::pull_request::Origin::Ssh("unused".into()))
            );
            assert!(view.menu.pr.message.is_none());
            assert!(view.menu.pr.loading);
            view.open_workspace_dialog(WorkspaceAction::DeleteWorktree, window, cx);
            assert!(view.select_endpoint(crate::endpoint::LOCAL, cx));
            assert!(view.menu.deletion.is_none());
        });
    });
}
