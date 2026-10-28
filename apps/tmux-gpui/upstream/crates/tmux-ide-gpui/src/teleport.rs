//! Teleport: move a linked worktree to another connected host with its
//! branch, commits, uncommitted changes, tabs, running programs, and agent
//! sessions, then close the source workspace while keeping its checkout.
//!
//! The GUI connection's method allowlist lacks layouts, process details, and
//! agent sessions, so every step runs as a background script that calls Git
//! and the `herdr` CLI on the host concerned (locally or over SSH).

mod credentials;
mod error;
mod fresh;
mod git;
mod host;
mod job;
mod launch;
mod layout;
mod marks;
mod provision;
mod remote;
mod sessions;
mod snapshot;
mod ui;

pub(crate) use {
    error::{Error, Step},
    fresh::{
        Created, Naming, NewCheckout, Origin as FreshOrigin, Prepared, base_commit,
        dispatch_workspace, dispatch_worktree, prepare,
    },
    host::Host,
    job::{HostRepositories, Place, Retired, Source, open_repositories},
    launch::AgentKind,
    marks::{Mark, Marks},
    snapshot::{Envelope, ProcessInfo, ProcessInfoResult, WorktreeCreated},
    ui::{Follow, Teleport},
};
#[cfg(test)]
pub(crate) use {job::Repository, marks::Destination as MarkDestination};

/// The host Teleport scripts for an endpoint, if it can script it at all.
pub(crate) fn host_for(target: &herdr_client::ConnectTarget) -> error::Result<Host> {
    Host::new(target)
}

// Host scripts need /bin/sh; Teleport is not offered on other clients.
#[cfg(all(test, any(target_os = "linux", target_os = "macos")))]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod live_tests;
