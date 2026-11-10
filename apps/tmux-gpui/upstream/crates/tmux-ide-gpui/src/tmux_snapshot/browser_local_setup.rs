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
    pub fn label(self) -> &'static str {
        match self {
            Self::Available => "Set up local sessions",
            Self::Running => "Setting up…",
            Self::Failed | Self::StoppedWaiting => "Retry setup",
            Self::Missing | Self::Unsupported | Self::Unrecognized => "Refresh sessions",
        }
    }
    pub fn guidance(self) -> &'static str {
        match self {
            Self::Available => "Set up local sessions to start the local daemon.",
            Self::Running => "Setting up local sessions. Waiting for the local connection.",
            Self::Missing => "Install the tmux-ide CLI to set up local sessions, then refresh.",
            Self::Unsupported => {
                "This app can't set up this version of the tmux-ide CLI. Update the app and the CLI, then refresh."
            }
            Self::Unrecognized => {
                "The tmux-ide CLI installation wasn't recognized. Reinstall the CLI, then refresh."
            }
            Self::Failed => {
                "Local setup could not be confirmed. Retry setup, or use Copy diagnostics in the F5 menu."
            }
            Self::StoppedWaiting => "Setup has not been confirmed. Retry setup to check again.",
        }
    }
}
