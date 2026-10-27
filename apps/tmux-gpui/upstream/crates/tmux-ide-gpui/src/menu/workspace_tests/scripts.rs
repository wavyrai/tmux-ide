use super::*;

/// The menu target's delete dialog, its checkout read from `dir`.
fn delete_with_scripts(
    view: &mut HerdrWindow,
    dir: &std::path::Path,
    window: &mut gpui::Window,
    cx: &mut gpui::Context<HerdrWindow>,
) {
    view.open_workspace_menu("w1", Default::default(), window, cx);
    view.menu.page = Some(crate::menu::Page::Dialog(WorkspaceAction::DeleteWorktree));
    view.menu.deletion = Some(Deletion {
        path: Some(dir.to_str().unwrap().into()),
        root: Some("/repo".into()),
        ..Deletion::new(None, false)
    });
    view.read_archive_script(cx);
    assert!(!view.menu.deletion.as_ref().unwrap().ready());
}

#[gpui::test]
fn every_git_checkout_offers_its_scripts(cx: &mut gpui::TestAppContext) {
    use crate::worktree_scripts::ScriptKind;
    let (view, cx) = cx.add_window_view(sidebar::layout_tests::fixture_window);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.live.status = crate::state::ConnectionStatus::Connected;
            let items = |view: &HerdrWindow| -> Vec<_> {
                view.workspace_items()
                    .into_iter()
                    .map(|(action, _)| action)
                    .collect()
            };
            // A main checkout runs, a linked one also sets up, a plain folder neither.
            for (id, run, setup) in [
                ("w3", true, false),
                ("w4", true, true),
                ("w0", false, false),
            ] {
                view.open_workspace_menu(id, Default::default(), window, cx);
                let actions = items(view);
                assert_eq!(
                    actions.contains(&WorkspaceMenuAction::Script(ScriptKind::Run)),
                    run,
                    "{id}"
                );
                assert_eq!(
                    actions.contains(&WorkspaceMenuAction::Script(ScriptKind::Setup)),
                    setup,
                    "{id}"
                );
                view.dismiss_menu(window, cx);
            }
        })
    });
}

/// An archive script is reviewed before removal, and declining it still
/// removes the checkout as its button says, through the ordinary request.
#[gpui::test]
fn an_untrusted_archive_script_is_asked_about_before_removal(cx: &mut gpui::TestAppContext) {
    let dir = tempfile::tempdir().unwrap();
    crate::worktree_scripts::tests::write_scripts(
        dir.path(),
        "[scripts]\narchive = \"docker compose down\"\n",
    );
    let mut peer = crate::window::MockPeer::advertising(&["worktree.remove", "tab.create"]);
    let (view, cx) = cx.add_window_view(sidebar::layout_tests::fixture_window);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            crate::worktree_scripts::tests::connect(view, &peer, cx);
            delete_with_scripts(view, dir.path(), window, cx);
        })
    });
    cx.run_until_parked();
    assert!(cx.debug_bounds("dialog-archive-script").is_some());
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            assert!(view.menu.deletion.as_ref().unwrap().ready());
            view.submit_workspace_dialog(window, cx);
            // Nothing is removed while the question is open.
            assert!(view.menu.page.is_none() && view.removal.is_none());
            view.poll_worktree_script(window, cx);
            assert_eq!(view.menu.page, Some(crate::menu::Page::WorktreeScript));
            view.arm_worktree_script();
            view.skip_worktree_script(window, cx);
            assert!(view.removal.as_ref().unwrap().pending.is_some());
        })
    });
    let removal = peer.request();
    assert_eq!(removal["method"], "worktree.remove");
    assert_eq!(removal["params"]["workspace_id"], "w1");
    assert_eq!(removal["params"]["force"], false);
}

/// A trusted archive script removes nothing itself: its tab runs the script
/// and only then the pane's own `herdr worktree remove`.
#[gpui::test]
fn a_trusted_archive_script_runs_in_a_tab_instead_of_removing(cx: &mut gpui::TestAppContext) {
    use crate::worktree_scripts::{Trust, read_config};
    let dir = tempfile::tempdir().unwrap();
    crate::worktree_scripts::tests::write_scripts(
        dir.path(),
        "[scripts]\narchive = \"docker compose down\"\n",
    );
    let config = read_config(
        &herdr_client::ConnectTarget::Local,
        dir.path().to_str().unwrap(),
        &std::sync::atomic::AtomicBool::new(false),
    )
    .unwrap()
    .unwrap();
    let mut peer = crate::window::MockPeer::advertising(&["worktree.remove", "tab.create"]);
    let (view, cx) = cx.add_window_view(sidebar::layout_tests::fixture_window);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            crate::worktree_scripts::tests::connect(view, &peer, cx);
            cx.default_global::<Trust>()
                .grant(crate::worktree_scripts::Grant {
                    endpoint: view.endpoints[0].id.clone(),
                    repo_key: "repo/main".into(),
                    digest: config.digest.clone(),
                });
            delete_with_scripts(view, dir.path(), window, cx);
        })
    });
    cx.run_until_parked();
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.submit_workspace_dialog(window, cx);
            assert!(view.menu.page.is_none() && view.removal.is_none());
        })
    });
    let tab = peer.request();
    assert_eq!(tab["method"], "tab.create");
    assert_eq!(tab["params"]["label"], "archive");
    assert_eq!(
        tab["params"]["env"]["HERDR_WORKTREE_SCRIPT"],
        "docker compose down"
    );
    assert_eq!(tab["params"]["env"]["HERDR_ROOT_PATH"], "/repo");
}

/// Creating a worktree starts its setup script, asking first; opening an
/// existing checkout does not.
#[gpui::test]
fn a_created_worktree_offers_its_setup_script(cx: &mut gpui::TestAppContext) {
    let dir = tempfile::tempdir().unwrap();
    crate::worktree_scripts::tests::write_scripts(dir.path(), "[scripts]\nsetup = \"npm ci\"\n");
    let created = serde_json::json!({"result":{"type":"worktree_created","workspace":{"workspace_id":"w1",
        "worktree":{"checkout_path":dir.path().to_str().unwrap(),"repo_root":"/repo","repo_key":"repo/main","repo_name":"main"}}}});
    let peer = crate::window::MockPeer::new();
    let (view, cx) = cx.add_window_view(sidebar::layout_tests::fixture_window);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            crate::worktree_scripts::tests::connect(view, &peer, cx);
            view.open_workspace_menu("w1", Default::default(), window, cx);
            view.menu.page = Some(crate::menu::Page::Dialog(WorkspaceAction::NewWorktree));
            view.apply_creation_response(Ok(created), window, cx);
            assert!(view.menu.page.is_none());
        })
    });
    cx.run_until_parked();
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.poll_worktree_script(window, cx);
            assert_eq!(view.menu.page, Some(crate::menu::Page::WorktreeScript));
            assert!(view.local_error.is_none());
        })
    });
}
