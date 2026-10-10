//! Teleport failures keep the step they happened in and their typed cause.

/// The part of a teleport that failed, for context in diagnostics.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Step {
    Discover,
    Review,
    Clone,
    Open,
    Handoff,
    Capture,
    Transfer,
    Fetch,
    CreateWorktree,
    Restore,
    Tabs,
    Retire,
    Credentials,
    Sessions,
    Launch,
}

/// The steps of a move, in the order `job::run` reports them. A move skips
/// the ones it does not need, so the bar may jump, but never goes back.
const MOVE: [Step; 13] = [
    Step::Clone,
    Step::Open,
    Step::Handoff,
    Step::Capture,
    Step::Transfer,
    Step::Fetch,
    Step::CreateWorktree,
    Step::Restore,
    Step::Tabs,
    Step::Retire,
    Step::Sessions,
    Step::Credentials,
    Step::Launch,
];

impl Step {
    /// The share of a move already done when this step starts.
    pub(crate) fn progress(self) -> f32 {
        let done = MOVE.iter().position(|step| *step == self).unwrap_or(0);
        done as f32 / MOVE.len() as f32
    }

    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::Discover => "finding matching repositories",
            Self::Review => "reviewing the move",
            Self::Clone => "copying the repository to the destination",
            Self::Open => "opening the repository on the destination",
            Self::Handoff => "asking agents for handoff notes",
            Self::Capture => "capturing commits and changes",
            Self::Transfer => "copying changes to the destination",
            Self::Fetch => "fetching the branch on the destination",
            Self::CreateWorktree => "creating the destination worktree",
            Self::Restore => "restoring uncommitted changes",
            Self::Tabs => "recreating tabs",
            Self::Retire => "stopping programs in the source workspace",
            Self::Credentials => "installing GitHub credentials on the destination",
            Self::Sessions => "moving agent sessions",
            Self::Launch => "starting programs",
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub(crate) enum Error {
    #[error("{} failed: {source}", step.label())]
    Script {
        step: Step,
        #[source]
        source: herdr_client::Error,
    },
    #[error("{} failed: unexpected output", step.label())]
    Decode {
        step: Step,
        #[source]
        source: serde_json::Error,
    },
    #[error(
        "Teleport needs a local session or SSH host; custom socket, WSL, and cloud endpoints are unsupported"
    )]
    UnsupportedHost,
    #[error("The workspace is no longer open on its host")]
    WorkspaceGone,
    #[error("{reference} does not name a commit on the source")]
    NoCommit { reference: String },
    #[error("The checkout is not on a branch (detached HEAD)")]
    DetachedHead,
    #[error("Branch {branch} already exists on the destination with commits this checkout lacks")]
    BranchDiverged { branch: String },
    #[error("Branch {branch} is already checked out on the destination at {path}")]
    BranchCheckedOut { branch: String, path: String },
    #[error("Session file for {agent} was not found on the source host")]
    SessionMissing { agent: &'static str },
    #[error("Could not use a local temporary file")]
    LocalFile(#[source] std::io::Error),
    #[error("The GitHub CLI returned an unexpected token")]
    InvalidToken,
    #[error("Teleport cancelled")]
    Cancelled,
}

pub(crate) type Result<T, E = Error> = std::result::Result<T, E>;

/// `map_err` adapter attaching the step to a script failure.
pub(crate) fn script(step: Step) -> impl FnOnce(herdr_client::Error) -> Error {
    move |source| match source {
        herdr_client::Error::ScriptCancelled => Error::Cancelled,
        source => Error::Script { step, source },
    }
}

/// `map_err` adapter attaching the step to malformed script output.
pub(crate) fn decode(step: Step) -> impl FnOnce(serde_json::Error) -> Error {
    move |source| Error::Decode { step, source }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn move_progress_only_moves_forward() {
        let shares: Vec<f32> = MOVE.iter().map(|step| step.progress()).collect();
        assert_eq!(shares.first(), Some(&0.));
        assert!(shares.windows(2).all(|pair| pair[0] < pair[1]));
        assert!(shares.iter().all(|share| *share < 1.));
        assert_eq!(Step::Discover.progress(), 0.);
    }

    #[test]
    fn script_failures_keep_step_and_source() {
        let error = script(Step::Fetch)(herdr_client::Error::ScriptTimeout);
        assert!(matches!(
            error,
            Error::Script {
                step: Step::Fetch,
                source: herdr_client::Error::ScriptTimeout
            }
        ));
        assert!(std::error::Error::source(&error).is_some());
        assert_eq!(
            error.to_string(),
            "fetching the branch on the destination failed: host script made no progress before its deadline"
        );
        assert!(matches!(
            script(Step::Tabs)(herdr_client::Error::ScriptCancelled),
            Error::Cancelled
        ));
    }
}
