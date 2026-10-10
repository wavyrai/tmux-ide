use super::*;

#[test]
fn deletion_schema_and_target_validation() {
    let mut snapshot = sidebar::layout_tests::snapshot(7);
    let target = WorkspaceTarget::new(&snapshot, &snapshot.workspaces[4]);
    assert_eq!(
        target
            .request(&snapshot, WorkspaceAction::DeleteWorktree, "")
            .unwrap(),
        (
            Method::WorktreeRemove,
            serde_json::json!({"workspace_id":"w4", "force":false, "trust_repository":false})
        )
    );
    for index in [0, 3] {
        assert!(
            WorkspaceTarget::new(&snapshot, &snapshot.workspaces[index])
                .request(&snapshot, WorkspaceAction::DeleteWorktree, "")
                .is_err()
        );
    }
    snapshot.workspaces[4].worktree = None;
    assert!(
        target
            .request(&snapshot, WorkspaceAction::DeleteWorktree, "")
            .is_err()
    );
    snapshot.workspaces[4].worktree = target.worktree.clone();
    snapshot.boot_id = "replacement".into();
    assert!(
        target
            .request(&snapshot, WorkspaceAction::DeleteWorktree, "")
            .is_err()
    );
    snapshot.boot_id = target.boot_id.clone();
    snapshot.workspaces.remove(4);
    assert!(
        target
            .request(&snapshot, WorkspaceAction::DeleteWorktree, "")
            .is_err()
    );
}

#[gpui::test]
fn deletion_lookup_names_the_checkout_and_reports_errors(cx: &mut gpui::TestAppContext) {
    cx.update(|cx| {
        let snapshot = sidebar::layout_tests::snapshot(7);
        let mut menu = super::super::MenuState::new(cx);
        menu.target = Some(WorkspaceTarget::new(&snapshot, &snapshot.workspaces[4]));
        menu.page = Some(super::super::Page::Dialog(WorkspaceAction::DeleteWorktree));
        menu.deletion = Some(Deletion::new(Some("list".into()), false));
        let lookup = serde_json::json!({"result":{"type":"worktree_list", "worktrees":[{"open_workspace_id":"w4", "path":"/daemon/checkout", "is_linked_worktree":true, "is_bare":false}, {"path":"/daemon/main", "is_linked_worktree":false, "is_bare":false}]}});
        menu.apply_deletion_response("unrelated", Ok(lookup.clone()));
        assert!(menu.deletion.as_ref().unwrap().path.is_none());
        menu.apply_deletion_response("list", Ok(lookup));
        let deletion = menu.deletion.as_mut().unwrap();
        assert_eq!(deletion.path.as_deref(), Some("/daemon/checkout"));
        assert_eq!(deletion.root.as_deref(), Some("/daemon/main"));
        // Confirming also waits to know whether an archive script runs first.
        assert!(!deletion.ready());
        deletion.archive = ArchiveCheck::Reading;
        assert!(!deletion.ready());
        deletion.archive = ArchiveCheck::Read(None);
        assert!(deletion.ready());
        // The dialog only ever awaits the lookup, so a removal reply here is
        // not something it can act on.
        menu.deletion.as_mut().unwrap().pending = Some("stray".into());
        menu.apply_deletion_response("stray", Ok(serde_json::json!({"result":{"type":"worktree_removed", "workspace_id":"w4"}})));
        assert!(menu.error.as_ref().unwrap().starts_with("Unexpected daemon response"));
        // A refused lookup keeps the daemon's own code and message.
        menu.deletion.as_mut().unwrap().pending = Some("retry".into());
        menu.apply_deletion_response("retry", Ok(serde_json::json!({"error":{"code":"worktree_list_failed", "message":"not a repository"}})));
        assert_eq!(menu.error.as_deref(), Some("worktree_list_failed: not a repository"));
        menu.deletion.as_mut().unwrap().pending = Some("broken".into());
        menu.apply_deletion_response("broken", Err(std::sync::Arc::new(crate::Error::Client(herdr_client::Error::UnsupportedMethod))));
        assert_eq!(menu.error.as_deref(), Some("method not advertised by endpoint"));
        // A reply arriving after the menu closed changes nothing.
        menu.deletion = Some(Deletion::new(Some("late".into()), false));
        menu.reset();
        menu.apply_deletion_response("late", Err(std::sync::Arc::new(crate::Error::Client(herdr_client::Error::Disconnected))));
        assert!(menu.deletion.is_none());
        assert!(menu.error.is_none());
    });
}

/// Confirming a removal closes the popover, because the daemon drops the
/// workspace from its own snapshot when the removal lands. A refusal still
/// has to reach the user, and a dirty checkout arms the next dialog with
/// force instead of repeating the same refusal.
#[gpui::test]
fn queued_removal_closes_the_dialog_and_reports_refusals(cx: &mut gpui::TestAppContext) {
    let (view, cx) = cx.add_window_view(sidebar::layout_tests::fixture_window);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.live.status = crate::state::ConnectionStatus::Connected;
            let boot_id = view.live.snapshot.as_ref().unwrap().boot_id.clone();
            let endpoint = (
                view.selection_epoch,
                view.endpoints[view.selected_endpoint].generation,
            );
            let removal = move |pending: &str| super::super::Removal {
                endpoint,
                boot_id: boot_id.clone(),
                workspace: "w4".into(),
                pending: Some(pending.into()),
                force: false,
            };
            view.removal = Some(removal("remove"));
            // Another dialog's reply leaves the removal in flight.
            view.live.dialog_response = Some(("other".into(), Some(Ok(serde_json::json!({"result":{}})))));
            view.update_workspace_dialog(window, cx);
            assert!(view.removal.as_ref().unwrap().pending.is_some());
            view.live.dialog_response = Some(("remove".into(), Some(Ok(serde_json::json!({"error":{"code":"dirty_worktree_requires_force", "message":"modified or untracked files"}})))));
            view.update_workspace_dialog(window, cx);
            let refused = view.removal.as_ref().unwrap();
            assert!(refused.force && refused.pending.is_none());
            assert_eq!(view.local_error.as_deref(), Some("Remove worktree: dirty_worktree_requires_force: modified or untracked files"));
            view.open_workspace_menu("w4", Default::default(), window, cx);
            view.open_workspace_dialog(WorkspaceAction::DeleteWorktree, window, cx);
            assert!(view.menu.deletion.as_ref().unwrap().force);
            view.dismiss_menu(window, cx);
            // An accepted removal leaves nothing behind for the next dialog.
            view.removal = Some(super::super::Removal { force: true, ..removal("forced") });
            view.local_error = None;
            view.live.dialog_response = Some(("forced".into(), Some(Ok(serde_json::json!({"result":{"type":"worktree_removed", "workspace_id":"w4"}})))));
            view.update_workspace_dialog(window, cx);
            assert!(view.removal.is_none() && view.local_error.is_none());
            // A reply from a replaced connection is not this removal's.
            view.removal = Some(removal("stale"));
            view.endpoints[view.selected_endpoint].generation += 1;
            view.update_workspace_dialog(window, cx);
            assert!(view.removal.is_none());
        })
    });
}

#[gpui::test]
fn pending_removal_shows_loading_only_on_its_worktree(cx: &mut gpui::TestAppContext) {
    for state in 0..7 {
        let (view, cx) = cx.add_window_view(sidebar::layout_tests::fixture_window);
        cx.update(|window, cx| {
            view.update(cx, |view, cx| {
                view.live.status = crate::state::ConnectionStatus::Connected;
                view.removal = Some(super::super::Removal {
                    endpoint: (
                        view.selection_epoch,
                        view.endpoints[view.selected_endpoint].generation,
                    ),
                    boot_id: view.live.snapshot.as_ref().unwrap().boot_id.clone(),
                    workspace: "w4".into(),
                    pending: Some("remove".into()),
                    force: false,
                });
                match state {
                    1 => view.removal.as_mut().unwrap().pending = None,
                    2 => view.removal.as_mut().unwrap().boot_id = "stale".into(),
                    3 => view.removal.as_mut().unwrap().endpoint.1 += 1,
                    4 => {
                        view.live.dialog_response = Some((
                            "remove".into(),
                            Some(Ok(
                                serde_json::json!({"result":{"type":"worktree_removed"}}),
                            )),
                        ));
                        view.update_workspace_dialog(window, cx);
                    }
                    5 => view.live.status = crate::state::ConnectionStatus::Connecting,
                    6 => view.removal.as_mut().unwrap().endpoint.0 += 1,
                    _ => {}
                }
                cx.notify();
            });
        });
        cx.run_until_parked();
        let loading = cx.debug_bounds("worktree-removing");
        assert_eq!(loading.is_some(), state == 0);
        if let Some(loading) = loading {
            let row = cx.debug_bounds("row-sidebar-child").unwrap();
            assert!(row.contains(&loading.origin));
            assert!(loading.right() <= row.right() && loading.bottom() <= row.bottom());
        }
    }
}

/// The confirmation matches the Herdr TUI: one modal, no typed phrase. The
/// queued removal itself is exercised by the connected endpoint fixture.
#[gpui::test]
fn deletion_dialog_confirms_without_a_text_field(cx: &mut gpui::TestAppContext) {
    let (view, cx) = cx.add_window_view(sidebar::layout_tests::fixture_window);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.live.status = crate::state::ConnectionStatus::Connected;
            view.open_workspace_menu("w4", Default::default(), window, cx);
            view.open_workspace_dialog(WorkspaceAction::DeleteWorktree, window, cx);
            assert!(view.menu.input.is_none());
            view.menu.error = None;
            view.menu.deletion = Some(Deletion {
                path: Some("/daemon/checkout".into()),
                archive: ArchiveCheck::Read(None),
                ..Deletion::new(None, false)
            });
            cx.notify();
        })
    });
    cx.run_until_parked();
    assert!(cx.debug_bounds("dialog-input").is_none());
    assert!(cx.debug_bounds("dialog-error").is_none());
    // The daemon path reads as its own block above right-aligned actions,
    // all of it inside the panel rather than clipped by it.
    let panel = cx.debug_bounds("menu-panel").unwrap();
    let path = cx.debug_bounds("dialog-path").unwrap();
    let cancel = cx.debug_bounds("dialog-cancel").unwrap();
    let submit = cx.debug_bounds("dialog-submit").unwrap();
    assert!(panel.contains(&path.origin) && path.right() <= panel.right());
    assert!(path.bottom() <= cancel.top() && path.bottom() <= submit.top());
    assert_eq!(cancel.top(), submit.top());
    assert!(cancel.right() < submit.left());
    assert!(submit.right() <= panel.right());
    assert!(submit.bottom() <= panel.bottom());
}

#[gpui::test]
fn deletion_fails_closed_on_lookup_and_does_not_force_generic_errors(
    cx: &mut gpui::TestAppContext,
) {
    cx.update(|cx| {
        let snapshot = sidebar::layout_tests::snapshot(7);
        for response in [
            serde_json::json!({"result":{"type":"worktree_list", "worktrees":[]}}),
            serde_json::json!({"error":{"code":"worktree_remove_failed", "message":"is not a working tree"}}),
            serde_json::json!({"result":{"type":"unexpected"}}),
        ] {
            let mut menu = super::super::MenuState::new(cx);
            menu.target = Some(WorkspaceTarget::new(&snapshot, &snapshot.workspaces[4]));
            menu.deletion = Some(Deletion::new(Some("id".into()), false));
            menu.apply_deletion_response("id", Ok(response));
            assert!(menu.error.is_some());
            let deletion = menu.deletion.as_ref().unwrap();
            assert!(!deletion.force);
            assert!(!deletion.ready());
        }
    });
}
