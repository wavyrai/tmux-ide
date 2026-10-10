//! The words that changed within a changed line.
use super::*;

fn words(text: &str, ranges: &[Range<u32>]) -> Vec<String> {
    ranges
        .iter()
        .map(|range| text[range.start as usize..range.end as usize].to_owned())
        .collect()
}

#[test]
fn an_edited_line_marks_only_the_words_that_changed() {
    let diff = Diff::parse(
        "diff --git a/a.rs b/a.rs
--- a/a.rs
+++ b/a.rs
@@ -1,3 +1,3 @@
-let total = price * count;
+let total = price * amount;
-fn wholly() {}
+struct Different;
 same
",
    );
    let lines = diff.files[0].lines().unwrap();
    let emphasis = emphasis(lines, 1..lines.len());
    // Each removal is paired with the addition after it.
    assert_eq!(words(lines.text(1), &emphasis[0]), ["count"]);
    assert_eq!(words(lines.text(2), &emphasis[1]), ["amount"]);
    // Lines with little in common are not an edit: nothing is marked.
    assert!(emphasis[2].is_empty());
    assert!(emphasis[3].is_empty());
    assert!(emphasis[4].is_empty());
}

#[test]
fn a_long_replacement_marks_each_line_against_its_own_replacement() {
    // 500 lines replaced: line 1 is replaced by line 501, in another
    // colouring stretch, and each stretch still finds its partners.
    let removed: String = (0..500)
        .map(|line| format!("-let a{line} = old;\n"))
        .collect();
    let added: String = (0..500)
        .map(|line| format!("+let a{line} = new;\n"))
        .collect();
    let diff = Diff::parse(&format!(
        "diff --git a/a.rs b/a.rs\n--- a/a.rs\n+++ b/a.rs\n@@ -1,500 +1,500 @@\n{removed}{added}"
    ));
    let lines = diff.files[0].lines().unwrap();
    assert_eq!(lines.partner(1), Some(501));
    assert_eq!(lines.partner(501), Some(1));
    let first = emphasis(lines, lines.stretch(1));
    assert_eq!(words(lines.text(1), &first[0]), ["old"]);
    let second = emphasis(lines, lines.stretch(501));
    let at = 501 - lines.stretch(501).start;
    assert_eq!(words(lines.text(501), &second[at]), ["new"]);
    // The middle stretch pairs each line with its own partner too.
    let middle = emphasis(lines, lines.stretch(450));
    let at = 450 - lines.stretch(450).start;
    assert_eq!(lines.text(450), "let a449 = old;");
    assert_eq!(words(lines.text(450), &middle[at]), ["old"]);
}
