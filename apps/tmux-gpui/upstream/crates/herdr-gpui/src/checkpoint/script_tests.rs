#![allow(clippy::unwrap_used, clippy::expect_used)]

use super::*;

#[test]
fn listings_parse_newest_first_with_their_branch_and_diff() {
    let output = "\u{1e}0000000000000001\n2 5 1\n1700000000\nBefore claude's turn\n\nHerdr-Branch: feature\n\
                  \u{1e}0000000000000002\n0 0 0\n1700000060\nclaude finished a turn\n\nHerdr-Branch: feature/x\n";
    let list = parse_list(output).unwrap();
    assert_eq!(list.len(), 2);
    assert_eq!(list[0].id, "0000000000000002");
    assert_eq!(list[0].label, "claude finished a turn");
    assert_eq!(list[0].branch.as_deref(), Some("feature/x"));
    assert_eq!(list[0].diff, Diff::default());
    assert_eq!(list[1].created, 1_700_000_000);
    assert_eq!(
        list[1].diff,
        Diff {
            files: 2,
            additions: 5,
            deletions: 1
        }
    );
    assert_eq!(parse_list("").unwrap(), []);
    for malformed in [
        "\u{1e}not-digits\n1 1 1\n1\nx\n",
        "\u{1e}1\n1 1\n1\nx\n",
        "\u{1e}1\n1 1 1\nsoon\nx\n",
    ] {
        assert!(matches!(
            parse_list(malformed),
            Err(Error::CheckpointOutput)
        ));
    }
}

#[test]
fn captures_report_what_they_created() {
    assert_eq!(parse_capture("unchanged\n").unwrap(), None);
    assert_eq!(
        parse_capture("created 0000000000000042\n")
            .unwrap()
            .as_deref(),
        Some("0000000000000042")
    );
    for malformed in ["", "created ../../heads/main", "created "] {
        assert!(matches!(
            parse_capture(malformed),
            Err(Error::CheckpointOutput)
        ));
    }
}

#[test]
fn labels_are_one_bounded_line() {
    assert_eq!(clean_label("  a\nb\tc  "), "a b c");
    assert_eq!(clean_label("\n"), "Checkpoint");
    assert_eq!(clean_label(&"x".repeat(500)).len(), LABEL_LIMIT);
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
mod live {
    use crate::checkpoint::{Checkout, KEEP, script};
    use crate::{Error, usage::Host};
    use herdr_client::{ScriptHost, ScriptLimits, run_script};
    use std::{
        fs,
        path::{Path, PathBuf},
        process::Command,
        sync::atomic::AtomicBool,
        time::Duration,
    };

    /// Scripts run with Git isolated from the user's configuration.
    const ENV: &str = "GIT_CONFIG_GLOBAL=/dev/null\nGIT_CONFIG_NOSYSTEM=1\nexport GIT_CONFIG_GLOBAL GIT_CONFIG_NOSYSTEM\n";

    fn git(dir: &Path, args: &[&str]) -> String {
        let output = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@t")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@t")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .output()
            .expect("git runs");
        assert!(
            output.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).into_owned()
    }

    fn write(path: &Path, text: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    fn read(path: &Path) -> Option<String> {
        fs::read_to_string(path).ok()
    }

    fn sh(body: &str) -> crate::Result<String> {
        let mut output = Vec::new();
        run_script(
            ScriptHost::Local,
            &format!("{ENV}{body}"),
            std::io::empty(),
            &mut output,
            ScriptLimits {
                output: 1024 * 1024,
                idle: Duration::from_secs(60),
            },
            &AtomicBool::new(false),
        )
        .map_err(script::classify)?;
        Ok(String::from_utf8(output).unwrap())
    }

    struct Repo {
        _temp: tempfile::TempDir,
        main: PathBuf,
        checkout: PathBuf,
        target: Checkout,
    }

    impl Repo {
        fn capture(&self, label: &str, stamp: &str) -> Option<String> {
            self.capture_keeping(label, stamp, KEEP)
        }

        fn capture_keeping(&self, label: &str, stamp: &str, keep: usize) -> Option<String> {
            script::parse_capture(&sh(&script::capture(&self.target, label, stamp, keep)).unwrap())
                .unwrap()
        }

        fn list(&self) -> Vec<crate::checkpoint::Checkpoint> {
            script::parse_list(&sh(&script::list(&self.target)).unwrap()).unwrap()
        }

        fn restore(&self, id: &str, stamp: &str) -> crate::Result<String> {
            sh(&script::restore(
                &self.target,
                id,
                "Before restore",
                stamp,
                KEEP,
            ))
        }
    }

    /// A repository with a linked `feature` worktree (a path with a space and
    /// a quote) holding staged, unstaged, untracked, and ignored files.
    fn repo() -> Repo {
        let temp = tempfile::tempdir().unwrap();
        let main = temp.path().join("main");
        fs::create_dir(&main).unwrap();
        git(&main, &["init", "-q", "-b", "main"]);
        write(&main.join("keep.txt"), "keep\n");
        write(&main.join("edit.txt"), "one\n");
        write(&main.join(".gitignore"), "secret.env\n");
        git(&main, &["add", "-A"]);
        git(&main, &["commit", "-q", "-m", "base"]);
        let checkout = temp.path().join("feature's checkout");
        git(
            &main,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "feature",
                checkout.to_str().unwrap(),
            ],
        );
        write(&checkout.join("edit.txt"), "staged\n");
        git(&checkout, &["add", "edit.txt"]);
        write(&checkout.join("edit.txt"), "staged\nunstaged\n");
        write(&checkout.join("new/untracked.txt"), "new\n");
        write(&checkout.join("secret.env"), "TOKEN=1\n");
        let key = git(&main, &["rev-parse", "--absolute-git-dir"]);
        let target = Checkout::new(Host::Local, key.trim(), Some("feature")).unwrap();
        Repo {
            _temp: temp,
            main,
            checkout,
            target,
        }
    }

    #[test]
    fn capturing_keeps_the_index_and_files_and_includes_untracked_work() {
        let repo = repo();
        let index = git(&repo.checkout, &["rev-parse", "--git-path", "index"]);
        let index = repo.checkout.join(index.trim());
        let index_before = fs::read(&index).unwrap();
        let status_before = git(&repo.checkout, &["status", "--porcelain=v1"]);

        let id = repo
            .capture("it's $(touch pwned) \"quoted\"", "0000000000000001")
            .expect("a first checkpoint is created");
        assert_eq!(id, "0000000000000001");
        assert_eq!(
            fs::read(&index).unwrap(),
            index_before,
            "real index untouched"
        );
        assert_eq!(
            git(&repo.checkout, &["status", "--porcelain=v1"]),
            status_before
        );
        assert!(!repo.checkout.join("pwned").exists());

        let refs = git(
            &repo.main,
            &["for-each-ref", "--format=%(refname)", script::NAMESPACE],
        );
        let reference = refs.trim().to_owned();
        assert!(reference.ends_with(&format!("/{id}")), "{reference}");
        let files = git(
            &repo.checkout,
            &["ls-tree", "-r", "--name-only", &reference],
        );
        assert!(files.lines().any(|file| file == "new/untracked.txt"));
        assert!(!files.lines().any(|file| file == "secret.env"));
        assert_eq!(
            git(&repo.checkout, &["show", &format!("{reference}:edit.txt")]),
            "staged\nunstaged\n"
        );
        // Kept by `git gc` from any worktree, unlike per-worktree refs.
        git(&repo.main, &["gc", "-q", "--prune=now"]);
        assert_eq!(
            git(&repo.checkout, &["cat-file", "-t", &reference]).trim(),
            "commit"
        );

        let list = repo.list();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].label, "it's $(touch pwned) \"quoted\"");
        assert_eq!(list[0].branch.as_deref(), Some("feature"));
        // edit.txt changed by two lines, one replaced; one new file.
        assert_eq!(list[0].diff.files, 2);
        assert_eq!(list[0].diff.additions, 3);
        assert_eq!(list[0].diff.deletions, 1);

        assert_eq!(repo.capture("again", "0000000000000002"), None, "unchanged");
        write(&repo.checkout.join("keep.txt"), "keep\nmore\n");
        assert!(repo.capture("turn", "0000000000000003").is_some());
        let list = repo.list();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].id, "0000000000000003");
        assert_eq!(list[0].diff.files, 1, "diffed against the previous one");
        assert_eq!(list[0].diff.additions, 1);
    }

    #[test]
    fn older_checkpoints_are_pruned() {
        let repo = repo();
        for turn in 1..=5 {
            write(&repo.checkout.join("turn.txt"), &format!("{turn}\n"));
            repo.capture_keeping("turn", &format!("{turn:016}"), 3)
                .unwrap();
        }
        let ids: Vec<String> = repo.list().into_iter().map(|c| c.id).collect();
        assert_eq!(
            ids,
            [
                format!("{:016}", 5),
                format!("{:016}", 4),
                format!("{:016}", 3)
            ]
        );
    }

    #[test]
    fn restoring_puts_files_and_head_back_and_can_be_undone() {
        let repo = repo();
        let head = git(&repo.checkout, &["rev-parse", "HEAD"]);
        let id = repo.capture("before", "0000000000000001").unwrap();

        // The agent's turn: edits, deletes, creates, and commits.
        write(&repo.checkout.join("edit.txt"), "rewritten\n");
        fs::remove_file(repo.checkout.join("new/untracked.txt")).unwrap();
        write(&repo.checkout.join("agent.txt"), "agent\n");
        write(&repo.checkout.join("committed.txt"), "committed\n");
        git(&repo.checkout, &["add", "committed.txt"]);
        git(&repo.checkout, &["commit", "-q", "-m", "agent commit"]);

        repo.restore(&id, "0000000000000002").unwrap();
        let path = |name: &str| repo.checkout.join(name);
        assert_eq!(
            read(&path("edit.txt")).as_deref(),
            Some("staged\nunstaged\n")
        );
        assert_eq!(read(&path("new/untracked.txt")).as_deref(), Some("new\n"));
        assert_eq!(read(&path("agent.txt")), None);
        assert_eq!(read(&path("committed.txt")), None);
        assert_eq!(read(&path("secret.env")).as_deref(), Some("TOKEN=1\n"));
        assert_eq!(git(&repo.checkout, &["rev-parse", "HEAD"]), head);
        assert_eq!(
            git(&repo.checkout, &["symbolic-ref", "HEAD"]).trim(),
            "refs/heads/feature",
            "still on the branch"
        );
        // The real index is reset to HEAD, not the temporary one: the
        // restored work is unstaged, the agent's commit nowhere in it.
        assert_eq!(
            git(&repo.checkout, &["diff", "--cached", "--name-only"]),
            ""
        );
        assert_eq!(
            git(&repo.checkout, &["status", "--porcelain=v1"]),
            " M edit.txt\n?? new/\n"
        );

        // The state it replaced was saved first, so the restore undoes.
        let list = repo.list();
        assert_eq!(list[0].id, "0000000000000002");
        assert_eq!(list[0].label, "Before restore");
        repo.restore("0000000000000002", "0000000000000003")
            .unwrap();
        assert_eq!(read(&path("agent.txt")).as_deref(), Some("agent\n"));
        assert_eq!(read(&path("committed.txt")).as_deref(), Some("committed\n"));
        assert_eq!(
            git(&repo.checkout, &["log", "-1", "--format=%s"]).trim(),
            "agent commit"
        );
    }

    #[test]
    fn refusals_are_typed() {
        let repo = repo();
        let id = repo.capture("before", "0000000000000001").unwrap();
        assert!(matches!(
            repo.restore("0000000000000099", "0000000000000002"),
            Err(Error::CheckpointMissing)
        ));

        let git_dir = git(&repo.checkout, &["rev-parse", "--git-dir"]);
        let merge_head = repo.checkout.join(git_dir.trim()).join("MERGE_HEAD");
        fs::write(&merge_head, git(&repo.checkout, &["rev-parse", "HEAD"])).unwrap();
        assert!(matches!(
            repo.restore(&id, "0000000000000002"),
            Err(Error::CheckpointBusy)
        ));
        fs::remove_file(&merge_head).unwrap();

        // Same checkout, another branch: the feature's checkpoints are not
        // its own, and one planted among them still cannot move it.
        git(&repo.checkout, &["stash", "-u", "-q"]);
        git(&repo.checkout, &["switch", "-q", "-c", "other"]);
        let other = Checkout {
            branch: "other".into(),
            ..repo.target.clone()
        };
        assert!(
            script::parse_list(&sh(&script::list(&other)).unwrap())
                .unwrap()
                .is_empty()
        );
        assert!(matches!(
            sh(&script::restore(&other, &id, "x", "0000000000000002", KEEP)),
            Err(Error::CheckpointMissing)
        ));
        let bucket = sh("printf other | git hash-object --stdin\n").unwrap();
        let feature = git(
            &repo.main,
            &["for-each-ref", "--format=%(objectname)", script::NAMESPACE],
        );
        git(
            &repo.main,
            &[
                "update-ref",
                &format!("{}{}/{id}", script::NAMESPACE, bucket.trim()),
                feature.trim(),
            ],
        );
        assert!(matches!(
            sh(&script::restore(&other, &id, "x", "0000000000000002", KEEP)),
            Err(Error::CheckpointBranch)
        ));
        // Nobody has `feature` checked out any more.
        assert!(matches!(
            sh(&script::list(&repo.target)),
            Err(Error::CheckpointCheckout)
        ));

        let empty = tempfile::tempdir().unwrap();
        git(empty.path(), &["init", "-q", "-b", "main"]);
        let key = git(empty.path(), &["rev-parse", "--absolute-git-dir"]);
        let unborn = Checkout::new(Host::Local, key.trim(), Some("main")).unwrap();
        assert!(matches!(
            sh(&script::capture(&unborn, "x", "0000000000000001", KEEP)),
            Err(Error::CheckpointUnborn)
        ));
    }
}
