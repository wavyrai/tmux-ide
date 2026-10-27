#![allow(clippy::unwrap_used)]
use super::*;
use crate::pull_request::Input;

const SAMPLE: &str = "diff --git a/src/main.rs b/src/main.rs
index 1111111..2222222 100644
--- a/src/main.rs
+++ b/src/main.rs
@@ -10,4 +10,5 @@ fn main() {
     let a = 1;
-    let b = 2;
+    let b = 3;
+\tlet c = \u{1b}[31m4;
     done();
diff --git a/old.txt b/old.txt
deleted file mode 100644
--- a/old.txt
+++ /dev/null
@@ -1 +0,0 @@
-gone
\\ No newline at end of file
diff --git a/logo.png b/logo.png
new file mode 100644
Binary files /dev/null and b/logo.png differ
diff --git a/before.rs b/after.rs
similarity index 90%
rename from before.rs
rename to after.rs
--- a/before.rs
+++ b/after.rs
@@ -1 +1 @@
-x
+y
";

/// A file's lines as kinds, numbers and text.
fn rows(file: &FileDiff) -> Vec<(Kind, Option<u32>, Option<u32>, String)> {
    let lines = file.lines().unwrap();
    lines
        .iter()
        .map(|line| {
            (
                line.kind,
                line.old,
                line.new,
                lines.text_of(line).to_owned(),
            )
        })
        .collect()
}

#[test]
fn files_are_parsed_with_their_status_and_numbered_lines() {
    let diff = Diff::parse(SAMPLE);
    let files: Vec<_> = diff
        .files
        .iter()
        .map(|file| (file.path.as_str(), file.status, file.old_path.as_deref()))
        .collect();
    assert_eq!(
        files,
        [
            ("src/main.rs", Status::Modified, None),
            ("old.txt", Status::Deleted, None),
            ("logo.png", Status::Added, None),
            ("after.rs", Status::Renamed, Some("before.rs")),
        ]
    );
    let text = |text: &str| text.to_owned();
    assert_eq!(
        rows(&diff.files[0]),
        [
            (
                Kind::Hunk,
                None,
                None,
                text("@@ -10,4 +10,5 @@ fn main() {")
            ),
            (Kind::Context, Some(10), Some(10), text("    let a = 1;")),
            (Kind::Removed, Some(11), None, text("    let b = 2;")),
            (Kind::Added, None, Some(11), text("    let b = 3;")),
            // Tabs are spaced and escape sequences lose their control.
            (Kind::Added, None, Some(12), text("    let c = [31m4;")),
            (Kind::Context, Some(12), Some(13), text("    done();")),
        ]
    );
    assert_eq!(
        (diff.files[0].added, diff.files[0].removed),
        (Some(2), Some(1))
    );
    assert!(
        rows(&diff.files[1])
            .iter()
            .any(|row| row.0 == Kind::Meta && row.3 == "\\ No newline at end of file")
    );
    // Binary files are listed, never shown.
    assert_eq!(diff.files[2].body, Body::Binary);
}

#[test]
fn notes_anchor_to_a_line_on_its_own_side_or_a_whole_file() {
    let mut diff = Diff::parse(SAMPLE);
    diff.before = "main at 1a2b3c4".into();
    let line = |text: &str| {
        let lines = diff.files[0].lines().unwrap();
        let line = (0..lines.len())
            .find(|&line| lines.text(line) == text)
            .unwrap();
        RowId::Line { file: 0, line }
    };
    assert_eq!(
        diff.anchor(line("    let b = 2;")),
        Some(Anchor::Line {
            path: "src/main.rs".into(),
            side: Side::Removed,
            number: 11,
            code: "    let b = 2;".into(),
            // Only a removed line's number depends on what the diff is against.
            before: Some("main at 1a2b3c4".into()),
        })
    );
    assert_eq!(
        diff.anchor(line("    done();")),
        Some(Anchor::Line {
            path: "src/main.rs".into(),
            side: Side::Unchanged,
            number: 13,
            code: "    done();".into(),
            before: None,
        })
    );
    assert_eq!(diff.anchor(line("@@ -10,4 +10,5 @@ fn main() {")), None);
    assert_eq!(
        diff.anchor(RowId::Header(0)),
        Some(Anchor::File {
            path: "src/main.rs".into()
        })
    );
    let added = line("    let b = 3;");
    let anchor = diff.anchor(added).unwrap();
    assert_eq!(diff.row_of(&diff.paths(), &anchor), Some(added));
    assert_eq!(diff.anchor(RowId::Line { file: 0, line: 99 }), None);
    assert_eq!(diff.anchor(RowId::Header(9)), None);
}

#[test]
fn untracked_files_are_wholly_added_and_lines_are_bounded() {
    let mut diff = Diff::default();
    diff.add_untracked("notes/todo.md", "one\ntwo\n");
    let rows: Vec<_> = rows(&diff.files[0])
        .into_iter()
        .map(|(kind, _, new, text)| (kind, new, text))
        .collect();
    assert_eq!(
        rows,
        [
            (Kind::Hunk, None, "@@ -0,0 +1,2 @@".to_owned()),
            (Kind::Added, Some(1), "one".to_owned()),
            (Kind::Added, Some(2), "two".to_owned()),
        ]
    );
    assert_eq!(
        (diff.files[0].added, diff.files[0].removed),
        (Some(2), Some(0))
    );

    // A long line keeps far more than a screen's width, then an ellipsis.
    let long = "x".repeat(MAX_LINE_CHARS * 2);
    let lines = Lines::added(&long);
    assert_eq!(lines.text(1).chars().count(), MAX_LINE_CHARS + 1);
    assert!(lines.text(1).ends_with('\u{2026}'));
    assert!(!lines.truncated);
    let many = "x\n".repeat(MAX_FILE_LINES + 10);
    let lines = Lines::added(&many);
    assert!(lines.truncated);
    assert_eq!(lines.len(), MAX_FILE_LINES);
}

#[test]
fn a_file_s_lines_take_one_buffer_and_compact_rows() {
    // Each line is a few words, not an allocation of its own.
    assert!(size_of::<Line>() <= 32);
    let lines = Lines::added("alpha\nbeta\n");
    assert_eq!(lines.text(1), "alpha");
    assert_eq!(lines.text(2), "beta");
    assert_eq!(lines.text(9), "");
}

#[test]
fn hidden_lines_above_a_hunk_are_found_and_shown() {
    let diff = Diff::parse(
        "diff --git a/a.rs b/a.rs
--- a/a.rs
+++ b/a.rs
@@ -10,2 +12,2 @@
 ten
-eleven
+twelve
@@ -40,1 +42,1 @@
-forty
+forty-two
",
    );
    let lines = diff.files[0].lines().unwrap();
    // Above the first hunk: lines 1 to 11 after the change, 2 behind before.
    let first = lines.gap(0).unwrap();
    assert_eq!(first.hidden, 1..12);
    assert_eq!(first.old(12), 10);
    // Between the hunks: after line 13, up to 41.
    let second = lines.gap(4).unwrap();
    assert_eq!(second.hidden, 14..42);
    assert_eq!(second.len(), 28);
    assert_eq!(lines.gap(1), None, "not a hunk header");
    // Shown, they number on both sides at the top of their hunk, and the
    // lines still hidden stay above it.
    let grown = lines.with_context(4, 40, second.old(40), &["a".into(), "b".into()]);
    let shown: Vec<_> = (4..7)
        .map(|line| {
            let found = grown.get(line).unwrap();
            (found.kind, found.old, found.new, grown.text(line))
        })
        .collect();
    assert_eq!(
        shown,
        [
            (Kind::Hunk, None, None, "@@ -38,3 +40,3 @@"),
            (Kind::Context, Some(38), Some(40), "a"),
            (Kind::Context, Some(39), Some(41), "b"),
        ]
    );
    assert_eq!(grown.get(7).unwrap().kind, Kind::Removed);
    assert_eq!(grown.gap(4).unwrap().hidden, 14..40);
    let all: Vec<String> = (14..40).map(|line| line.to_string()).collect();
    let closed = grown.with_context(4, 14, 12, &all);
    assert_eq!(closed.gap(4), None, "nothing left hidden");
    // A new file has nothing hidden.
    assert_eq!(Lines::added("x\n").gap(0), None);
}

#[test]
fn file_names_are_cleaned_for_display_but_kept_for_git() {
    let mut file = FileDiff::new("evil\u{1b}[31m\u{202e}.rs".into(), Status::Untracked);
    file.set_old_path("old\u{7}.rs".into());
    assert_eq!(file.path, "evil[31m.rs");
    assert_eq!(file.old_path.as_deref(), Some("old.rs"));
    assert_eq!(file.git_path, "evil\u{1b}[31m\u{202e}.rs");
    let request = Request::of(0, &file);
    assert_eq!(request.git_path, file.git_path);
}

#[test]
fn quoted_and_spaced_names_are_decoded_as_git_wrote_them() {
    let diff = Diff::parse(concat!(
        "diff --git \"a/tab\\there.rs\" \"b/tab\\there.rs\"\n",
        "--- \"a/tab\\there.rs\"\n",
        "+++ \"b/tab\\there.rs\"\n",
        "@@ -1 +1 @@\n-a\n+b\n",
        "diff --git a/with space.rs b/with space.rs\n",
        "--- a/with space.rs\t\n",
        "+++ b/with space.rs\t\n",
        "@@ -1 +1 @@\n-a\n+b\n",
        "diff --git \"a/caf\\303\\251 \\\"q\\\".rs\" \"b/caf\\303\\251 \\\"q\\\".rs\"\n",
        "deleted file mode 100644\n",
        "--- \"a/caf\\303\\251 \\\"q\\\".rs\"\n",
        "+++ /dev/null\n",
        "@@ -1 +0,0 @@\n-gone\n",
    ));
    let names: Vec<(&str, &str)> = diff
        .files
        .iter()
        .map(|file| (file.git_path.as_str(), file.path.as_str()))
        .collect();
    assert_eq!(
        names,
        [
            ("tab\there.rs", "tab    here.rs"),
            ("with space.rs", "with space.rs"),
            ("caf\u{e9} \"q\".rs", "caf\u{e9} \"q\".rs"),
        ]
    );
    assert!(diff.files.iter().all(|file| file.lines().is_some()));
}

#[cfg(unix)]
#[test]
fn an_untracked_file_with_a_control_character_in_its_name_is_read() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().canonicalize().unwrap();
    let checkout = path.to_str().unwrap().to_owned();
    let name = "odd\u{1b}name.txt";
    std::fs::write(path.join(name), "hello\n").unwrap();
    let mut file = FileDiff::new(name.into(), Status::Untracked);
    let source = load::Source::local(&checkout);
    let read = bodies(&source, &[Request::of(0, &file)], false);
    file.set_body(read.into_iter().next().unwrap().1);
    assert_eq!(file.path, "oddname.txt");
    assert_eq!(file.lines().unwrap().text(1), "hello");
}

#[test]
fn lockfiles_are_known_by_name() {
    assert!(lockfile("Cargo.lock"));
    assert!(lockfile("web/package-lock.json"));
    assert!(!lockfile("src/lock.rs"));
}

#[test]
fn only_plain_relative_untracked_names_are_read() {
    for refused in ["", "../secret", "/etc/passwd", "a/../../b"] {
        assert!(!load::inside(refused), "{refused}");
    }
    assert!(load::inside("src/a.rs"));
}

#[cfg(unix)]
#[test]
fn untracked_links_and_binaries_are_not_read() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("a.txt"), "hello").unwrap();
    std::fs::write(dir.path().join("b.bin"), b"a\0b").unwrap();
    std::os::unix::fs::symlink("/etc/hosts", dir.path().join("link")).unwrap();
    let read = |name: &str| load::untracked(dir.path(), name, false);
    let Body::Loaded(lines) = read("a.txt") else {
        panic!("a.txt is text");
    };
    assert_eq!(lines.text(1), "hello");
    assert_eq!(read("b.bin"), Body::Binary);
    assert!(matches!(read("link"), Body::Failed(_)));
    assert!(matches!(read("missing"), Body::Failed(_)));
}

mod branch;
mod large;
mod split;
mod words;
