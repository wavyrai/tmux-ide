//! tmux-ide SSH transport foundations. Decoded descriptors are not provenance:
//! only an owned authenticated SSH exchange may establish a remote connection.
mod command;
mod descriptor;
pub use command::{SshTarget, discovery_command, tunnel_command};
pub use descriptor::{PeerIdentity, RemoteDescriptor, RemoteFailure};
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum Error {
    #[error("Invalid SSH destination")]
    Target,
    #[error("Invalid remote daemon descriptor")]
    Descriptor,
    #[error("Remote daemon protocol {0} is incompatible")]
    Incompatible(u32),
    #[error("Remote daemon discovery failed ({0:?})")]
    Remote(RemoteFailure),
    #[error("Remote environment identity does not match the saved machine")]
    Environment,
    #[error("Invalid SSH forward port")]
    Port,
}

#[cfg(unix)]
mod discovery;
#[cfg(unix)]
pub use discovery::{DiscoveryError, discover};

mod connection;
pub use connection::{ConnectionError, VerifiedConnection};

#[cfg(unix)]
mod tunnel;
#[cfg(unix)]
pub use tunnel::{Tunnel, TunnelError};

#[cfg(unix)]
mod transport;
#[cfg(unix)]
pub use transport::{RemoteTransport, TransportError};

mod socket_identity;
pub use socket_identity::{IdentityError, verify_socket_identity};
