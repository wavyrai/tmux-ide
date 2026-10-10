use super::*;

#[test]
fn hierarchy_uses_git_metadata_and_emits_each_workspace_once() {
    let mut workspaces = layout_tests::snapshot(7).workspaces;
    for workspace in &mut workspaces {
        workspace.worktree = None;
        workspace.label = "same label".into();
        workspace.branch = Some("main".into());
    }
    for (index, key, linked) in [
        (0, "/repo/.git", true),
        (2, "/repo/.git", false),
        (3, "/orphan/.git", true),
        (4, "/repo/.git", true),
        (5, "/other/.git", false),
        (6, "/orphan/.git", true),
    ] {
        workspaces[index].worktree = Some(herdr_client::protocol::ClientShellWorktree {
            key: key.into(),
            label: "same repo name".into(),
            is_linked_worktree: linked,
        });
    }
    workspaces[2].branch = Some("develop".into());
    assert_eq!(
        workspace_entries(&workspaces),
        vec![
            (2, false),
            (0, true),
            (4, true),
            (1, false),
            (3, false),
            (5, false),
            (6, false),
        ]
    );
    workspaces[2].worktree = None;
    assert_eq!(
        workspace_entries(&workspaces),
        (0..7).map(|i| (i, false)).collect::<Vec<_>>()
    );
    assert!(workspace_entries(&[]).is_empty());
}

fn worktree(key: &str, linked: bool) -> Option<herdr_client::protocol::ClientShellWorktree> {
    Some(herdr_client::protocol::ClientShellWorktree {
        key: key.into(),
        label: "repo".into(),
        is_linked_worktree: linked,
    })
}

/// Like the TUI, every checkout that is not a linked worktree is a parent:
/// two plain checkouts of one repository never nest, and only a linked
/// worktree turns a repository into a group.
#[test]
fn every_plain_checkout_is_a_parent_and_only_linked_worktrees_form_groups() {
    let mut workspaces = layout_tests::snapshot(6).workspaces;
    for workspace in &mut workspaces {
        workspace.worktree = None;
    }
    workspaces[0].worktree = worktree("/repo/.git", false);
    workspaces[2].worktree = worktree("/repo/.git", false);
    workspaces[4].worktree = worktree("/repo/.git", false);
    let flat: Vec<_> = (0..6).map(|i| (i, false)).collect();
    assert_eq!(workspace_entries(&workspaces), flat);
    let none = std::collections::HashSet::new();
    assert!(
        super::super::visible_workspace_entries(&workspaces, &none)
            .iter()
            .all(|entry| entry.2.is_none())
    );

    workspaces[5].worktree = worktree("/repo/.git", true);
    assert_eq!(
        workspace_entries(&workspaces),
        vec![
            (0, false),
            (2, false),
            (4, false),
            (5, true),
            (1, false),
            (3, false)
        ]
    );
    // Each parent folds the group; folding hides only linked worktrees.
    for collapsed in [none.clone(), ["/repo/.git".to_owned()].into()] {
        let entries = super::super::visible_workspace_entries(&workspaces, &collapsed);
        let groups: Vec<_> = entries
            .iter()
            .filter(|entry| entry.2.as_deref() == Some("/repo/.git"))
            .map(|entry| entry.0)
            .collect();
        assert_eq!(groups, [0, 2, 4]);
        assert_eq!(
            entries.iter().any(|entry| entry.0 == 5),
            collapsed.is_empty()
        );
        assert_eq!(entries.len(), 5 + usize::from(collapsed.is_empty()));
    }
}

/// The daemon keeps an unavailable checkout's saved repository membership
/// across a restart (Herdr #4770). The sidebar groups from that membership
/// alone, so a checkout without a branch or a reachable directory stays in
/// its group, under any parent of its repository.
#[test]
fn unavailable_checkouts_keep_their_saved_group() {
    let mut workspaces = layout_tests::snapshot(7).workspaces;
    for index in [4, 5] {
        workspaces[index].branch = None;
        workspaces[index].new_workspace_cwd = "/missing/checkout".into();
    }
    let expected = vec![
        (0, false),
        (1, false),
        (2, false),
        (3, false),
        (4, true),
        (5, true),
        (6, false),
    ];
    assert_eq!(workspace_entries(&workspaces), expected);
    assert_eq!(workspace_label(&workspaces[4], true), "agent-launcher");
    // An unavailable parent is still a parent.
    workspaces[3].branch = None;
    workspaces[3].new_workspace_cwd = "/missing/main".into();
    assert_eq!(workspace_entries(&workspaces), expected);
    // Without any parent open, restored linked worktrees stand alone.
    workspaces[3].worktree = None;
    assert_eq!(
        workspace_entries(&workspaces),
        (0..7).map(|i| (i, false)).collect::<Vec<_>>()
    );
}

#[test]
fn collapse_uses_repository_identity_without_mutating_selection() {
    let mut workspaces = layout_tests::snapshot(7).workspaces;
    workspaces[4].focused = true;
    let before = workspaces.clone();
    let collapsed = std::collections::HashSet::from([layout_tests::REPO_KEY.into()]);
    let entries = super::super::visible_workspace_entries(&workspaces, &collapsed);
    assert_eq!(
        entries.iter().map(|entry| entry.0).collect::<Vec<_>>(),
        vec![0, 1, 2, 3, 6]
    );
    assert_eq!(entries.iter().filter(|entry| entry.2.is_some()).count(), 1);
    assert_eq!(workspaces, before);
    workspaces[3].label = "renamed".into();
    assert_eq!(
        super::super::visible_workspace_entries(&workspaces, &collapsed).len(),
        5
    );
    workspaces.remove(5);
    workspaces.remove(4);
    assert!(
        super::super::visible_workspace_entries(&workspaces, &collapsed)
            .iter()
            .all(|entry| entry.2.is_none())
    );
    workspaces.remove(3);
    assert_eq!(
        super::super::visible_workspace_entries(&workspaces, &collapsed).len(),
        4
    );
}

#[test]
fn child_labels_follow_upstream_custom_label_and_branch_rules() {
    let mut workspace = layout_tests::snapshot(1).workspaces.remove(0);
    workspace.branch = Some("worktree/fix-sidebar".into());
    assert_eq!(workspace_label(&workspace, true), "fix-sidebar");
    assert_eq!(workspace_label(&workspace, false), "herdr");
    workspace.custom_label = true;
    assert_eq!(workspace_label(&workspace, true), "herdr");
    workspace.custom_label = false;
    workspace.branch = None;
    assert_eq!(workspace_label(&workspace, true), "herdr");
}
