//! Conservative classification for bounded read-only catalog recovery.
use super::{CatalogWatchError, Error};
impl Error {
    /// Retry policy for read-only catalog discovery only. Never replay a mutation
    /// based on this classification; fresh owner/registry authorization is required.
    pub fn is_transient_catalog_failure(&self) -> bool {
        transient(self)
    }
}
fn transient(error: &Error) -> bool {
    match error {
        Error::Network(ureq::Error::Io(_) | ureq::Error::Timeout(_)) => true,
        Error::CatalogWatch(error) => match error.as_ref() {
            CatalogWatchError::Io(_) | CatalogWatchError::Timeout => true,
            CatalogWatchError::Owner(error) => transient(error),
            CatalogWatchError::Socket(error) => matches!(
                error.as_ref(),
                tungstenite::Error::Io(_)
                    | tungstenite::Error::Protocol(
                        tungstenite::error::ProtocolError::ResetWithoutClosingHandshake
                    )
                    | tungstenite::Error::ConnectionClosed
                    | tungstenite::Error::AlreadyClosed
            ),
            _ => false,
        },
        #[cfg(unix)]
        Error::Remote(error) => {
            use crate::tmux_ssh::{ConnectionError, DiscoveryError, TransportError, TunnelError};
            matches!(
                error.as_ref(),
                TransportError::Timeout
                    | TransportError::Tunnel(TunnelError::Exited | TunnelError::Io(_))
                    | TransportError::Discovery(DiscoveryError::Timeout | DiscoveryError::Io(_))
                    | TransportError::Connection(ConnectionError::Network(
                        ureq::Error::Io(_) | ureq::Error::Timeout(_)
                    ))
            )
        }
        _ => false,
    }
}
