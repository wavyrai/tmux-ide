//! A local workspace the daemon has attached no worktree metadata to is
//! looked up from its own directory, and still verified like any other.

use super::*;
use crate::pull_request::{local_checkout, repository_key, workspace_input};
use herdr_client::protocol::{ClientShellWorkspace, ClientShellWorktree};

fn workspace(cwd: &str, branch: Option<&str>) -> ClientShellWorkspace {
    let mut workspace = crate::sidebar::layout_tests::snapshot(1)
        .workspaces
        .remove(0);
    workspace.new_workspace_cwd = cwd.into();
    workspace.branch = branch.map(Into::into);
    workspace.worktree = None;
    workspace
}

fn git(directory: &std::path::Path, args: &[&str]) {
    let mut command = Command::new("git");
    command.arg("-C").arg(directory).args(args);
    let (ok, text) = run(&mut command, Instant::now() + TIMEOUT, &|| false).unwrap();
    assert!(ok, "fixture git failed: {text}");
}

#[test]
fn a_branch_only_local_workspace_is_looked_up_from_its_directory() {
    let cwd = std::env::temp_dir().join("repo/src");
    let cwd = cwd.to_str().unwrap();
    let input = workspace_input(&workspace(cwd, Some("main")), &Origin::Local).unwrap();
    assert_eq!(
        input,
        Input {
            checkout: Some(cwd.into()),
            repo_key: None,
            branch: "main".into(),
        }
    );
}

#[test]
fn daemon_metadata_still_wins_and_remote_devices_still_require_it() {
    let cwd = std::env::temp_dir().join("repo");
    let cwd = cwd.to_str().unwrap();
    let key = std::env::temp_dir().join("other/.git");
    let mut known = workspace(cwd, Some("main"));
    known.worktree = Some(ClientShellWorktree {
        key: key.to_str().unwrap().into(),
        label: "other".into(),
        is_linked_worktree: false,
    });
    let input = workspace_input(&known, &Origin::Local).unwrap();
    assert_eq!(input.repo_key.as_deref(), key.to_str());
    assert_eq!(input.checkout, None, "metadata never trusts the directory");
    // A saved device's directory is not on this machine.
    assert!(matches!(
        workspace_input(&workspace(cwd, Some("main")), &Origin::Ssh("device".into())),
        Err(Error::PrMetadata)
    ));
    assert!(matches!(
        workspace_input(&workspace("", Some("main")), &Origin::Local),
        Err(Error::PrMetadata)
    ));
    assert!(matches!(
        workspace_input(&workspace("relative", Some("main")), &Origin::Local),
        Err(Error::PrAbsolutePath)
    ));
    for branch in [None, Some(""), Some("bad\nbranch")] {
        assert!(matches!(
            workspace_input(&workspace(cwd, branch), &Origin::Local),
            Err(Error::PrBranch)
        ));
    }
}

#[test]
fn the_worker_resolves_the_directory_and_verifies_repository_and_branch() {
    let directory = tempfile::tempdir().unwrap();
    let repo = directory.path().join("repo");
    let nested = repo.join("src/deep");
    std::fs::create_dir_all(&nested).unwrap();
    git(&repo, &["init", "--quiet", "--template=", "-b", "feature"]);
    git(
        &repo,
        &[
            "config",
            "--local",
            "remote.origin.url",
            "git@github.com:example/project.git",
        ],
    );
    let deadline = || Instant::now() + TIMEOUT;
    let mut input = workspace_input(
        &workspace(nested.to_str().unwrap(), Some("feature")),
        &Origin::Local,
    )
    .unwrap();
    let key = repository_key(&input, deadline(), &|| false).unwrap();
    assert_eq!(
        std::path::Path::new(&key).canonicalize().unwrap(),
        repo.join(".git").canonicalize().unwrap()
    );
    // The checkout is the repository's top level, not the subdirectory.
    let checkout = local_checkout(&input, deadline(), &|| false).unwrap();
    assert_eq!(
        std::path::Path::new(&checkout).canonicalize().unwrap(),
        repo.canonicalize().unwrap()
    );
    assert_eq!(
        local_repository(&input, deadline(), &|| false).unwrap(),
        ("example".into(), "project".into())
    );

    // HEAD is on another branch than the daemon reports.
    input.branch = "main".into();
    assert!(matches!(
        local_checkout(&input, deadline(), &|| false),
        Err(Error::PrBranchChanged)
    ));
    input.branch = "feature".into();

    // A daemon key for a different repository is still a mismatch, even
    // with a checkout path in hand.
    let other = directory.path().join("other");
    std::fs::create_dir(&other).unwrap();
    git(&other, &["init", "--quiet", "--template=", "-b", "feature"]);
    input.repo_key = Some(other.join(".git").to_str().unwrap().into());
    input.checkout = Some(repo.to_str().unwrap().into());
    assert!(matches!(
        local_checkout(&input, deadline(), &|| false),
        Err(Error::PrRepositoryMismatch)
    ));

    // A directory outside any repository says so instead of guessing.
    let plain = directory.path().join("plain");
    std::fs::create_dir(&plain).unwrap();
    let outside = workspace_input(
        &workspace(plain.to_str().unwrap(), Some("feature")),
        &Origin::Local,
    )
    .unwrap();
    assert!(matches!(
        local_checkout(&outside, deadline(), &|| false),
        Err(Error::PrWorkspaceRepository)
    ));
}
