//! Shared producer implementation used by the GUI qualification harness and
//! external pixel applications. The SDK owns authentication and buffer lifetime.
pub use tmux_native_surface_sdk::{Error, Producer};

#[cfg(test)]
#[path = "tmux_native_surface_producer_live_tests.rs"]
mod live_tests;
