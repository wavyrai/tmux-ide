use super::*;

#[gpui::test]
fn reset_drops_target_draft_composition_and_error(cx: &mut gpui::TestAppContext) {
    cx.update(|cx| {
        let snapshot = sidebar::layout_tests::snapshot(7);
        let mut menu = super::super::MenuState::new(cx);
        menu.target = Some(WorkspaceTarget::new(&snapshot, &snapshot.workspaces[3]));
        menu.page = Some(super::super::Page::Dialog(WorkspaceAction::Rename));
        let mut input = DialogInput::new("draft".into());
        input.replace(None, "composition", true, None);
        menu.input = Some(input);
        menu.error = Some("old connection error".into());
        menu.reset();
        assert!(menu.page.is_none());
        assert!(menu.target.is_none());
        assert!(menu.input.is_none());
        assert!(menu.error.is_none());
    });
}

#[test]
fn actions_target_clicked_workspace_and_match_daemon_schemas() {
    let mut snapshot = sidebar::layout_tests::snapshot(7);
    snapshot.workspaces[0].branch = None;
    let target = WorkspaceTarget::new(&snapshot, &snapshot.workspaces[3]);
    assert!(target.can_create());
    assert_eq!(target.close_label(), "Close group");
    assert_eq!(target.close_members, ["w3", "w4", "w5"]);
    assert_eq!(
        target
            .request(&snapshot, WorkspaceAction::Rename, "new label")
            .unwrap(),
        (
            Method::WorkspaceRename,
            serde_json::json!({"workspace_id": "w3", "label": "new label"})
        )
    );
    assert_eq!(
        target
            .request(&snapshot, WorkspaceAction::Close, "")
            .unwrap(),
        (
            Method::WorkspaceClose,
            serde_json::json!({"workspace_id": "w3", "close_group": true})
        )
    );
    for branch in ["", "  ", " feature/test "] {
        let (method, params) = target
            .request(&snapshot, WorkspaceAction::NewWorktree, branch)
            .unwrap();
        assert_eq!(method, Method::WorktreeCreate);
        let mut expected = serde_json::json!({"workspace_id": "w3", "base": "HEAD", "focus": true, "trust_repository": false});
        if !branch.trim().is_empty() {
            expected["branch"] = branch.trim().into();
        }
        assert_eq!(params, expected);
    }
    assert!(matches!(
        target.request(&snapshot, WorkspaceAction::NewWorktree, "config reload"),
        Err(crate::Error::InvalidBranchName)
    ));
    for index in [0, 4, 5] {
        let target = WorkspaceTarget::new(&snapshot, &snapshot.workspaces[index]);
        assert_eq!(target.close_label(), "Close");
        assert_eq!(target.close_members.len(), 1);
        assert!(!target.can_create());
        assert!(
            target
                .request(&snapshot, WorkspaceAction::NewWorktree, "")
                .is_err()
        );
    }
    let mut standalone = snapshot.clone();
    standalone
        .workspaces
        .retain(|w| w.workspace_id != "w4" && w.workspace_id != "w5");
    let target = WorkspaceTarget::new(&standalone, &standalone.workspaces[3]);
    assert!(target.can_create());
    assert_eq!(target.close_label(), "Close");
}
