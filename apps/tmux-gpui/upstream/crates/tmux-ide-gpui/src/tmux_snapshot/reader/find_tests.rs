#![allow(clippy::unwrap_used)]
use super::*;
use bezel_markdown::{Cursor, Part};

#[test]
fn matches_are_case_insensitive_across_blocks_and_parts() {
    let doc = bezel_markdown::parse(
        "# Changes\n\nReload when the file changes on disk.\n\n| a | b |\n|---|---|\n| CHANGES | x |\n\n```\n# changes need opt-in\n```\n",
    );
    let found = matches(&doc, "changes");
    assert_eq!(found.len(), 4);
    let first = found[0].ordered();
    assert_eq!(first.0, Cursor::new(0, Part::Body, 0));
    assert_eq!(first.1, Cursor::new(0, Part::Body, 7));
}

#[test]
fn offsets_stay_on_char_boundaries_for_wide_text() {
    let doc = bezel_markdown::parse("Ünïcödé ÜNÏ and ünï\n");
    let found = matches(&doc, "ünï");
    assert_eq!(found.len(), 3);
    let text = &doc.blocks[0].text_at(Part::Body).unwrap().text;
    for selection in &found {
        let (start, end) = selection.ordered();
        assert!(text.is_char_boundary(start.offset) && text.is_char_boundary(end.offset));
    }
}

#[test]
fn an_empty_query_finds_nothing_and_counts_are_bounded() {
    let doc = bezel_markdown::parse(&"a ".repeat(5000));
    assert!(matches(&doc, "").is_empty());
    assert_eq!(matches(&doc, "a").len(), MAX_MATCHES);
}

#[test]
fn stepping_wraps_both_ways() {
    assert_eq!(step(None, 3, true), Some(0));
    assert_eq!(step(None, 3, false), Some(2));
    assert_eq!(step(Some(2), 3, true), Some(0));
    assert_eq!(step(Some(0), 3, false), Some(2));
    assert_eq!(step(Some(1), 3, true), Some(2));
    assert_eq!(step(Some(0), 0, true), None);
}

#[test]
fn the_count_reads_like_the_mockup() {
    assert_eq!(count_label(Some(0), 3), "1 of 3");
    assert_eq!(count_label(None, 0), "No matches");
    assert_eq!(count_label(None, MAX_MATCHES), format!("{MAX_MATCHES}+"));
}
