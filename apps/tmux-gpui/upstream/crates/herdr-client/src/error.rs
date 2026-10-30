use std::io;

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("client I/O failed: {0}")]
    Io(#[from] io::Error),
    #[error("{0}")]
    Protocol(#[from] herdr_protocol::Error),
    #[error("invalid endpoint JSON: {0}")]
    Json(#[from] serde_json::Error),
    // Schema details may contain secret-bearing unknown field names. Keep the
    // source for diagnostics, but never include it in presentation text.
    #[error("invalid endpoint catalog schema")]
    CatalogSchema(#[source] serde_json::Error),
    #[error("client command queue is full")]
    Full,
    #[error("client is disconnected")]
    Disconnected,
    #[error("surface dimensions must be nonzero")]
    EmptySurface,
    #[error("surface geometry exceeds endpoint limits")]
    GeometryLimit,
    #[error("client stopped")]
    Cancelled,
}

impl Error {
    /// Preserve transport retry/cancellation categories, including the historical
    /// InvalidData category for validation failures.
    pub fn kind(&self) -> io::ErrorKind {
        match self {
            Self::Io(error) => error.kind(),
            Self::Protocol(error) => error.kind(),
            Self::Json(error) => error.io_error_kind().unwrap_or(if error.is_eof() {
                io::ErrorKind::UnexpectedEof
            } else {
                io::ErrorKind::InvalidData
            }),
            Self::Cancelled => io::ErrorKind::Interrupted,
            Self::Disconnected => io::ErrorKind::BrokenPipe,
            Self::Full => io::ErrorKind::WouldBlock,
            _ => io::ErrorKind::InvalidData,
        }
    }
}
