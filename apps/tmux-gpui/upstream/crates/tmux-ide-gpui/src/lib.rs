// objc 0.2's selectors expand a legacy cargo-clippy cfg in the native test adapter.
#![cfg_attr(feature = "integration-test", allow(unexpected_cfgs))]

mod actions;
mod app;
mod config;
mod contrast;
mod controls;
mod error;
mod fonts;
mod icons;
mod input;
mod notifications;
mod plural;
mod search_input;
mod sidebar;
mod tab_scroll;
mod terminal;
mod terminal_painter;
mod titlebar;
mod tmux_cli;
#[cfg(target_os = "macos")]
pub mod tmux_native_surface;
mod tmux_snapshot;
mod web_url;
mod window;

#[cfg(feature = "integration-test")]
mod performance;

pub use error::{Error, Result};

pub(crate) use actions::{Quit, RunCommand};

#[cfg(feature = "visual-capture")]
#[doc(hidden)]
pub use tmux_snapshot::visual_capture::capture_catalog_themes;

pub fn run_tmux() -> std::process::ExitCode {
    tmux_cli::run(std::env::args_os().skip(1).collect())
}

/// Opt-in isolated protocol qualification; does not open a desktop window.
#[cfg(feature = "integration-test")]
pub fn run_tmux_journey_probe() -> anyhow::Result<()> {
    tmux_snapshot::journey_probe::run()
}
