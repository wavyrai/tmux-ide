#![allow(clippy::unwrap_used)]
use super::*;
use crate::review::diff::Diff;
use core::prelude::v1::test;

/// Every line of the diff's first file with its spans, coloured a stretch
/// at a time as the view colours them.
fn coloured(diff: &Diff) -> Vec<(String, Kind, Vec<Span>)> {
    let file = &diff.files[0];
    let lines = file.lines().unwrap();
    let mut spans = vec![Vec::new(); lines.len()];
    let mut line = 0;
    while line < lines.len() {
        let range = lines.stretch(line);
        line = range.end.max(line + 1);
        for (index, coloured) in range.clone().zip(colour(&file.path, lines, range)) {
            spans[index] = coloured;
        }
    }
    lines
        .iter()
        .zip(spans)
        .map(|(line, spans)| (lines.text_of(line).to_owned(), line.kind, spans))
        .collect()
}

fn tokens(lines: &[(String, Kind, Vec<Span>)], text: &str) -> Vec<(String, Token)> {
    let (text, _, spans) = lines.iter().find(|(line, _, _)| line == text).unwrap();
    spans
        .iter()
        .map(|span| (text[span.start..span.end].to_owned(), span.token))
        .collect()
}

#[test]
fn rust_lines_are_coloured_by_what_they_are_on_their_own_side() {
    let diff = Diff::parse(
        "diff --git a/src/lib.rs b/src/lib.rs
--- a/src/lib.rs
+++ b/src/lib.rs
@@ -1,3 +1,3 @@
 /// Docs.
-fn old() -> u32 { 1 }
+fn new() -> &'static str { \"two\" }
 // done
",
    );
    let lines = coloured(&diff);
    let added = tokens(&lines, "fn new() -> &'static str { \"two\" }");
    assert!(added.contains(&("fn".into(), Token::Keyword)), "{added:?}");
    assert!(
        added.contains(&("new".into(), Token::Function)),
        "{added:?}"
    );
    assert!(
        added
            .iter()
            .any(|(text, token)| text.contains("two") && *token == Token::String),
        "{added:?}"
    );
    let removed = tokens(&lines, "fn old() -> u32 { 1 }");
    assert!(
        removed.contains(&("1".into(), Token::Number)),
        "{removed:?}"
    );
    assert!(
        removed.contains(&("u32".into(), Token::Type)),
        "{removed:?}"
    );
    assert_eq!(
        tokens(&lines, "// done"),
        [("// done".into(), Token::Comment)]
    );
    // Spans never reach past the text, and headers stay plain.
    for (text, kind, spans) in &lines {
        assert!(
            spans
                .iter()
                .all(|span| span.start < span.end && span.end <= text.len())
        );
        if *kind == Kind::Hunk {
            assert!(spans.is_empty());
        }
    }
}

#[test]
fn a_comment_opened_in_one_hunk_does_not_colour_the_next() {
    let diff = Diff::parse(
        "diff --git a/a.c b/a.c
--- a/a.c
+++ b/a.c
@@ -1,1 +1,1 @@
-/* unterminated
@@ -9,1 +9,1 @@
+int x = 1;
",
    );
    let next = tokens(&coloured(&diff), "int x = 1;");
    assert!(next.contains(&("int".into(), Token::Type)), "{next:?}");
    assert!(
        !next.iter().any(|(_, token)| *token == Token::Comment),
        "{next:?}"
    );
}

#[test]
fn files_without_a_known_grammar_stay_plain() {
    let mut diff = Diff::default();
    diff.add_untracked("notes.unknownext", "fn main() {}\n");
    assert!(coloured(&diff).iter().all(|(_, _, spans)| spans.is_empty()));
}

#[test]
fn a_long_new_file_is_coloured_in_stretches_that_read_on_across_seams() {
    // A block comment opened shortly before the seam still colours past it.
    let text = format!(
        "{}/*\n{}*/\nfn after() {{}}\n",
        "x;\n".repeat(300),
        "comment\n".repeat(150)
    );
    let mut diff = Diff::default();
    diff.add_untracked("long.rs", &text);
    let lines = diff.files[0].lines().unwrap();
    assert_eq!(lines.stretch(1), 1..401);
    assert_eq!(lines.stretch(401), 401..lines.len());
    let coloured = coloured(&diff);
    let (_, _, spans) = &coloured[420];
    assert!(spans.iter().any(|span| span.token == Token::Comment));
}

#[test]
fn only_the_start_of_a_very_long_line_is_coloured() {
    let mut diff = Diff::default();
    let long = format!("let x = \"{}\";", "a".repeat(10_000));
    diff.add_untracked("long.rs", &long);
    let lines = coloured(&diff);
    let (_, _, spans) = &lines[1];
    assert!(!spans.is_empty());
    assert!(spans.iter().all(|span| span.end <= MAX_COLOURED_BYTES));
}
