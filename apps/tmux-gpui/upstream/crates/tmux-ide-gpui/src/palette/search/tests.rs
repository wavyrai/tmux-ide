use super::*;
use crate::controls::Command;
use crate::palette::{Action, Entry};

fn entry(label: &str, detail: &str) -> Entry {
    Entry::new(
        label.into(),
        detail.into(),
        "",
        Action::Native(Command::Palette),
        None,
    )
}

fn ranked(labels: &[(&str, &str)], query: &str) -> Vec<Hit> {
    let entries: Vec<_> = labels
        .iter()
        .map(|(label, detail)| entry(label, detail))
        .collect();
    rank(
        &entries,
        0..entries.len(),
        &Query::parse(query),
        &mut matcher(),
    )
}

fn order(labels: &[&str], query: &str) -> Vec<usize> {
    let labels: Vec<_> = labels.iter().map(|label| (*label, "")).collect();
    ranked(&labels, query).iter().map(|hit| hit.index).collect()
}

#[test]
fn ranks_word_starts_and_contiguous_runs_above_scattered_letters() {
    assert_eq!(
        order(&["rebuilding", "Build project", "build"], "build"),
        // Equal scores fall back to the shorter name.
        [2, 1, 0]
    );
    assert_eq!(order(&["bxuxixlxd", "rebuilding"], "build"), [1, 0]);
    assert_eq!(order(&["Open Settings", "Close Tab"], "ost"), [0, 1]);
    assert!(order(&["missing"], "build").is_empty());
}

#[test]
fn names_outrank_context_and_every_term_must_match() {
    let hits = ranked(&[("other", "build"), ("build", "")], "build");
    assert_eq!(hits.iter().map(|hit| hit.index).collect::<Vec<_>>(), [1, 0]);
    assert!(ranked(&[("CAFÉ ΑΒ", "Box workspace /repo")], "café αβ box").len() == 1);
    assert!(ranked(&[("CAFÉ ΑΒ", "Box")], "CAFé").len() == 1);
    assert!(ranked(&[("CAFÉ ΑΒ", "Box")], "missing café").is_empty());
    assert_eq!(ranked(&[("anything", "")], " \n ").len(), 1);
}

#[test]
fn fuzzy_matching_does_not_join_name_with_context() {
    assert!(ranked(&[("ab", "cd")], "abcd").is_empty());
}

#[test]
fn fzf_syntax_negates_and_anchors_terms() {
    let labels = ["Split Right", "Split Down", "Close Split"];
    assert_eq!(order(&labels, "split !down"), [0, 2]);
    // Equal prefix scores fall back to the shorter name.
    assert_eq!(order(&labels, "^split"), [1, 0]);
    assert_eq!(order(&labels, "split$"), [2]);
    assert_eq!(order(&labels, "'lit"), [1, 0, 2]);
    assert!(order(&labels, "'spdn").is_empty());
}

#[test]
fn highlights_are_merged_byte_ranges_of_label_and_detail() {
    let hits = ranked(&[("Open Settings", "cmd-, ~/repo")], "opse repo");
    assert_eq!(hits[0].highlights.label, [0..2, 5..7]);
    assert_eq!(hits[0].highlights.detail, vec![8..12]);
    // Graphemes, not bytes or chars, index non-ASCII text.
    let hits = ranked(&[("e\u{301}t\u{e9} café", "")], "caf");
    let label = "e\u{301}t\u{e9} café";
    let text: Vec<_> = hits[0]
        .highlights
        .label
        .iter()
        .map(|range| &label[range.clone()])
        .collect();
    assert_eq!(text, ["caf"]);
}

#[test]
fn context_only_matches_do_not_highlight_badges_past_the_detail() {
    let entries = [Entry::new(
        "Claude".into(),
        "repo".into(),
        "waiting",
        Action::Native(Command::Palette),
        None,
    )];
    let hits = rank(&entries, [0], &Query::parse("waiting"), &mut matcher());
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].highlights, Highlights::default());
}

#[test]
fn query_and_haystack_are_bounded() {
    let query = Query::parse(&"a ".repeat(MAX_TERMS * 2));
    assert_eq!(query.0.atoms.len(), MAX_TERMS);
    let long = "x".repeat(MAX_QUERY_CHARS * 4);
    assert!(Query::parse(&long).0.atoms[0].needle_text().len() <= MAX_QUERY_CHARS);
    let label = format!("{}needle", "é".repeat(MAX_HAYSTACK_GRAPHEMES));
    assert!(ranked(&[(&label, "")], "needle").is_empty());
    assert_eq!(Fields::new(&label, "").name.len(), MAX_HAYSTACK_GRAPHEMES);
}

#[test]
fn nested_rows_indent_only_beneath_visible_parents() {
    let mut entries = vec![entry("repo", ""), entry("tab", ""), entry("pane", "")];
    entries[1].parent = Some(0);
    entries[2].parent = Some(1);
    let depths = |candidates: &[usize]| {
        rank(
            &entries,
            candidates.iter().copied(),
            &Query::parse(""),
            &mut matcher(),
        )
        .iter()
        .map(|hit| hit.depth)
        .collect::<Vec<_>>()
    };
    assert_eq!(depths(&[0, 1, 2]), [0, 1, 2]);
    assert_eq!(depths(&[0, 2]), [0, 0]);
    assert_eq!(depths(&[1, 2]), [0, 1]);
}
