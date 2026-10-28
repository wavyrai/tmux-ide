use super::*;

#[gpui::test]
fn close_dialog_blocks_submission_until_risks_are_explicitly_accepted(
    cx: &mut gpui::TestAppContext,
) {
    use super::super::workspace_close::{CloseCheck, Report};
    let (view, cx) = cx.add_window_view(sidebar::layout_tests::fixture_window);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.live.status = crate::state::ConnectionStatus::Connected;
            let snapshot = std::sync::Arc::make_mut(view.live.snapshot.as_mut().unwrap());
            snapshot.workspaces = sidebar::layout_tests::snapshot(7).workspaces;
            view.open_workspace_menu("w3", Default::default(), window, cx);
            view.menu.page = Some(super::super::Page::Dialog(WorkspaceAction::Close));
            // Missing or pending checks must block even a programmatic submission.
            view.submit_workspace_dialog(window, cx);
            assert!(view.menu.error.is_none());
            let snapshot = view.live.snapshot.as_ref().unwrap();
            let target = view.menu.target.as_ref().unwrap();
            view.menu.close_check = Some(CloseCheck::fixture(snapshot, target, None));
            view.submit_workspace_dialog(window, cx);
            assert!(view.menu.error.is_none());
            view.menu.close_check.as_mut().unwrap().report = Some(Report {
                dirty: true,
                unpushed: true,
                unknown: true,
            });
            view.menu.input = Some(DialogInput::new(String::new()));
            view.submit_workspace_dialog(window, cx);
            assert!(view.menu.error.is_none());
        });
        window.draw(cx).clear(cx);
    });
    let panel = cx.debug_bounds("menu-panel").unwrap();
    let warning = cx.debug_bounds("close-git-status").unwrap();
    let submit = cx.debug_bounds("dialog-submit").unwrap();
    assert!(panel.contains(&warning.origin));
    assert!(warning.bottom() <= submit.top());
    assert!(submit.bottom() <= panel.bottom());
    cx.simulate_keystrokes("enter");
    view.read_with(cx, |view, _| {
        assert!(view.menu.error.is_none());
        assert!(view.menu.page.is_some());
    });
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.menu.input = Some(DialogInput::new("close".into()));
            view.submit_workspace_dialog(window, cx);
            // Only after consent does submission reach the absent fixture connection.
            assert!(view.menu.error.is_some());
            view.dismiss_menu(window, cx);
            assert!(view.menu.close_check.is_none());
        })
    });
}

#[test]
fn stale_boot_target_and_changed_close_members_are_rejected() {
    let mut snapshot = sidebar::layout_tests::snapshot(7);
    let target = WorkspaceTarget::new(&snapshot, &snapshot.workspaces[3]);
    snapshot.boot_id = "replacement".into();
    for action in [
        WorkspaceAction::Rename,
        WorkspaceAction::Close,
        WorkspaceAction::NewWorktree,
    ] {
        assert!(target.request(&snapshot, action, "valid label").is_err());
    }
    snapshot.boot_id = target.boot_id.clone();
    snapshot.workspaces.swap(0, 6);
    assert!(
        target
            .request(&snapshot, WorkspaceAction::Close, "")
            .is_ok()
    );
    snapshot.workspaces.retain(|w| w.workspace_id != "w4");
    assert!(
        target
            .request(&snapshot, WorkspaceAction::Close, "")
            .is_err()
    );
    assert!(
        target
            .request(&snapshot, WorkspaceAction::Rename, "valid label")
            .is_ok()
    );
    snapshot.workspaces.retain(|w| w.workspace_id != "w3");
    assert!(
        target
            .request(&snapshot, WorkspaceAction::Rename, "valid label")
            .is_err()
    );
}

/// A parent beside another parent of its repository closes alone, as in the
/// TUI: a group close would take the other parent and its worktrees with it.
/// Each parent still folds the group while linked worktrees are open.
#[test]
fn a_parent_beside_another_parent_closes_alone_but_still_folds() {
    let mut snapshot = sidebar::layout_tests::snapshot(7);
    let mut duplicate = snapshot.workspaces[3].clone();
    duplicate.workspace_id = "w7".into();
    duplicate.focused = false;
    snapshot.workspaces.push(duplicate);
    for index in [3, 7] {
        let target = WorkspaceTarget::new(&snapshot, &snapshot.workspaces[index]);
        let id = &snapshot.workspaces[index].workspace_id;
        assert_eq!(target.close_label(), "Close");
        assert_eq!(target.close_members, std::slice::from_ref(id));
        assert_eq!(target.group_key(), Some(sidebar::layout_tests::REPO_KEY));
        assert_eq!(
            target
                .request(&snapshot, WorkspaceAction::Close, "")
                .unwrap(),
            (
                Method::WorkspaceClose,
                serde_json::json!({"workspace_id": id, "close_group": false})
            )
        );
    }
    // Opening the other parent after the menu did changes what closes.
    let target = WorkspaceTarget::new(&snapshot, &snapshot.workspaces[3]);
    let mut single = snapshot.clone();
    single.workspaces.pop();
    assert!(matches!(
        target.request(&single, WorkspaceAction::Close, ""),
        Err(crate::Error::WorkspaceGroupChanged)
    ));

    // Without linked worktrees there is no group to fold or close.
    snapshot
        .workspaces
        .retain(|w| w.workspace_id != "w4" && w.workspace_id != "w5");
    for index in [3, 5] {
        let target = WorkspaceTarget::new(&snapshot, &snapshot.workspaces[index]);
        assert_eq!(target.close_label(), "Close");
        assert_eq!(target.group_key(), None);
    }
}
