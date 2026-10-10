#![allow(clippy::unwrap_used)]

use super::*;
use crate::review::diff::Diff;

/// A hunk header (0), an unchanged line (1), a removed line (2), the added
/// line that replaced it (3), and another added line (4).
fn lines() -> std::sync::Arc<Lines> {
    let diff = Diff::parse(
        "diff --git a/src/lib.rs b/src/lib.rs\n--- a/src/lib.rs\n+++ b/src/lib.rs\n@@ -1,2 +1,3 @@\n fn a() {}\n-fn b() {}\n+fn b() { todo!() }\n+fn c() {}\n",
    );
    diff.files[0].lines().unwrap().clone()
}

fn caret(line: usize, offset: usize) -> Caret {
    Caret { line, offset }
}

fn selection(side: Numbers, anchor: Caret, head: Caret) -> Selection {
    Selection {
        file: 0,
        side,
        anchor,
        head,
    }
}

#[test]
fn copies_code_alone_across_lines_in_either_direction() {
    let lines = lines();
    // From inside the unchanged line to inside the first added one, as a
    // unified diff reads them: the removed line in between comes along,
    // but no hunk header, number, or sign.
    let forward = selection(Numbers::Both, caret(1, 3), caret(3, 5));
    assert_eq!(forward.text(&lines), "a() {}\nfn b() {}\nfn b(");
    let backward = selection(Numbers::Both, caret(3, 5), caret(1, 3));
    assert_eq!(backward.text(&lines), forward.text(&lines));
    // From the hunk header itself, the header is still left out.
    let from_header = selection(Numbers::Both, caret(0, 0), caret(1, 2));
    assert_eq!(from_header.text(&lines), "fn");
}

#[test]
fn a_side_by_side_selection_keeps_to_its_side() {
    let lines = lines();
    let new = selection(Numbers::New, caret(1, 0), caret(4, 10));
    assert_eq!(new.text(&lines), "fn a() {}\nfn b() { todo!() }\nfn c() {}");
    let old = selection(Numbers::Old, caret(1, 0), caret(4, 10));
    assert_eq!(old.text(&lines), "fn a() {}\nfn b() {}");
    // A cell on the other side, or in another file, shows no tint.
    let text = lines.text(2);
    assert_eq!(new.highlight(0, Numbers::Old, 2, text), None);
    assert_eq!(old.highlight(0, Numbers::Old, 2, text), Some(0..text.len()));
    assert_eq!(old.highlight(1, Numbers::Old, 2, text), None);
}

#[test]
fn highlights_stay_on_character_boundaries() {
    let text = "let é = 1;";
    let inside = selection(Numbers::Both, caret(1, 4), caret(1, 6));
    // `é` is bytes 4..6; an offset inside it, 5, rounds down to its start.
    assert_eq!(inside.highlight(0, Numbers::Both, 1, text), Some(4..6));
    let split = selection(Numbers::Both, caret(1, 5), caret(1, 7));
    assert_eq!(split.highlight(0, Numbers::Both, 1, text), Some(4..7));
    let empty = selection(Numbers::Both, caret(1, 3), caret(1, 3));
    assert!(empty.is_empty());
    assert_eq!(empty.highlight(0, Numbers::Both, 1, text), None);
}

#[test]
fn words_are_letters_digits_and_underscores() {
    let text = "let snake_case2 = x.y;";
    assert_eq!(word_at(text, 6), 4..15);
    assert_eq!(word_at(text, 4), 4..15);
    assert_eq!(word_at(text, 15), 15..16, "a space alone");
    assert_eq!(word_at(text, 19), 19..20, "punctuation alone");
    assert_eq!(word_at(text, 99), text.len()..text.len());
    assert_eq!(word_at("été", 2), 0..5);
}

#[test]
fn select_all_spans_the_side_s_first_to_last_line() {
    let lines = lines();
    let all = Selection::all(0, Numbers::Old, &lines).unwrap();
    assert_eq!((all.anchor, all.head), (caret(1, 0), caret(2, 9)));
    assert_eq!(all.text(&lines), "fn a() {}\nfn b() {}");
    let all = Selection::all(0, Numbers::Both, &lines).unwrap();
    assert_eq!(
        all.text(&lines),
        "fn a() {}\nfn b() {}\nfn b() { todo!() }\nfn c() {}"
    );
}

#[test]
fn a_hunk_copies_as_a_patch_reads() {
    let lines = lines();
    assert_eq!(
        hunk_text(&lines, 0),
        "@@ -1,2 +1,3 @@\n fn a() {}\n-fn b() {}\n+fn b() { todo!() }\n+fn c() {}"
    );
}
