//! Explicit local setup availability, published by the bridge; never inferred from text.
use serde::Deserialize;
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(in crate::tmux_snapshot) struct Setup {
    pub phase: Phase,
}
#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub(in crate::tmux_snapshot) enum Phase {
    Available,
    Running,
    Missing,
    /// The CLI version is outside the range this app can set up.
    Unsupported,
    /// The managed installation's files or layout are not what setup expects.
    Unrecognized,
    Failed,
    StoppedWaiting,
}
impl Phase {
    pub fn actionable(self) -> bool {
        matches!(self, Self::Available | Self::Failed | Self::StoppedWaiting)
    }
    /// The button's words, in plain words (onboarding A0: see
    /// connection::jargon for the words that never appear here).
    pub fn label(self) -> &'static str {
        match self {
            Self::Available => "Set up Tmux IDE",
            Self::Running => "Setting up…",
            Self::Failed | Self::StoppedWaiting => "Try again",
            Self::Missing | Self::Unsupported | Self::Unrecognized => "Check again",
        }
    }
    /// What the phase means and what to do, in the onboarding report's words.
    pub fn guidance(self) -> &'static str {
        match self {
            Self::Available => {
                "Set up Tmux IDE to start the background service. It keeps your sessions running when the app is closed."
            }
            Self::Running => "Starting the background service… This takes a few seconds.",
            Self::Missing => {
                "Tmux IDE needs its command-line tool. Install it with one command, then come back here."
            }
            Self::Unsupported => {
                "This version of the command-line tool doesn't match the app. Update both with one command."
            }
            Self::Unrecognized => {
                "The command-line tool's installation wasn't recognized. Reinstall it with one command, then check again."
            }
            Self::Failed => {
                "The background service didn't start. Your files and sessions are fine. Try again, or use Copy diagnostics."
            }
            Self::StoppedWaiting => {
                "The background service hasn't answered yet. Try again to check."
            }
        }
    }
}
