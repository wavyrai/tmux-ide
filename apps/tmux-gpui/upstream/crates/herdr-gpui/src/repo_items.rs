//! The repository behind a workspace, as a picker: its open pull requests and
//! issues, its branches without a checkout, the branch each one seeds, and the
//! note a created checkout carries about it. Read-only GitHub and Git work runs
//! off the UI thread; no local cache between openings.

mod branches;
mod context;
mod fetch;
mod lookup;
mod model;

#[cfg(test)]
mod tests;

pub(crate) use {
    branches::{Branch, list as list_branches},
    context::write as write_context,
    lookup::Lookup,
    model::{Item, Kind, fork_branch_number},
};

#[cfg(test)]
pub(crate) use model::issue_branch;

/// The GitHub repository a workspace's `origin` remote points at.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct Origin {
    pub owner: String,
    pub repo: String,
}

impl Origin {
    pub(crate) fn slug(&self) -> String {
        format!("{}/{}", self.owner, self.repo)
    }
}
