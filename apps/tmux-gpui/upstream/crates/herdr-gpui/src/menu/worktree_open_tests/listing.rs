use super::*;

#[gpui::test]
fn open_worktree_listing_is_correlated_atomic_bounded_and_fallible(cx: &mut TestAppContext) {
    cx.update(|cx| {
        let mut menu = MenuState::new(cx);
        pending(&mut menu, cx);
        menu.apply_worktree_list_response("other", Ok(listing()));
        assert!(menu.worktree_open.as_ref().unwrap().entries.is_empty());
        assert!(menu.worktree_open.as_ref().unwrap().pending.is_some());
        menu.apply_worktree_list_response("list", Ok(listing()));
        let picker = menu.worktree_open.as_ref().unwrap();
        assert_eq!(picker.entries.len(), 2);
        assert_eq!(picker.entries[1].path, "/remote/checkout with spaces ");
        assert!(picker.pending.is_none());
        let mut malformed = listing();
        malformed["result"]["worktrees"][1]["is_bare"] = json!("false");
        let mut duplicate = listing();
        duplicate["result"]["worktrees"][1]["path"] = json!("/remote/repo");
        let mut oversized = listing();
        oversized["result"]["worktrees"] =
            json!(vec![listing()["result"]["worktrees"][0].clone(); 513]);
        let mut long_path = listing();
        long_path["result"]["worktrees"][0]["path"] = json!("x".repeat(8193));
        let mut missing_source = listing();
        missing_source["result"]["source"] = Value::Null;
        let mut empty_source_key = listing();
        empty_source_key["result"]["source"]["repo_key"] = json!("");
        let mut oversized_source = listing();
        oversized_source["result"]["source"]["repo_key"] = json!("x".repeat(8193));
        for response in [
            malformed,
            duplicate,
            oversized,
            long_path,
            missing_source,
            empty_source_key,
            oversized_source,
            json!({}),
            json!({"result":{"type":"worktree_list","worktrees":[{}]}}),
            json!({"error":{"code":"denied","message":"repository is untrusted"}}),
        ] {
            pending(&mut menu, cx);
            menu.apply_worktree_list_response("list", Ok(response));
            assert!(menu.error.is_some());
            let picker = menu.worktree_open.as_ref().unwrap();
            assert!(picker.entries.is_empty() && picker.pending.is_none());
        }
        pending(&mut menu, cx);
        menu.apply_worktree_list_response(
            "list",
            Err(std::sync::Arc::new(crate::Error::Client(
                herdr_client::Error::UnsupportedMethod,
            ))),
        );
        assert_eq!(
            menu.error.as_deref(),
            Some("method not advertised by endpoint")
        );
        pending(&mut menu, cx);
        menu.apply_worktree_list_response(
            "list",
            Ok(json!({"result":{"type":"worktree_list","source":listing()["result"]["source"],"worktrees":[]}})),
        );
        assert!(menu.error.is_none());
        assert!(menu.worktree_open.as_ref().unwrap().entries.is_empty());
        pending(&mut menu, cx);
        menu.reset();
        menu.apply_worktree_list_response("list", Ok(listing()));
        assert!(menu.worktree_open.is_none() && menu.error.is_none());
    });
}

#[test]
fn open_worktree_targets_parent_and_keeps_exact_daemon_path() {
    let mut snapshot = snapshot(7);
    snapshot.workspaces[3].worktree = None;
    let target = WorkspaceTarget::new(&snapshot, &snapshot.workspaces[3]);
    let path = "/remote/checkout with spaces ";
    assert_eq!(
        target
            .request(&snapshot, WorkspaceAction::OpenWorktree, path)
            .unwrap(),
        (
            herdr_client::Method::WorktreeOpen,
            json!({"workspace_id":"w3","path":path,"focus":true,"trust_repository":false})
        )
    );
    assert!(
        target
            .request(&snapshot, WorkspaceAction::OpenWorktree, "")
            .is_err()
    );
    assert!(
        WorkspaceTarget::new(&snapshot, &snapshot.workspaces[4])
            .request(&snapshot, WorkspaceAction::OpenWorktree, path)
            .is_err()
    );
    snapshot.workspaces[3].branch = None;
    assert!(
        target
            .request(&snapshot, WorkspaceAction::OpenWorktree, path)
            .is_err()
    );
}
