#![allow(clippy::unwrap_used)]
use super::*;

fn at(side: Side, number: u32, code: &str) -> Anchor {
    Anchor::Line {
        path: "src/lib.rs".into(),
        side,
        number,
        code: code.into(),
        before: (side == Side::Removed).then(|| "HEAD".into()),
    }
}

#[test]
fn the_prompt_places_and_quotes_each_note() {
    let notes = [
        Note::new(
            at(Side::Added, 42, "  let x = `y`;"),
            "Use a constant\nhere",
        )
        .unwrap(),
        Note::new(at(Side::Removed, 7, "keep_me();"), "Why was this removed?").unwrap(),
        Note::new(
            Anchor::File {
                path: "README.md".into(),
            },
            "Document the flag",
        )
        .unwrap(),
    ];
    let text = prompt("/work/repo", &notes);
    assert!(text.starts_with("Review notes on your changes in /work/repo, from Herdr GPUI.\n"));
    assert!(text.contains(
        "\n1. On `src/lib.rs:42` (added line)\n   Code: `` let x = `y`; ``\n   Note: Use a constant here\n"
    ));
    assert!(text.contains(
        "\n2. On `src/lib.rs:7` (removed line, numbered as in HEAD)\n   Code: `keep_me();`\n"
    ));
    // A branch review names the base the removed line counts in.
    let branch = Note::new(
        Anchor::Line {
            path: "src/lib.rs".into(),
            side: Side::Removed,
            number: 3,
            code: "old();".into(),
            before: Some("origin/main at 1a2b3c4".into()),
        },
        "Keep it",
    )
    .unwrap();
    assert!(
        prompt("/work/repo", &[branch])
            .contains("(removed line, numbered as in origin/main at 1a2b3c4)")
    );
    assert!(text.contains("\n3. On `README.md` as a whole\n   Note: Document the flag\n"));
    assert!(text.ends_with("Address each note in the working tree.\n"));
    assert!(!text.chars().any(|c| c.is_control() && c != '\n'));
}

#[test]
fn empty_notes_are_refused_and_places_name_the_side() {
    assert!(Note::new(at(Side::Added, 1, ""), " \n\t ").is_none());
    let removed = Note::new(at(Side::Removed, 3, "x"), "no").unwrap();
    assert_eq!(removed.place(), "src/lib.rs:3 (removed)");
    let long = Note::new(at(Side::Unchanged, 9, "x"), &"a".repeat(5000)).unwrap();
    assert_eq!(long.comment.chars().count(), MAX_COMMENT_CHARS + 1);
    assert_eq!(long.place(), "src/lib.rs:9");
}
