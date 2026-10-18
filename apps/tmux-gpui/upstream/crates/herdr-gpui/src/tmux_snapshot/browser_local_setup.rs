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
    Unsupported,
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
            Self::Missing | Self::Unsupported => "Refresh sessions",
        }
    }
    pub fn guidance(self) -> &'static str {
        match self {
            Self::Available => "Set up local sessions to start the local daemon.",
            Self::Running => "Setting up local sessions. Waiting for the local connection.",
            Self::Missing => "Install the tmux-ide CLI to set up local sessions, then refresh.",
            Self::Unsupported => {
                "This CLI installation is not supported for automatic setup. Check for an app and CLI update, then refresh."
            }
            Self::Failed => {
                "Local setup could not be confirmed. Retry setup, or use Copy diagnostics in the F5 menu."
            }
            Self::StoppedWaiting => "Setup has not been confirmed. Retry setup to check again.",
        }
    }
}
