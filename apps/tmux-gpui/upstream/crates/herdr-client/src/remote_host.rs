//! The hosts this client reaches through a bridge child rather than a local
//! socket: an SSH target, or a WSL distribution on this Windows machine. Each
//! owns its own named sessions, listed and deleted through its own Herdr CLI.
use crate::{
    ConnectTarget, RemoteSession, Result, delete_distro_session, delete_remote_session,
    list_distro_sessions, list_remote_sessions,
};

/// Where a remote endpoint's daemon runs, without the session it attaches to.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum RemoteHost {
    /// A validated `[user@]host` SSH target.
    Ssh(String),
    /// A WSL distribution name.
    Wsl(String),
}

impl RemoteHost {
    /// The endpoint for `session` on this host.
    pub fn target(&self, session: impl Into<String>) -> ConnectTarget {
        let session = session.into();
        match self {
            Self::Ssh(target) => ConnectTarget::Ssh {
                target: target.clone(),
                session,
            },
            Self::Wsl(distro) => ConnectTarget::Wsl {
                distro: distro.clone(),
                session,
            },
        }
    }

    /// The sessions this host's Herdr lists. Blocks on a bridge child: call it
    /// from a background thread.
    pub fn list_sessions(&self) -> Result<Vec<RemoteSession>> {
        match self {
            Self::Ssh(target) => list_remote_sessions(target),
            Self::Wsl(distro) => list_distro_sessions(distro),
        }
    }

    /// Stop and delete a named session after the user confirmed it. Blocks:
    /// call it from a background thread.
    pub fn delete_session(&self, name: &str) -> Result<()> {
        match self {
            Self::Ssh(target) => delete_remote_session(target, name),
            Self::Wsl(distro) => delete_distro_session(distro, name),
        }
    }
}

impl ConnectTarget {
    /// The host a remote endpoint runs on, or `None` for this machine's daemon.
    pub fn remote_host(&self) -> Option<RemoteHost> {
        match self {
            Self::Ssh { target, .. } => Some(RemoteHost::Ssh(target.clone())),
            Self::Wsl { distro, .. } => Some(RemoteHost::Wsl(distro.clone())),
            // A cloud machine is reached only through its provider's command,
            // which the host scripts that list and delete sessions do not use.
            #[cfg(feature = "cloud")]
            Self::Cloud { .. } => None,
            Self::Local | Self::Session { .. } | Self::Socket(_) => None,
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn hosts_round_trip_through_their_targets() {
        for host in [
            RemoteHost::Ssh("me@box".into()),
            RemoteHost::Wsl("Ubuntu".into()),
        ] {
            let target = host.target("work");
            assert_eq!(target.remote_host(), Some(host));
            assert_eq!(target.remote_session(), Some("work"));
            assert!(target.is_remote());
            assert!(target.socket_path().is_err());
        }
        assert_eq!(ConnectTarget::Local.remote_host(), None);
        assert!(!ConnectTarget::Local.is_remote());
    }
}
