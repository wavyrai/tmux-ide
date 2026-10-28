use super::*;

#[test]
fn rename_trims_unicode_whitespace_and_rejects_blank_labels() {
    let snapshot = sidebar::layout_tests::snapshot(7);
    let target = WorkspaceTarget::new(&snapshot, &snapshot.workspaces[3]);
    for text in ["", " \t\r\n", "\u{2003}\u{3000}"] {
        assert!(matches!(
            target.request(&snapshot, WorkspaceAction::Rename, text),
            Err(crate::Error::EmptyWorkspaceLabel)
        ));
    }
    assert_eq!(
        target
            .request(
                &snapshot,
                WorkspaceAction::Rename,
                " \u{3000}new label\u{2003} "
            )
            .unwrap(),
        (
            Method::WorkspaceRename,
            serde_json::json!({"workspace_id": "w3", "label": "new label"})
        )
    );
}

#[test]
fn new_tab_and_workspace_names_follow_herdr() {
    use super::super::workspace::chosen_label;
    let mut snapshot = sidebar::layout_tests::snapshot(7);
    let target = WorkspaceTarget::new(&snapshot, &snapshot.workspaces[3]);
    assert_eq!(
        target
            .request(&snapshot, WorkspaceAction::NewTab, "ignored")
            .unwrap(),
        (
            Method::TabCreate,
            serde_json::json!({"workspace_id": "w3", "focus": true})
        )
    );
    assert_eq!(
        target
            .request(&snapshot, WorkspaceAction::NewWorkspace, "ignored")
            .unwrap(),
        (
            Method::WorkspaceCreate,
            serde_json::json!({"focus": true, "source_workspace_id": "w3"})
        )
    );
    // A proposal left alone, or cleared, lets the daemon choose the name.
    assert_eq!(chosen_label("  Build  ", Some("2")), Some("Build"));
    assert_eq!(chosen_label(" 2 ", Some("2")), None);
    assert_eq!(chosen_label(" \t", Some("2")), None);
    assert_eq!(chosen_label("2", None), Some("2"));
    snapshot.workspaces.retain(|w| w.workspace_id != "w3");
    assert!(matches!(
        target.request(&snapshot, WorkspaceAction::NewTab, ""),
        Err(crate::Error::StaleWorkspace)
    ));
}

#[test]
fn proposed_names_match_herdr_without_touching_the_daemon_host() {
    use super::super::workspace::{suggested_tab_name, suggested_workspace_name};
    let snapshot = sidebar::layout_tests::snapshot(7);
    let tabs = snapshot
        .tabs
        .iter()
        .filter(|tab| tab.workspace_id == "w3")
        .count();
    assert_eq!(suggested_tab_name(&snapshot, "w3"), (tabs + 1).to_string());
    assert_eq!(suggested_tab_name(&snapshot, "missing"), "1");
    assert_eq!(suggested_workspace_name("/home/me/code/herdr"), "herdr");
    assert_eq!(suggested_workspace_name("/home/me/code/herdr/"), "herdr");
    assert_eq!(suggested_workspace_name("/"), "/");
    assert_eq!(suggested_workspace_name(""), "workspace");
}
