use super::*;
use herdr_client::ConnectTarget;
use std::{fs, path::Path, process::Command};

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

fn write(path: &Path, bytes: &[u8]) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, bytes).unwrap();
}

struct Fixture {
    _temp: tempfile::TempDir,
    source: std::path::PathBuf,
    checkout: std::path::PathBuf,
    destination: std::path::PathBuf,
}

/// A source repo with a linked `feature` worktree holding one new commit and
/// every kind of uncommitted change, and a destination clone that predates it.
fn fixture() -> Fixture {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source repo");
    fs::create_dir(&source).unwrap();
    git(&source, &["init", "-q", "-b", "main"]);
    write(&source.join("keep.txt"), b"keep\n");
    write(&source.join("gone.txt"), b"to delete\n");
    write(&source.join("edit.txt"), b"one\n");
    write(&source.join(".gitignore"), b"secret.env\n.herdr/\n");
    git(&source, &["add", "-A"]);
    git(&source, &["commit", "-q", "-m", "base"]);
    let destination = temp.path().join("destination");
    git(
        temp.path(),
        &[
            "clone",
            "-q",
            source.to_str().unwrap(),
            destination.to_str().unwrap(),
        ],
    );
    let checkout = temp.path().join("feature's checkout");
    git(
        &source,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "feature",
            checkout.to_str().unwrap(),
        ],
    );
    write(&checkout.join("committed.txt"), b"committed\n");
    git(&checkout, &["add", "committed.txt"]);
    git(&checkout, &["commit", "-q", "-m", "feature work"]);
    // Staged, then modified again: index and working tree differ.
    write(&checkout.join("edit.txt"), b"staged\n");
    git(&checkout, &["add", "edit.txt"]);
    write(&checkout.join("edit.txt"), b"staged\nand unstaged\n");
    write(&checkout.join("staged-new.txt"), b"new in index\n");
    git(&checkout, &["add", "staged-new.txt"]);
    fs::remove_file(checkout.join("gone.txt")).unwrap();
    write(
        &checkout.join("dir/untracked.bin"),
        &[0, 159, 146, 150, 255, 0],
    );
    write(&checkout.join("secret.env"), b"ignored\n");
    // A handoff note under an ignored `.herdr` still travels.
    write(
        &checkout.join(".herdr/teleport/handoff-1.md"),
        b"next steps\n",
    );
    Fixture {
        _temp: temp,
        source,
        checkout,
        destination,
    }
}

fn key(repo: &Path) -> String {
    let common = git(repo, &["rev-parse", "--git-common-dir"]);
    let common = Path::new(common.trim());
    if common.is_absolute() {
        common.to_string_lossy().into_owned()
    } else {
        repo.join(common).to_string_lossy().into_owned()
    }
}

#[test]
fn a_teleported_checkout_matches_its_source_exactly() {
    let fx = fixture();
    let host = Host::new(&ConnectTarget::Local).unwrap();
    let cancelled = AtomicBool::new(false);
    let checkout = fx.checkout.to_str().unwrap();
    let source_index = git(&fx.checkout, &["write-tree"]);
    let source_status = git(&fx.checkout, &["status", "--porcelain=v1"]);

    let state = source_state(&host, checkout, &cancelled).unwrap();
    assert_eq!(state.branch.as_deref(), Some("feature"));
    assert_eq!(state.head, git(&fx.checkout, &["rev-parse", "HEAD"]).trim());
    assert_eq!(state.untracked, 1);
    assert_eq!(state.changed, 4);

    let dest_key = key(&fx.destination);
    let dest = destination_branch(&host, &dest_key, "feature", &cancelled).unwrap();
    assert_eq!(dest.tip, None);
    assert_eq!(dest.checked_out, None);
    assert!(!dest.tips.is_empty());
    check_destination(&host, checkout, "feature", &dest, &cancelled).unwrap();

    let reference = "refs/herdr-teleport/test";
    let mut bundle = tempfile::tempfile().unwrap();
    capture(
        &host,
        checkout,
        reference,
        &dest.tips,
        &mut bundle,
        &cancelled,
    )
    .unwrap();
    // The source is untouched: index, working tree, and no leftover reference.
    assert_eq!(git(&fx.checkout, &["write-tree"]), source_index);
    assert_eq!(
        git(&fx.checkout, &["status", "--porcelain=v1"]),
        source_status
    );
    assert!(git(&fx.source, &["for-each-ref", "refs/herdr-teleport"]).is_empty());

    use std::io::Seek;
    bundle.rewind().unwrap();
    let uploaded = upload(&host, bundle, &cancelled).unwrap();
    fetch(&host, &dest_key, &uploaded, reference, &cancelled).unwrap();
    advance_branch(&host, &dest_key, "feature", reference, &cancelled).unwrap();
    discard_upload(&host, &uploaded, &cancelled).unwrap();
    assert!(!Path::new(&uploaded).exists());
    assert!(!Path::new(&uploaded).parent().unwrap().exists());

    // Herdr's `worktree create` runs `git worktree add <path> <branch>` for an
    // existing branch; do the same here.
    let moved = fx.destination.parent().unwrap().join("moved checkout");
    git(
        &fx.destination,
        &["worktree", "add", "-q", moved.to_str().unwrap(), "feature"],
    );
    restore(&host, moved.to_str().unwrap(), reference, &cancelled).unwrap();

    assert_eq!(
        git(&moved, &["rev-parse", "HEAD"]),
        git(&fx.checkout, &["rev-parse", "HEAD"])
    );
    assert_eq!(git(&moved, &["write-tree"]), source_index);
    assert_eq!(git(&moved, &["status", "--porcelain=v1"]), source_status);
    assert_eq!(
        fs::read(moved.join("dir/untracked.bin")).unwrap(),
        [0, 159, 146, 150, 255, 0]
    );
    assert_eq!(
        fs::read(moved.join("edit.txt")).unwrap(),
        b"staged\nand unstaged\n"
    );
    assert!(!moved.join("gone.txt").exists());
    assert!(
        !moved.join("secret.env").exists(),
        "ignored files stay behind"
    );
    assert_eq!(
        fs::read(moved.join(".herdr/teleport/handoff-1.md")).unwrap(),
        b"next steps\n"
    );
    assert!(git(&fx.destination, &["for-each-ref", "refs/herdr-teleport"]).is_empty());

    // Moving again finds the branch checked out on the destination.
    let again = destination_branch(&host, &dest_key, "feature", &cancelled).unwrap();
    assert_eq!(again.tip.as_deref(), Some(state.head.as_str()));
    assert!(matches!(
        check_destination(&host, checkout, "feature", &again, &cancelled),
        Err(Error::BranchCheckedOut { .. })
    ));
}

#[test]
fn a_diverged_destination_branch_is_refused() {
    let fx = fixture();
    let host = Host::new(&ConnectTarget::Local).unwrap();
    let cancelled = AtomicBool::new(false);
    git(&fx.destination, &["branch", "feature"]);
    write(&fx.destination.join("elsewhere.txt"), b"x\n");
    git(&fx.destination, &["switch", "-q", "feature"]);
    git(&fx.destination, &["add", "-A"]);
    git(&fx.destination, &["commit", "-q", "-m", "diverge"]);
    git(&fx.destination, &["switch", "-q", "main"]);
    let dest = destination_branch(&host, &key(&fx.destination), "feature", &cancelled).unwrap();
    assert!(dest.tip.is_some());
    assert!(matches!(
        check_destination(
            &host,
            fx.checkout.to_str().unwrap(),
            "feature",
            &dest,
            &cancelled
        ),
        Err(Error::BranchDiverged { .. })
    ));
}

#[test]
fn remotes_are_read_per_repository() {
    let fx = fixture();
    let host = Host::new(&ConnectTarget::Local).unwrap();
    git(
        &fx.source,
        &["remote", "add", "origin", "git@github.com:me/repo.git"],
    );
    let keys = vec![
        key(&fx.source),
        key(&fx.destination),
        "/nonexistent/.git".to_owned(),
    ];
    let remotes = remotes(&host, &keys, &AtomicBool::new(false)).unwrap();
    assert_eq!(remotes[&keys[0]][0].1.as_str(), "github.com/me/repo");
    // The clone's origin is a local path, which never identifies a repository.
    assert!(remotes[&keys[1]].is_empty());
    assert!(remotes[&keys[2]].is_empty());
}

#[test]
fn parsers_tolerate_partial_output() {
    assert_eq!(parse_source_state(""), SourceState::default());
    let parsed = parse_destination_branch(
        "\n\u{1e}\nworktree /r\nHEAD abc\nbranch refs/heads/main\n\nworktree /w/f x\nbranch refs/heads/f\n\u{1e}\nnot-a-sha\n",
        "f",
    );
    assert_eq!(parsed.tip, None);
    assert_eq!(parsed.checked_out.as_deref(), Some("/w/f x"));
    assert!(parsed.tips.is_empty());
}

#[test]
fn a_branch_whose_commits_the_destination_has_still_moves() {
    // As when the branch was pushed and the destination fetched it: every
    // commit is excluded from the bundle, which then drops the branch ref.
    let fx = fixture();
    let host = Host::new(&ConnectTarget::Local).unwrap();
    let cancelled = AtomicBool::new(false);
    git(
        &fx.destination,
        &[
            "fetch",
            "-q",
            fx.source.to_str().unwrap(),
            "feature:refs/remotes/origin/feature",
        ],
    );
    let dest_key = key(&fx.destination);
    let dest = destination_branch(&host, &dest_key, "feature", &cancelled).unwrap();
    let reference = "refs/herdr-teleport/pushed";
    let mut bundle = tempfile::tempfile().unwrap();
    capture(
        &host,
        fx.checkout.to_str().unwrap(),
        reference,
        &dest.tips,
        &mut bundle,
        &cancelled,
    )
    .unwrap();
    use std::io::Seek;
    bundle.rewind().unwrap();
    let uploaded = upload(&host, bundle, &cancelled).unwrap();
    fetch(&host, &dest_key, &uploaded, reference, &cancelled).unwrap();
    advance_branch(&host, &dest_key, "feature", reference, &cancelled).unwrap();
    discard_upload(&host, &uploaded, &cancelled).unwrap();
    assert_eq!(
        git(&fx.destination, &["rev-parse", "feature"]),
        git(&fx.checkout, &["rev-parse", "HEAD"])
    );
}

/// Capture `from`'s work, carry it into `to_key`, and return the reference.
fn carry(host: &Host, from: &Path, to_key: &str, branch: &str, name: &str) -> String {
    let cancelled = AtomicBool::new(false);
    let dest = destination_branch(host, to_key, branch, &cancelled).unwrap();
    let reference = format!("refs/herdr-teleport/{name}");
    let mut bundle = tempfile::tempfile().unwrap();
    capture(
        host,
        from.to_str().unwrap(),
        &reference,
        &dest.tips,
        &mut bundle,
        &cancelled,
    )
    .unwrap();
    use std::io::Seek;
    bundle.rewind().unwrap();
    let uploaded = upload(host, bundle, &cancelled).unwrap();
    fetch(host, to_key, &uploaded, &reference, &cancelled).unwrap();
    discard_upload(host, &uploaded, &cancelled).unwrap();
    reference
}

#[test]
fn teleporting_back_reclaims_the_old_checkout_and_keeps_a_backup() {
    let fx = fixture();
    let host = Host::new(&ConnectTarget::Local).unwrap();
    let cancelled = AtomicBool::new(false);
    let dest_key = key(&fx.destination);
    let forward = carry(&host, &fx.checkout, &dest_key, "feature", "forward");
    advance_branch(&host, &dest_key, "feature", &forward, &cancelled).unwrap();
    let moved = fx.destination.parent().unwrap().join("moved");
    git(
        &fx.destination,
        &["worktree", "add", "-q", moved.to_str().unwrap(), "feature"],
    );
    restore(&host, moved.to_str().unwrap(), &forward, &cancelled).unwrap();

    // Work continues on the destination; the old checkout picks up a stray file.
    git(&moved, &["add", "-A"]);
    git(&moved, &["commit", "-q", "-m", "more work"]);
    write(&moved.join("edit.txt"), b"back home\n");
    write(&fx.checkout.join("stray.txt"), b"left behind\n");

    let back = carry(&host, &moved, &key(&fx.source), "feature", "back");
    let backup = "refs/herdr-teleport/backup/test";
    reclaim(
        &host,
        fx.checkout.to_str().unwrap(),
        &back,
        backup,
        &cancelled,
    )
    .unwrap();

    assert_eq!(
        git(&fx.checkout, &["rev-parse", "HEAD"]),
        git(&moved, &["rev-parse", "HEAD"])
    );
    assert_eq!(
        git(&fx.checkout, &["rev-parse", "feature"]),
        git(&moved, &["rev-parse", "HEAD"])
    );
    assert_eq!(
        git(&fx.checkout, &["status", "--porcelain=v1"]),
        git(&moved, &["status", "--porcelain=v1"])
    );
    assert!(!fx.checkout.join("stray.txt").exists());
    // Nothing the old checkout held is lost: the backup has the stray file.
    assert_eq!(
        git(&fx.source, &["show", &format!("{backup}:stray.txt")]),
        "left behind\n"
    );
    assert!(git(&fx.source, &["for-each-ref", "refs/herdr-teleport/back"]).is_empty());
}
