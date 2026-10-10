//! Reviewing a whole branch: which base it is compared with, and what each
//! scope shows, against a real repository.
use super::*;
use std::process::Command;

/// A repository on `feature`, branched from `trunk_name` with one commit,
/// then edited and given an untracked file. Returns its directory.
fn repository(trunk_name: &str) -> tempfile::TempDir {
    let directory = tempfile::tempdir().unwrap();
    let hooks = tempfile::tempdir().unwrap();
    let path = directory.path().to_str().unwrap().to_owned();
    let git = |args: &[&str]| {
        let output = Command::new("git")
            .args(["-C", &path, "-c", "user.name=Test"])
            .args(["-c", "user.email=test@example.invalid"])
            .args(["-c", "commit.gpgsign=false"])
            .arg("-c")
            .arg(format!("core.hooksPath={}", hooks.path().display()))
            .args(args)
            .env_remove("GIT_DIR")
            .output()
            .unwrap();
        assert!(output.status.success(), "git {args:?}: {output:?}");
    };
    let write = |name: &str, text: &str| std::fs::write(directory.path().join(name), text).unwrap();
    git(&["init", "-q", "-b", trunk_name]);
    write("lib.rs", "one\ntwo\nthree\n");
    git(&["add", "-A"]);
    git(&["commit", "-qm", "base"]);
    git(&["switch", "-qc", "feature"]);
    write("lib.rs", "one\ntwo changed\nthree\n");
    git(&["commit", "-qam", "committed on the branch"]);
    write("lib.rs", "one\ntwo changed\nthree\nfour\n");
    write("new.rs", "fresh\n");
    directory
}

fn input(directory: &tempfile::TempDir) -> Input {
    let path = directory.path().canonicalize().unwrap();
    Input {
        checkout: Some(path.to_str().unwrap().to_owned()),
        repo_key: Some(path.join(".git").to_str().unwrap().to_owned()),
        branch: "feature".into(),
    }
}

fn changed(loaded: &Loaded, kind: Kind) -> Vec<&str> {
    loaded
        .diff
        .files
        .iter()
        .filter_map(FileDiff::lines)
        .flat_map(|lines| {
            lines
                .iter()
                .filter(move |line| line.kind == kind)
                .map(|line| lines.text_of(line))
        })
        .collect()
}

/// The checkout's changes in `scope`, every file read.
fn read(directory: &tempfile::TempDir, scope: Scope, hint: Option<&str>) -> crate::Result<Loaded> {
    let mut loaded = load(&input(directory), scope, hint, false)?;
    loaded.read_all();
    Ok(loaded)
}

#[test]
fn a_branch_review_includes_its_commits_and_uncommitted_work() {
    let directory = repository("main");
    let uncommitted = read(&directory, Scope::Uncommitted, None).unwrap();
    assert_eq!(changed(&uncommitted, Kind::Added), ["four", "fresh"]);
    assert_eq!(uncommitted.base, None);
    assert_eq!(uncommitted.diff.before, "HEAD");

    let branch = read(&directory, Scope::Branch, None).unwrap();
    assert_eq!(
        changed(&branch, Kind::Added),
        ["two changed", "four", "fresh"]
    );
    assert_eq!(changed(&branch, Kind::Removed), ["two"]);
    assert_eq!(branch.base.as_deref(), Some("main"));
    assert!(
        branch.diff.before.starts_with("main at "),
        "{}",
        branch.diff.before
    );
    // Added lines keep the working tree's numbers in either scope.
    let four = |loaded: &Loaded| {
        let lines = loaded.diff.files[0].lines()?;
        lines
            .iter()
            .find(|line| lines.text_of(line) == "four")
            .and_then(|line| line.new)
    };
    assert_eq!(four(&uncommitted), Some(4));
    assert_eq!(four(&branch), Some(4));
}

#[test]
fn the_base_falls_back_from_a_missing_or_unsafe_hint() {
    let directory = repository("master");
    for hint in [Some("release"), Some("--output=/tmp/x"), Some("a..b"), None] {
        let branch = read(&directory, Scope::Branch, hint).unwrap();
        assert_eq!(branch.base.as_deref(), Some("master"), "{hint:?}");
    }
    let directory = repository("trunk");
    assert!(matches!(
        read(&directory, Scope::Branch, None),
        Err(crate::Error::ReviewNoBase)
    ));
    let branch = read(&directory, Scope::Branch, Some("trunk")).unwrap();
    assert_eq!(branch.base.as_deref(), Some("trunk"));
}

#[test]
fn candidates_are_full_refs_in_order_without_repeats() {
    assert_eq!(
        load::base_candidates(Some("develop"), Some("refs/remotes/origin/main")),
        [
            "refs/remotes/origin/develop",
            "refs/heads/develop",
            "refs/remotes/origin/main",
            "refs/heads/main",
            "refs/remotes/origin/master",
            "refs/heads/master",
        ]
    );
    for refused in [
        "", "-x", "/x", ".x", "a..b", "a b", "a~1", "a^", "a:b", "a\\b", "a@{1}",
    ] {
        assert!(!load::plain_branch(refused), "{refused}");
    }
    assert!(load::plain_branch("release/2026.10"));
}
