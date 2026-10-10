//! Which side of a refused handshake must be updated, so the owner can tell
//! the user what to do instead of reporting a protocol error.

use crate::Error;
use herdr_protocol::endpoint::ENDPOINT_PROTOCOL_GENERATION;

/// The first Herdr release with the endpoint protocol this client speaks.
pub const MIN_HERDR_VERSION: &str = "0.9.0";

/// Daemon version text is untrusted; keep only a short, printable label.
const MAX_VERSION_CHARS: usize = 64;

/// A daemon and this client cannot talk until one of them is updated.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VersionMismatch {
    /// The daemon lacks the protocol or a capability this client requires.
    /// `None` when it is too old to report its version over the endpoint.
    DaemonOutdated { server_version: Option<String> },
    /// The daemon speaks a newer endpoint generation than this client.
    ClientOutdated { server_version: Option<String> },
}

impl VersionMismatch {
    /// The daemon's reported version, bounded and stripped of controls.
    pub fn server_version(&self) -> Option<&str> {
        match self {
            Self::DaemonOutdated { server_version } | Self::ClientOutdated { server_version } => {
                server_version.as_deref()
            }
        }
    }
}

pub(crate) fn label(version: &str) -> Option<String> {
    let label: String = version
        .trim()
        .chars()
        .filter(|c| !c.is_control())
        .take(MAX_VERSION_CHARS)
        .collect();
    (!label.is_empty()).then_some(label)
}

/// " (version X)" for a known version, so text reads well without one.
pub(crate) fn version_note(version: Option<&str>) -> String {
    version
        .map(|version| format!(" (version {version})"))
        .unwrap_or_default()
}

/// What a refused generation asks the user to update. Only a newer one is
/// this app's to fix; an older or equal one lacks what this app requires.
pub(crate) fn generation_advice(generation: u32) -> &'static str {
    if generation > ENDPOINT_PROTOCOL_GENERATION {
        "update Herdr GPUI"
    } else {
        "run `herdr update` and reconnect"
    }
}

impl Error {
    /// Whether this failure is fixed by updating the daemon or this client,
    /// rather than by retrying. Only handshake failures qualify.
    pub fn version_mismatch(&self) -> Option<VersionMismatch> {
        match self {
            Self::LegacyDaemon | Self::ClosedBeforeWelcome => {
                Some(VersionMismatch::DaemonOutdated {
                    server_version: None,
                })
            }
            Self::EndpointGeneration {
                generation,
                server_version,
            } => {
                let server_version = label(server_version);
                Some(if *generation > ENDPOINT_PROTOCOL_GENERATION {
                    VersionMismatch::ClientOutdated { server_version }
                } else {
                    VersionMismatch::DaemonOutdated { server_version }
                })
            }
            Self::BridgeIncompatible {
                generation: Some(generation),
                version,
            } if *generation > ENDPOINT_PROTOCOL_GENERATION => {
                Some(VersionMismatch::ClientOutdated {
                    server_version: version.clone(),
                })
            }
            Self::BridgeIncompatible { version, .. } => Some(VersionMismatch::DaemonOutdated {
                server_version: version.clone(),
            }),
            Self::MissingSurfaceInterest { server_version }
            | Self::MissingHealthCheck { server_version } => {
                Some(VersionMismatch::DaemonOutdated {
                    server_version: label(server_version),
                })
            }
            _ => None,
        }
    }
}
