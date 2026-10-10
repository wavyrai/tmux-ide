//! Fan-out: send one prompt to several agents, each in a new worktree branched
//! from the same commit, then compare what they did and keep one.
//!
//! The GUI connection's method allowlist lacks `agent.start` and
//! `agent.prompt`, so, as Teleport does, every step runs as a background host
//! script calling the `herdr` CLI (locally or over SSH). Only existing daemon
//! methods are used: `worktree.create`, `agent.start`, `agent.prompt`, and
//! `worktree.remove`.

mod error;
mod job;
mod plan;
mod spread;
mod state;
mod ui;

pub(crate) use state::{FanOut, Origin};
