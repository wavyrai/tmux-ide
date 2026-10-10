#![allow(clippy::unwrap_used)]
use super::*;

fn diff(paths: &[&str]) -> Diff {
    let mut diff = Diff::default();
    for path in paths {
        diff.add_untracked(path, "x\n");
    }
    diff
}

fn labels(tree: &Tree, shown: &[usize]) -> Vec<String> {
    shown
        .iter()
        .map(|&index| match &tree.nodes[index] {
            Node::Folder { label, depth, .. } => format!("{}{label}", "  ".repeat(*depth)),
            Node::File { file, depth } => format!("{}#{file}", "  ".repeat(*depth)),
        })
        .collect()
}

#[test]
fn folders_nest_and_single_child_chains_share_a_line() {
    let tree = Tree::build(&diff(&[
        "README.md",
        "crates/app/src/main.rs",
        "crates/app/src/view/rows.rs",
        "crates/lib/a.rs",
        "z.txt",
    ]));
    let all = tree.shown(&HashSet::new(), false, |_| true);
    assert_eq!(
        labels(&tree, &all),
        [
            "#0",
            "crates/",
            "  app/src/",
            "    #1",
            "    view/",
            "      #2",
            "  lib/",
            "    #3",
            "#4",
        ]
    );
    // Top to bottom, the files are the diff's order.
    let files: Vec<usize> = tree
        .nodes
        .iter()
        .filter_map(|node| match node {
            Node::File { file, .. } => Some(*file),
            Node::Folder { .. } => None,
        })
        .collect();
    assert_eq!(files, [0, 1, 2, 3, 4]);
}

#[test]
fn closed_folders_hide_their_files_and_filters_keep_matches_with_their_folders() {
    let tree = Tree::build(&diff(&["a/one.rs", "a/two.rs", "b/three.rs", "top.rs"]));
    let closed: HashSet<String> = ["a/".to_owned()].into();
    assert_eq!(
        labels(&tree, &tree.shown(&closed, false, |_| true)),
        ["a/", "b/", "  #2", "#3"]
    );
    // A filter opens closed folders and drops folders with no match.
    assert_eq!(
        labels(&tree, &tree.shown(&closed, true, |file| file == 1)),
        ["a/", "  #1"]
    );
    // Hiding files hides a folder left empty.
    assert_eq!(
        labels(&tree, &tree.shown(&HashSet::new(), false, |file| file != 2)),
        ["a/", "  #0", "  #1", "#3"]
    );
}
