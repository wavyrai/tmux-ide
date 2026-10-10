//! Read-only PR prefetch. One worker, bounded memory, and no UI-thread I/O.
//! Writes to a pull request live in `pr_actions`, behind explicit user actions.

mod cache;
mod fetch;
mod lookup;
mod model;
mod parse;

#[cfg(test)]
mod tests;

pub(crate) use {
    cache::Cache,
    fetch::{local_checkout, origin_repository, run, run_bytes},
    lookup::Lookup,
    model::{
        Input, MergeMethod, Origin, Outcome, PullRequest, ReviewDecision, State, clean,
        repository_input, workspace_input,
    },
};

pub(crate) use fetch::{local_repository, repository_key};
#[cfg(any(test, all(feature = "integration-test", target_os = "macos")))]
pub(crate) use model::fixture;

use fetch::{Origins, fetch_with_backoff};
use parse::{parse_graphql, parse_numbered};

/// Absence is a successful lookup with no PR, not an error.
type Result = crate::Result<Option<PullRequest>>;
