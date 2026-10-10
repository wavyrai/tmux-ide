//! What a pull request looks like to this client, and the repository/branch
//! pair a lookup is keyed by. Remote text is untrusted: it is cleaned and
//! length-bounded before it can reach a label.

#[cfg(any(test, all(feature = "integration-test", target_os = "macos")))]
use super::parse::parse;
use crate::Error;
use serde::Deserialize;
use std::path::Path;

/// Where a workspace's checkout lives, which decides how its GitHub
/// repository is identified.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) enum Origin {
    /// This machine: local Git verifies the checkout before trusting it.
    #[default]
    Local,
    /// A saved SSH device, named by its SSH target. Its Git runs there.
    Ssh(String),
}

/// The repository and branch a lookup reads. `repo_key` is the daemon's Git
/// common directory; it is `None` only for a local workspace the daemon has
/// attached no worktree metadata to, where `checkout` is then the workspace
/// directory and the worker asks Git which repository it belongs to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Input {
    pub checkout: Option<String>,
    pub repo_key: Option<String>,
    pub branch: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PullRequest {
    pub number: u64,
    pub url: String,
    pub title: String,
    pub state: State,
    pub is_draft: bool,
    pub head_ref_name: String,
    pub base_ref_name: String,
    pub additions: u64,
    pub deletions: u64,
    pub changed_files: u64,
    pub updated_at: String,
    pub merge_state_status: MergeState,
    #[serde(default)]
    pub review_decision: ReviewDecision,
    #[serde(skip)]
    pub checks_summary: String,
    #[serde(default)]
    pub(super) status_check_rollup: Option<Vec<Check>>,
    pub(super) head_repository_owner: Owner,
    /// GitHub's opaque node ID, the subject of comment and merge mutations.
    /// Empty when absent or malformed, which leaves those actions unavailable.
    #[serde(default)]
    pub id: String,
    /// The head commit the shown checks belong to. A merge names it, so
    /// GitHub refuses one if the branch moved after the user looked.
    #[serde(default)]
    pub head_ref_oid: String,
    /// The merge methods the repository allows, in GitHub's own order.
    #[serde(skip)]
    pub merge_methods: Vec<MergeMethod>,
}

/// How a pull request is merged: GitHub's `PullRequestMergeMethod`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum MergeMethod {
    Merge,
    Squash,
    Rebase,
}

impl MergeMethod {
    pub(crate) const ALL: [Self; 3] = [Self::Merge, Self::Squash, Self::Rebase];

    /// The enum value the `mergePullRequest` mutation takes.
    pub(crate) fn graphql(self) -> &'static str {
        match self {
            Self::Merge => "MERGE",
            Self::Squash => "SQUASH",
            Self::Rebase => "REBASE",
        }
    }

    /// The repository setting that allows this method.
    pub(super) fn setting(self) -> &'static str {
        match self {
            Self::Merge => "mergeCommitAllowed",
            Self::Squash => "squashMergeAllowed",
            Self::Rebase => "rebaseMergeAllowed",
        }
    }

    /// The confirming button's label, as GitHub words it.
    pub(crate) fn action(self) -> &'static str {
        match self {
            Self::Merge => "Create a merge commit",
            Self::Squash => "Squash and merge",
            Self::Rebase => "Rebase and merge",
        }
    }
}

/// GitHub's `PullRequestState`. A value this client does not know is not a
/// lifecycle it can present, so `parse` rejects it as an identity failure
/// rather than showing the PR as open.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(from = "String")]
pub(crate) enum State {
    Open,
    Closed,
    Merged,
    #[default]
    Unknown,
}

impl From<String> for State {
    fn from(value: String) -> Self {
        match value.as_str() {
            "OPEN" => Self::Open,
            "CLOSED" => Self::Closed,
            "MERGED" => Self::Merged,
            _ => Self::Unknown,
        }
    }
}

/// GitHub's `MergeStateStatus`. Unlike the lifecycle this one is advisory, so
/// a value added upstream degrades to "unavailable" instead of failing the
/// lookup. Parsing here is also why the raw field needs no `clean`: an
/// unrecognized string never reaches a label.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(from = "String")]
pub(crate) enum MergeState {
    Clean,
    Dirty,
    Behind,
    Blocked,
    Unstable,
    Draft,
    HasHooks,
    #[default]
    Unknown,
}

impl MergeState {
    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::Clean => "No merge conflicts",
            Self::Dirty => "Merge conflicts",
            Self::Behind => "Branch behind base",
            Self::Blocked => "Merge blocked",
            Self::Unstable => "Checks need attention",
            Self::Draft => "Not ready for review",
            Self::HasHooks => "Merge hooks required",
            Self::Unknown => "Merge status unavailable",
        }
    }
}

impl From<String> for MergeState {
    fn from(value: String) -> Self {
        match value.as_str() {
            "CLEAN" => Self::Clean,
            "DIRTY" => Self::Dirty,
            "BEHIND" => Self::Behind,
            "BLOCKED" => Self::Blocked,
            "UNSTABLE" => Self::Unstable,
            "DRAFT" => Self::Draft,
            "HAS_HOOKS" => Self::HasHooks,
            _ => Self::Unknown,
        }
    }
}

/// GitHub's `PullRequestReviewDecision`, which is null on a PR that needs no
/// review. Deserializing from `Option<String>` absorbs that null, so the
/// GraphQL path does not have to rewrite it first.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(from = "Option<String>")]
pub(crate) enum ReviewDecision {
    Approved,
    ChangesRequested,
    ReviewRequired,
    #[default]
    None,
}

impl ReviewDecision {
    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::Approved => "Approved",
            Self::ChangesRequested => "Changes requested",
            Self::ReviewRequired => "Review required",
            Self::None => "No review decision",
        }
    }
}

impl From<Option<String>> for ReviewDecision {
    fn from(value: Option<String>) -> Self {
        match value.as_deref() {
            Some("APPROVED") => Self::Approved,
            Some("CHANGES_REQUESTED") => Self::ChangesRequested,
            Some("REVIEW_REQUIRED") => Self::ReviewRequired,
            _ => Self::None,
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
pub(super) struct Owner {
    pub(super) login: String,
}

/// One status check. A `StatusContext` reports through `state`; a `CheckRun`
/// reports through `conclusion`, and only once its `status` says it finished.
#[derive(Clone, Debug, Deserialize)]
pub(super) struct Check {
    #[serde(rename = "__typename")]
    kind: CheckKind,
    /// A check run's `name` or a status context's `context`; cleaned on parse.
    #[serde(default, alias = "context")]
    pub(super) name: String,
    #[serde(default)]
    state: Outcome,
    #[serde(default)]
    status: CheckStatus,
    #[serde(default)]
    conclusion: Outcome,
}

impl Check {
    pub(super) fn outcome(&self) -> Outcome {
        match self.kind {
            CheckKind::StatusContext => self.state,
            CheckKind::CheckRun if self.status == CheckStatus::Completed => self.conclusion,
            CheckKind::CheckRun => Outcome::Pending,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(from = "String")]
enum CheckKind {
    StatusContext,
    /// Every other GraphQL check type reports like a check run.
    #[default]
    CheckRun,
}

impl From<String> for CheckKind {
    fn from(value: String) -> Self {
        match value.as_str() {
            "StatusContext" => Self::StatusContext,
            _ => Self::CheckRun,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(from = "Option<String>")]
enum CheckStatus {
    Completed,
    #[default]
    Running,
}

impl From<Option<String>> for CheckStatus {
    fn from(value: Option<String>) -> Self {
        match value.as_deref() {
            Some("COMPLETED") => Self::Completed,
            _ => Self::Running,
        }
    }
}

/// What one check contributes to the summary. Declaration order is the order
/// the summary reads in, and indexes the tally in `checks`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(from = "Option<String>")]
pub(crate) enum Outcome {
    Passed,
    Failed,
    #[default]
    Pending,
    Skipped,
}

impl Outcome {
    pub(super) const ALL: [Self; 4] = [Self::Passed, Self::Failed, Self::Pending, Self::Skipped];
}

impl std::fmt::Display for Outcome {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Passed => "passed",
            Self::Failed => "failed",
            Self::Pending => "pending",
            Self::Skipped => "skipped",
        })
    }
}

impl From<Option<String>> for Outcome {
    fn from(value: Option<String>) -> Self {
        match value.as_deref() {
            Some("SUCCESS") => Self::Passed,
            Some(
                "FAILURE" | "ERROR" | "CANCELLED" | "TIMED_OUT" | "ACTION_REQUIRED"
                | "STARTUP_FAILURE" | "STALE",
            ) => Self::Failed,
            Some("NEUTRAL" | "SKIPPED") => Self::Skipped,
            _ => Self::Pending,
        }
    }
}

impl PullRequest {
    /// Shared by sidebar and titlebar badges and the workspace menu, inked to
    /// read on the chrome they sit on.
    pub fn color(&self, theme: &crate::config::Theme) -> u32 {
        theme.ink(self.hue(theme))
    }

    /// Lifecycle takes precedence; an open PR is green only when no known
    /// blocker remains.
    fn hue(&self, theme: &crate::config::Theme) -> u32 {
        match self.state {
            State::Merged => return theme.palette[5],
            State::Closed => return theme.palette[1],
            State::Unknown => return theme.muted,
            State::Open if self.is_draft => return theme.muted,
            State::Open => {}
        }
        let has_check = |outcome| {
            self.status_check_rollup
                .iter()
                .flatten()
                .any(|check| check.outcome() == outcome)
        };
        // GitHub also reports UNSTABLE while checks are still running, so it
        // only means attention once nothing is pending; failed checks are
        // caught directly.
        let running = has_check(Outcome::Pending);
        if self.merge_state_status == MergeState::Dirty
            || (self.merge_state_status == MergeState::Unstable && !running)
            || self.review_decision == ReviewDecision::ChangesRequested
            || has_check(Outcome::Failed)
        {
            return theme.palette[1];
        }
        if running || self.review_decision == ReviewDecision::ReviewRequired {
            return theme.palette[3];
        }
        match self.merge_state_status {
            MergeState::Clean => theme.palette[2],
            // ANSI's extended orange distinguishes a blocked/behind branch
            // from pending checks without borrowing a lifecycle color.
            MergeState::Blocked | MergeState::Behind => theme.palette[208],
            _ => theme.palette[3],
        }
    }

    pub fn lifecycle(&self) -> &'static str {
        match self.state {
            State::Merged => "Merged",
            State::Closed => "Closed",
            _ if self.is_draft => "Draft",
            _ => "Open",
        }
    }

    /// Each reported check by name, in GitHub's order, for the checks list.
    pub fn check_list(&self) -> impl Iterator<Item = (&str, Outcome)> {
        self.status_check_rollup
            .iter()
            .flatten()
            .map(|check| (check.name.as_str(), check.outcome()))
    }

    pub fn checks(&self) -> String {
        let mut counts = [0usize; Outcome::ALL.len()];
        for check in self.status_check_rollup.iter().flatten() {
            counts[check.outcome() as usize] += 1;
        }
        if counts.iter().all(|count| *count == 0) {
            return "No checks reported".into();
        }
        Outcome::ALL
            .into_iter()
            .map(|outcome| (counts[outcome as usize], outcome))
            .filter(|(count, _)| *count > 0)
            .map(|(count, label)| format!("{count} {label}"))
            .collect::<Vec<_>>()
            .join(" / ")
    }

    /// The outcome the checks add up to: any failure, else anything still
    /// running, else passed. `None` when nothing but skipped checks reported.
    pub fn checks_outcome(&self) -> Option<Outcome> {
        let outcomes = || self.check_list().map(|(_, outcome)| outcome);
        [Outcome::Failed, Outcome::Pending, Outcome::Passed]
            .into_iter()
            .find(|wanted| outcomes().any(|outcome| outcome == *wanted))
    }

    pub fn merge_status(&self) -> &'static str {
        self.merge_state_status.label()
    }

    pub fn review(&self) -> &'static str {
        self.review_decision.label()
    }
}

/// Daemon worktree metadata as a lookup key. The checkout is resolved later,
/// from Git's own registry, so a workspace never points work at another tree.
pub(crate) fn repository_input(
    worktree: Option<&herdr_client::protocol::ClientShellWorktree>,
    branch: Option<&str>,
) -> crate::Result<Input> {
    let key = worktree
        .map(|tree| tree.key.as_str())
        .ok_or(Error::PrMetadata)?;
    let branch = valid_branch(branch)?;
    if !Path::new(key).is_absolute() {
        return Err(Error::PrAbsolutePath);
    }
    Ok(Input {
        checkout: None,
        repo_key: Some(key.into()),
        branch: branch.into(),
    })
}

/// A workspace's lookup key. Daemon worktree metadata wins; the daemon only
/// attaches it once a worktree was made through Herdr, so a local workspace
/// that merely sits in a repository falls back to its directory. Its
/// repository is resolved by Git on the worker, and the checkout is still
/// verified against the branch before anything is read. Remote devices keep
/// requiring metadata: their directories are not this machine's.
pub(crate) fn workspace_input(
    workspace: &herdr_client::protocol::ClientShellWorkspace,
    origin: &Origin,
) -> crate::Result<Input> {
    let worktree = workspace.worktree.as_ref();
    let branch = workspace.branch.as_deref();
    if worktree.is_some() || *origin != Origin::Local || workspace.new_workspace_cwd.is_empty() {
        return repository_input(worktree, branch);
    }
    let branch = valid_branch(branch)?;
    if !Path::new(&workspace.new_workspace_cwd).is_absolute() {
        return Err(Error::PrAbsolutePath);
    }
    Ok(Input {
        checkout: Some(workspace.new_workspace_cwd.clone()),
        repo_key: None,
        branch: branch.into(),
    })
}

fn valid_branch(branch: Option<&str>) -> crate::Result<&str> {
    branch
        .filter(|branch| {
            !branch.is_empty() && branch.len() <= 1024 && !branch.chars().any(char::is_control)
        })
        .ok_or(Error::PrBranch)
}

pub(crate) fn clean(text: &str) -> String {
    text.chars()
        .take(512)
        .map(|c| {
            if c.is_control() || matches!(c, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}') {
                ' '
            } else {
                c
            }
        })
        .collect()
}

#[cfg(any(test, all(feature = "integration-test", target_os = "macos")))]
pub(crate) fn fixture() -> crate::Result<PullRequest> {
    parse(&serde_json::json!([{
        "number": 8, "url": "https://github.com/example/project/pull/8",
        "title": "Improve workspace context menus with a deliberately long PR title for narrow native layouts",
        "state": "OPEN", "isDraft": false, "headRefName": "feature", "baseRefName": "main",
        "additions": 1730, "deletions": 31, "changedFiles": 16,
        "updatedAt": "2026-09-20T12:00:00Z", "mergeStateStatus": "BLOCKED", "reviewDecision": "REVIEW_REQUIRED",
        "headRepositoryOwner": {"login": "example"},
        "id": "PR_kwDOfixture8", "headRefOid": "0123456789abcdef0123456789abcdef01234567",
        "statusCheckRollup": [
            {"__typename": "CheckRun", "name": "test", "status": "COMPLETED", "conclusion": "SUCCESS"},
            {"__typename": "StatusContext", "context": "ci/lint", "state": "FAILURE"},
            {"__typename": "CheckRun", "name": "build", "status": "IN_PROGRESS", "conclusion": null}
        ]
    }]).to_string(), "example", "project", "feature")?
    .map(|mut pr| {
        pr.merge_methods = MergeMethod::ALL.to_vec();
        pr
    })
    .ok_or(Error::PrRepository)
}
