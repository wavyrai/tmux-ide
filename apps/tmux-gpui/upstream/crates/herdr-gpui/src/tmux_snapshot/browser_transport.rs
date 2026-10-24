//! The broker pipe transports metadata and capabilities only; terminals are Rust-owned.
use super::*;
pub(in crate::tmux_snapshot) fn start(kitty: super::super::kitty_graphics::Store) -> Bridge {
    native_transport::start(kitty)
}
#[cfg(test)]
#[path = "browser_transport_tests.rs"]
mod tests;
