//! Allowlisted owner diagnostics. Catalog availability and action tokens stay authoritative.
use super::{Group, Phase};
use serde::{Deserialize, Serialize};

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(in crate::tmux_snapshot) struct Diagnostic {
    phase: ConnectionPhase,
    failure: Option<Failure>,
}
#[derive(Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum ConnectionPhase {
    Connecting,
    Ready,
    Reconnecting,
    NeedsAttention,
    Disconnected,
}
#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
enum Failure {
    Unavailable,
    IdentityMismatch,
    InvalidTarget,
    InvalidDescriptor,
    Incompatible,
    SshAuthentication,
    SshHostKey,
    RemoteCliMissing,
    DaemonMissing,
}
impl Group {
    /// Whether only the user can bring this machine back (r3): SSH credentials,
    /// host keys, a missing CLI or daemon, a daemon to update, another machine
    /// behind the route. Never retried by itself.
    pub(in crate::tmux_snapshot) fn needs_user(&self) -> bool {
        self.conflict
            || (self.state != Phase::Ready
                && self.diagnostic.as_ref().is_some_and(|d| {
                    matches!(
                        d.failure,
                        Some(
                            Failure::IdentityMismatch
                                | Failure::InvalidTarget
                                | Failure::Incompatible
                                | Failure::SshAuthentication
                                | Failure::SshHostKey
                                | Failure::RemoteCliMissing
                                | Failure::DaemonMissing
                        )
                    )
                }))
    }
    /// The remote daemon speaks a protocol this app does not.
    pub(in crate::tmux_snapshot) fn needs_update(&self) -> bool {
        self.diagnostic
            .as_ref()
            .is_some_and(|d| matches!(d.failure, Some(Failure::Incompatible)))
    }
    pub(in crate::tmux_snapshot) fn connection_hint(&self) -> Option<&'static str> {
        if self.conflict {
            return Some(
                "Machine identity changed. Review the machine settings before reconnecting.",
            );
        }
        if self.state == Phase::Ready {
            return None;
        }
        let diagnostic = self.diagnostic.as_ref()?;
        if diagnostic.phase == ConnectionPhase::Ready {
            // A ready transport does not imply an available catalog.
            return None;
        }
        Some(match diagnostic.failure {
            Some(Failure::Unavailable) => {
                "Cannot reach this machine. Check its connection and SSH access."
            }
            Some(Failure::IdentityMismatch) => {
                "This SSH route reached a different machine. Review its settings."
            }
            Some(Failure::InvalidTarget) => "Check the SSH alias in this machine’s settings.",
            Some(Failure::InvalidDescriptor) => {
                "The remote daemon returned an invalid response. Check its installation."
            }
            Some(Failure::Incompatible) => {
                "The remote daemon needs an update before it can connect."
            }
            Some(Failure::SshAuthentication) => {
                "SSH authentication failed. Check your SSH credentials, then retry."
            }
            Some(Failure::SshHostKey) => {
                "SSH host verification failed. Verify the host in your terminal, then retry."
            }
            Some(Failure::RemoteCliMissing) => {
                "tmux-ide was not found remotely. Check its installation and SSH PATH."
            }
            Some(Failure::DaemonMissing) => {
                "No daemon is running on this machine. Start tmux-ide there to connect."
            }
            None if diagnostic.phase == ConnectionPhase::Reconnecting => {
                "Reconnecting to this machine…"
            }
            None => return None,
        })
    }
}

#[cfg(test)]
#[path = "diagnostic/tests.rs"]
mod tests;
