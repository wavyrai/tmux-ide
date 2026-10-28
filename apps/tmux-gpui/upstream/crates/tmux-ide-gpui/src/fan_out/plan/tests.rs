use super::*;

#[test]
fn picks_are_bounded_and_drop_empty_kinds() {
    let mut picks = Picks::default();
    assert!(picks.add(AgentKind::Claude));
    assert!(picks.add(AgentKind::Codex));
    assert!(picks.add(AgentKind::Claude));
    assert_eq!(picks.count(AgentKind::Claude), 2);
    assert_eq!(picks.total(), 3);
    for _ in 3..MAX_LANES {
        assert!(picks.add(AgentKind::Pi));
    }
    assert!(!picks.add(AgentKind::Pi), "a full fan-out takes no more");
    assert_eq!(picks.total(), MAX_LANES);
    assert!(picks.remove(AgentKind::Codex));
    assert!(!picks.remove(AgentKind::Codex));
    assert_eq!(picks.count(AgentKind::Codex), 0);
    assert!(!picks.0.iter().any(|(kind, _)| *kind == AgentKind::Codex));
}

#[test]
fn lanes_share_a_stem_and_number_repeated_agents() {
    let mut picks = Picks::default();
    picks.add(AgentKind::Claude);
    picks.add(AgentKind::Codex);
    picks.add(AgentKind::Claude);
    let lanes = lanes(&picks, 0);
    let stem = crate::worktree::generated_branch_slug(0)
        .strip_prefix("worktree/")
        .unwrap()
        .to_owned();
    let names: Vec<_> = lanes.iter().map(|lane| lane.branch.as_str()).collect();
    assert_eq!(
        names,
        [
            format!("fan-out/{stem}-claude"),
            format!("fan-out/{stem}-claude-2"),
            format!("fan-out/{stem}-codex"),
        ]
    );
    for lane in &lanes {
        assert!(crate::worktree::validate_branch(&lane.branch).is_ok());
        assert_eq!(lane.branch, format!("fan-out/{}", lane.agent));
    }
    assert_eq!(lanes[2].kind, AgentKind::Codex);
}

#[test]
fn stats_parse_each_lane_and_skip_gone_or_garbled_records() {
    let output = "\x1e0\n3\t1\tsrc/a.rs\n-\t-\tlogo.png\n\x1f\n       2\n\x1f\n1\n\
                  \x1e2\n\x1f\n0\n\x1f\n0\n\
                  \x1e1\nnot a record\n\
                  \x1e9\n\x1f\n0\n\x1f\n0\n";
    assert_eq!(
        parse_stats(output, 3),
        [
            Some(DiffStat {
                files: 2,
                additions: 3,
                deletions: 1,
                untracked: 2,
                commits: 1,
            }),
            None,
            Some(DiffStat::default()),
        ]
    );
    assert_eq!(parse_stats("", 2), [None, None]);
}

#[test]
fn summaries_read_naturally() {
    assert_eq!(DiffStat::default().summary(), "No changes yet");
    let one = DiffStat {
        files: 1,
        additions: 4,
        deletions: 0,
        untracked: 0,
        commits: 1,
    };
    assert_eq!(one.summary(), "+4 −0 · 1 file · 1 commit");
    let many = DiffStat {
        files: 3,
        additions: 10,
        deletions: 2,
        untracked: 5,
        commits: 0,
    };
    assert_eq!(many.summary(), "+10 −2 · 3 files · 5 untracked");
}

#[test]
fn only_full_object_names_are_commits() {
    let sha = "0123456789abcdef0123456789abcdef01234567";
    assert_eq!(parse_commit(&format!("{sha}\n")).as_deref(), Some(sha));
    assert_eq!(parse_commit("HEAD"), None);
    assert_eq!(parse_commit("0123456"), None);
    assert_eq!(parse_commit(&format!("{sha}; rm -rf /")), None);
}

#[test]
fn stats_script_quotes_paths_and_base() {
    let script = stats_script(&["/tmp/it's here"], "abc");
    assert!(script.contains("git -C '/tmp/it'\\''s here' diff --numstat 'abc' --"));
    assert!(script.contains("rev-list --count 'abc'..HEAD"));
}

/// The script against a real checkout: a commit, an uncommitted edit,
/// and an untracked file all show up; a missing checkout prints nothing.
#[test]
#[cfg(any(target_os = "linux", target_os = "macos"))]
fn stats_script_reads_a_real_checkout() {
    use std::process::Command;
    let dir = tempfile::tempdir().unwrap();
    let repo = dir.path().join("repo");
    std::fs::create_dir(&repo).unwrap();
    let git = |args: &[&str]| {
        let status = Command::new("git")
            .arg("-C")
            .arg(&repo)
            .args([
                "-c",
                "user.name=t",
                "-c",
                "user.email=t@t",
                "-c",
                "commit.gpgsign=false",
            ])
            .args(args)
            .env_remove("GIT_DIR")
            .env_remove("GIT_WORK_TREE")
            .output()
            .unwrap();
        assert!(status.status.success(), "{args:?}: {status:?}");
        String::from_utf8(status.stdout).unwrap()
    };
    git(&["init", "-q"]);
    std::fs::write(repo.join("a.txt"), "one\n").unwrap();
    git(&["add", "."]);
    git(&["commit", "-qm", "base"]);
    let base = parse_commit(&git(&["rev-parse", "HEAD"])).unwrap();
    std::fs::write(repo.join("a.txt"), "one\ntwo\n").unwrap();
    git(&["commit", "-qam", "lane"]);
    std::fs::write(repo.join("a.txt"), "uno\ntwo\nthree\n").unwrap();
    std::fs::write(repo.join("new.txt"), "x\n").unwrap();

    let missing = dir.path().join("gone");
    let paths = [
        repo.to_str().unwrap().to_owned(),
        missing.to_str().unwrap().to_owned(),
    ];
    let output = Command::new("/bin/sh")
        .arg("-c")
        .arg(format!("set -eu\n{}", stats_script(&paths, &base)))
        .output()
        .unwrap();
    assert!(output.status.success(), "{output:?}");
    let stats = parse_stats(&String::from_utf8(output.stdout).unwrap(), 2);
    assert_eq!(
        stats,
        [
            Some(DiffStat {
                files: 1,
                additions: 3,
                deletions: 1,
                untracked: 1,
                commits: 1,
            }),
            None,
        ]
    );
}
