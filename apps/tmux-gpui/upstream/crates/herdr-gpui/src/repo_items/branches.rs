//! Branches a new checkout could be made from: local branches no worktree has
//! checked out. Read from the repository's own refs with one bounded Git call
//! off the UI thread.

use super::model::branch_name;
use crate::{
    Error,
    pull_request::{Input, clean, repository_key, run},
};
use std::{
    collections::HashSet,
    path::Path,
    process::Command,
    time::{Duration, Instant},
};

const TIMEOUT: Duration = Duration::from_secs(10);
/// Rows kept for the picker. Refs are sorted newest first, so the cap drops
/// only the branches least likely to be wanted.
const LIMIT: usize = 500;
const FORMAT: &str = "%(refname)%00%(worktreepath)";

/// A local branch without a checkout.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Branch {
    pub name: String,
}

impl Branch {
    pub(crate) fn matches(&self, query: &str) -> bool {
        self.name.to_lowercase().contains(query)
    }
}

/// List the branches of the workspace's repository, most recent first.
pub(crate) fn list(input: &Input, cancelled: &impl Fn() -> bool) -> crate::Result<Vec<Branch>> {
    let deadline = Instant::now() + TIMEOUT;
    let repo_key = repository_key(input, deadline, cancelled)?;
    if !Path::new(&repo_key).is_absolute() {
        return Err(Error::PrAbsolutePath);
    }
    let mut command = Command::new("git");
    command
        .args(["-c", "core.fsmonitor=false", "--git-dir", &repo_key])
        .args(["for-each-ref", "--sort=-committerdate"])
        .arg(format!("--format={FORMAT}"))
        .arg("refs/heads");
    let (ok, output) = run(&mut command, deadline, cancelled)?;
    if !ok {
        return Err(Error::GitFailed {
            operation: "list branches",
            details: clean(output.trim()),
        });
    }
    Ok(parse(&output))
}

/// Keep what a new checkout could use. A branch that some worktree has checked
/// out is already somewhere, and Git refuses a second checkout of it.
pub(super) fn parse(output: &str) -> Vec<Branch> {
    let mut seen = HashSet::new();
    output
        .lines()
        .filter_map(|line| {
            let (name, worktree) = line.split_once('\0')?;
            let name = name.strip_prefix("refs/heads/")?;
            worktree.is_empty().then_some(name)
        })
        .filter_map(|name| {
            let name = branch_name(name)?;
            seen.insert(name.clone()).then_some(Branch { name })
        })
        .take(LIMIT)
        .collect()
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn only_branches_without_a_checkout_are_offered() {
        let output = [
            "refs/heads/main\0/repo",
            "refs/heads/feature/login\0",
            "refs/heads/worktree/brave-river\0/worktrees/brave-river",
            "refs/remotes/origin/fix/crash\0",
            "refs/heads/-hostile\0",
            "not a ref line",
        ]
        .join("\n");
        assert_eq!(
            parse(&output),
            vec![Branch {
                name: "feature/login".into()
            }]
        );
    }

    /// Against a real repository: a branch another worktree has checked out is
    /// left out, one no worktree has is offered.
    #[test]
    fn a_real_repository_lists_its_branches_without_a_checkout() {
        let temporary = tempfile::tempdir().unwrap();
        // A regular empty file works with Git on Windows ARM64, unlike NUL.
        let config = temporary.path().join("gitconfig");
        std::fs::write(&config, "").unwrap();
        let repo = temporary.path().join("repo");
        let git = |args: &[&str]| {
            let output = Command::new("git")
                .env("GIT_CONFIG_GLOBAL", &config)
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .args([
                    "-c",
                    "core.fsmonitor=false",
                    "-c",
                    "user.email=test@example.invalid",
                ])
                .args(["-c", "user.name=Test", "-C"])
                .arg(&repo)
                .args(args)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
        };
        std::fs::create_dir_all(&repo).unwrap();
        git(&["init", "--initial-branch=main"]);
        git(&["commit", "--allow-empty", "--message=start"]);
        git(&["branch", "idle"]);
        git(&["branch", "busy"]);
        let busy = temporary.path().join("busy");
        git(&["worktree", "add", &busy.to_string_lossy(), "busy"]);
        let input = Input {
            checkout: None,
            repo_key: Some(repo.join(".git").to_string_lossy().into_owned()),
            branch: "main".into(),
        };
        let branches = list(&input, &|| false).unwrap();
        assert_eq!(
            branches,
            vec![Branch {
                name: "idle".into()
            }]
        );
    }

    #[test]
    fn a_relative_repository_is_refused_before_git_runs() {
        let input = Input {
            checkout: None,
            repo_key: Some("relative/.git".into()),
            branch: "main".into(),
        };
        assert!(matches!(
            list(&input, &|| false),
            Err(Error::PrAbsolutePath)
        ));
    }
}
