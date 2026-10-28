//! Large changes: listed at once, read a batch at a time, a huge file only
//! when asked, binaries never; none fails the whole review.
use super::super::budget::{Counted, batch, literal, parse_name_status, parse_numstat, too_large};
use super::*;
use std::process::Command;

fn counted(path: &str, added: u64, deleted: u64) -> Counted {
    Counted {
        path: path.into(),
        old_path: None,
        added: Some(added),
        deleted: Some(deleted),
    }
}

#[test]
fn numstat_names_renames_by_their_new_path_and_binaries_by_none() {
    let text = concat!(
        "3\t1\tsrc/a.rs\0",
        "-\t-\tlogo.png\0",
        "2\t0\t\0old.rs\0new.rs\0",
    );
    let parsed = parse_numstat(text);
    assert_eq!(parsed[0], counted("src/a.rs", 3, 1));
    assert!(parsed[1].binary());
    assert_eq!(parsed[2].path, "new.rs");
    assert_eq!(parsed[2].old_path.as_deref(), Some("old.rs"));
    assert!(parse_numstat("").is_empty());
    assert_eq!(
        parse_name_status("M\0a.rs\0A\0b.rs\0D\0c.rs\0R087\0old.rs\0new.rs\0"),
        [
            ("a.rs".to_owned(), Status::Modified),
            ("b.rs".to_owned(), Status::Added),
            ("c.rs".to_owned(), Status::Deleted),
            ("new.rs".to_owned(), Status::Renamed),
        ]
    );
}

#[test]
fn batches_hold_what_fits_and_always_one_file() {
    assert!(!too_large(20_000, Some(10)));
    assert!(too_large(20_001, None));
    assert!(too_large(1, Some(5 * 1024 * 1024)));
    assert_eq!(batch([(0, 10), (1, 19_000), (2, 5_000), (3, 1)]), [0, 1]);
    // A file heavier than a batch still goes, alone.
    assert_eq!(batch([(7, 50_000), (8, 1)]), [7]);
    assert_eq!(batch((0..100).map(|file| (file, 1))).len(), 64);
    assert!(batch([]).is_empty());
    assert_eq!(literal("a b/*.rs"), ":(top,literal)a b/*.rs");
}

fn git(checkout: &str, args: &[&str]) {
    let output = Command::new("git")
        .args(["-C", checkout, "-c", "user.name=Test"])
        .args([
            "-c",
            "user.email=test@example.invalid",
            "-c",
            "commit.gpgsign=false",
        ])
        .args(args)
        .env_remove("GIT_DIR")
        .output()
        .unwrap();
    assert!(output.status.success(), "git {args:?}: {output:?}");
}

#[test]
fn huge_and_binary_files_are_listed_while_the_rest_is_read() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().canonicalize().unwrap();
    let checkout = path.to_str().unwrap().to_owned();
    git(&checkout, &["init", "-q", "-b", "main"]);
    for name in ["small.rs", "generated.rs", "bundle.js"] {
        std::fs::write(path.join(name), "").unwrap();
    }
    std::fs::write(path.join("logo.png"), b"\x89PNG\0\0").unwrap();
    std::fs::write(path.join("Cargo.lock"), "a\n").unwrap();
    git(&checkout, &["add", "-A"]);
    git(&checkout, &["commit", "-qm", "base"]);
    std::fs::write(path.join("small.rs"), "one\ntwo\n").unwrap();
    let generated: String = (0..25_000)
        .map(|line| format!("const X{line}: u32 = {line};\n"))
        .collect();
    std::fs::write(path.join("generated.rs"), generated).unwrap();
    std::fs::write(path.join("bundle.js"), "x".repeat(5 * 1024 * 1024)).unwrap();
    std::fs::write(path.join("logo.png"), b"\x89PNG\0\x01").unwrap();
    std::fs::write(path.join("Cargo.lock"), "b\n").unwrap();
    std::fs::write(path.join("added.txt"), "fresh\n").unwrap();

    let input = Input {
        checkout: Some(checkout.clone()),
        repo_key: Some(path.join(".git").to_str().unwrap().to_owned()),
        branch: "main".into(),
    };
    let mut loaded = load(&input, Scope::Uncommitted, None, false).unwrap();
    let names: Vec<&str> = loaded
        .diff
        .files
        .iter()
        .map(|file| file.path.as_str())
        .collect();
    // Untracked files sort among the rest.
    assert_eq!(
        names,
        [
            "Cargo.lock",
            "added.txt",
            "bundle.js",
            "generated.rs",
            "logo.png",
            "small.rs"
        ]
    );
    let file = |loaded: &Loaded, name: &str| {
        loaded
            .diff
            .files
            .iter()
            .find(|file| file.path == name)
            .unwrap()
            .clone()
    };
    assert_eq!(file(&loaded, "generated.rs").body, Body::Large);
    assert_eq!(file(&loaded, "generated.rs").added, Some(25_000));
    assert_eq!(file(&loaded, "bundle.js").body, Body::Large);
    assert_eq!(file(&loaded, "logo.png").body, Body::Binary);
    assert!(file(&loaded, "Cargo.lock").folded, "lockfiles start folded");
    assert!(!file(&loaded, "small.rs").folded);

    loaded.read_all();
    let small = file(&loaded, "small.rs");
    let lines = small.lines().unwrap();
    assert!(
        lines
            .iter()
            .any(|line| line.kind == Kind::Added && lines.text_of(line) == "two")
    );
    let added = file(&loaded, "added.txt");
    assert_eq!(added.status, Status::Untracked);
    assert_eq!(added.lines().unwrap().text(1), "fresh");
    assert_eq!(
        file(&loaded, "generated.rs").body,
        Body::Large,
        "not read unasked"
    );
    // A large file still takes a note as a whole.
    let index = names_index(&loaded, "generated.rs");
    assert!(matches!(
        loaded.diff.anchor(RowId::Header(index)),
        Some(Anchor::File { .. })
    ));

    // Asked for, it is read whole.
    let requests = [Request::of(index, &loaded.diff.files[index])];
    let read = bodies(&loaded.source, &requests, true);
    let Body::Loaded(lines) = &read[0].1 else {
        panic!("read when asked: {:?}", read[0].1);
    };
    assert_eq!(
        lines.iter().filter(|line| line.kind == Kind::Added).count(),
        25_000
    );
}

fn names_index(loaded: &Loaded, name: &str) -> usize {
    loaded
        .diff
        .files
        .iter()
        .position(|file| file.path == name)
        .unwrap()
}

#[test]
fn a_change_of_a_hundred_thousand_lines_reads_in_batches() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().canonicalize().unwrap();
    let checkout = path.to_str().unwrap().to_owned();
    git(&checkout, &["init", "-q", "-b", "main"]);
    std::fs::write(path.join("keep"), "").unwrap();
    git(&checkout, &["add", "-A"]);
    git(&checkout, &["commit", "-qm", "base"]);
    // Ten files of 12,000 lines: 120,000 changed lines, more than one Git
    // read of the old kind could hold.
    for file in 0..10 {
        let text: String = (0..12_000)
            .map(|line| format!("file {file} line {line} with some text\n"))
            .collect();
        std::fs::write(path.join(format!("f{file}.txt")), text).unwrap();
    }
    git(&checkout, &["add", "-A"]);
    let input = Input {
        checkout: Some(checkout.clone()),
        repo_key: Some(path.join(".git").to_str().unwrap().to_owned()),
        branch: "main".into(),
    };
    let mut loaded = load(&input, Scope::Uncommitted, None, false).unwrap();
    assert_eq!(loaded.diff.files.len(), 10);
    let weights: Vec<(usize, u64)> = loaded
        .diff
        .files
        .iter()
        .enumerate()
        .map(|(index, file)| (index, file.weight()))
        .collect();
    assert_eq!(batch(weights.clone()).len(), 1, "a batch stays bounded");
    loaded.read_all();
    let total: usize = loaded
        .diff
        .files
        .iter()
        .map(|file| file.lines().unwrap().len())
        .sum();
    // Every line, plus each file's hunk header.
    assert_eq!(total, 120_010);
}

/// Names Git quotes in a patch still find their lines.
#[cfg(unix)]
#[test]
fn files_with_odd_names_are_read() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().canonicalize().unwrap();
    let checkout = path.to_str().unwrap().to_owned();
    git(&checkout, &["init", "-q", "-b", "main"]);
    let names = [
        "tab\there.rs",
        "with space.rs",
        "quote\"d.rs",
        "back\\slash.rs",
    ];
    for name in names {
        std::fs::write(path.join(name), "old\n").unwrap();
    }
    git(&checkout, &["add", "-A"]);
    git(&checkout, &["commit", "-qm", "base"]);
    for name in names {
        std::fs::write(path.join(name), "new\n").unwrap();
    }
    let input = Input {
        checkout: Some(checkout.clone()),
        repo_key: Some(path.join(".git").to_str().unwrap().to_owned()),
        branch: "main".into(),
    };
    let mut loaded = load(&input, Scope::Uncommitted, None, false).unwrap();
    assert_eq!(loaded.diff.files.len(), names.len());
    loaded.read_all();
    for file in &loaded.diff.files {
        let lines = file.lines().unwrap();
        assert!(
            lines
                .iter()
                .any(|line| line.kind == Kind::Added && lines.text_of(line) == "new"),
            "{}",
            file.path
        );
    }
}
