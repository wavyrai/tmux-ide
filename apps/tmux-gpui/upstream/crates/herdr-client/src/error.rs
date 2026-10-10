use std::{
    io,
    path::{Path, PathBuf},
};

pub type Result<T> = std::result::Result<T, Error>;

/// The storage step that failed. Replacement retains both source and destination paths.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StorageOperation {
    Open,
    Metadata,
    Read,
    Decode,
    Encode,
    Validate,
    CreateDirectory,
    Create,
    Write,
    Sync,
    Replace { destination: PathBuf },
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// Paths are available to diagnostic callers but omitted from presentation text.
    #[error("{source}")]
    Storage {
        operation: StorageOperation,
        path: PathBuf,
        #[source]
        source: Box<Error>,
    },
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
    #[error("invalid endpoint selection schema")]
    SelectionSchema(#[source] serde_json::Error),
    #[error("client command queue is full")]
    Full,
    #[error("client is disconnected")]
    Disconnected,
    #[error("a clipboard image upload is already reserved or in progress")]
    ClipboardImageBusy,
    #[error("clipboard image upload cancelled")]
    ClipboardImageCancelled,
    #[error("clipboard image write timed out; reconnect required")]
    ClipboardImageWriteTimeout,
    #[error("clipboard image uploads require a transport with bounded writes")]
    ClipboardImageUnsupported,
    #[error("semantic input fallback requires a pane or popup target")]
    ClipboardImageInputTarget,
    #[error("clipboard image preparation timed out; reservation skipped")]
    ClipboardImagePreparationTimeout,
    #[error("invalid client command: snapshot boot ID required")]
    MissingBootId,
    #[error("command does not match a ready snapshot boot")]
    CommandBoot,
    #[error("method not advertised by endpoint")]
    UnsupportedMethod,
    #[error("surface interest capabilities not advertised by endpoint")]
    UnsupportedSurfaceInterest,
    #[error("surface dimensions must be nonzero")]
    EmptySurface,
    #[error("surface geometry exceeds endpoint limits")]
    GeometryLimit,
    #[error("invalid session name")]
    InvalidSession,
    #[error("The default session cannot be deleted")]
    DefaultSession,
    #[error("Session deletion timed out; refresh the list before trying again")]
    SessionDeleteTimeout,
    #[error(
        "Herdr refused session deletion ({0}); the session may be running, inaccessible, or unsupported by the installed CLI"
    )]
    SessionDeleteFailed(std::process::ExitStatus),
    #[error("remote endpoints have no local socket path")]
    NoLocalSocket,
    #[error("invalid SSH target (options, controls, and passwords are forbidden)")]
    InvalidSshTarget,
    #[error("client stopped")]
    Cancelled,
    #[error("event receiver dropped")]
    EventReceiverDropped,
    #[error("socket closed")]
    SocketClosed,
    #[error("partial frame timed out")]
    PartialFrameTimeout,
    #[error("invalid frame prefix")]
    FramePrefix,
    #[error("invalid frame length")]
    FrameLength,
    #[error("endpoint health check timed out")]
    HealthTimeout,
    #[error("handshake/snapshot timed out")]
    HandshakeTimeout,
    #[error("endpoint request timed out; not replayed")]
    RequestTimeout,
    #[error("expected stable endpoint welcome")]
    ExpectedWelcome,
    /// The daemon answered the endpoint hello with a pre-endpoint welcome.
    #[error("this Herdr server predates the endpoint protocol; run `herdr update` and reconnect")]
    LegacyDaemon,
    /// A local daemon closed after the hello without any welcome, as every
    /// release before the endpoint protocol does.
    #[error(
        "Herdr server closed the connection without answering; it is likely older than {}, which this app requires. Run `herdr update` and reconnect",
        crate::compat::MIN_HERDR_VERSION
    )]
    ClosedBeforeWelcome,
    #[error(
        "Herdr server {server_version} speaks endpoint generation {generation}, this app speaks {ours}; {advice}",
        ours = herdr_protocol::endpoint::ENDPOINT_PROTOCOL_GENERATION,
        advice = crate::compat::generation_advice(*.generation)
    )]
    EndpointGeneration {
        generation: u32,
        server_version: String,
    },
    #[error("expected endpoint.welcome.v1")]
    WelcomeKind,
    #[error("{code}: {message}")]
    WelcomeRejected { code: String, message: String },
    #[error("incompatible endpoint generation/codecs")]
    IncompatibleCodecs,
    #[error(
        "Herdr server {server_version} lacks safe surface interest support; run `herdr update` and reconnect"
    )]
    MissingSurfaceInterest { server_version: String },
    #[error(
        "Herdr server {server_version} on this SSH host lacks the health_check capability; run `herdr update` there and reconnect"
    )]
    MissingHealthCheck { server_version: String },
    #[error("endpoint boot changed or snapshot revision regressed; reconnect required")]
    SnapshotIdentity,
    #[error("surface before snapshot")]
    SurfaceBeforeSnapshot,
    #[error("invalid surface identity/revision")]
    SurfaceIdentity,
    #[error("patch before baseline")]
    PatchBeforeBaseline,
    #[error("encoded surface before baseline")]
    EncodedSurfaceBeforeBaseline,
    #[error("surface encoding was not advertised by endpoint")]
    SurfaceEncodingNotNegotiated,
    #[error("response boot mismatch")]
    ResponseBoot,
    #[error("response limit exceeded")]
    ResponseLimit,
    #[error("unsolicited response")]
    UnsolicitedResponse,
    #[error("response ID mismatch")]
    ResponseId,
    #[error("{0}")]
    ServerShutdown(String),
    #[error("SSH endpoints are not supported on this platform")]
    SshUnsupported,
    #[error("SSH connection cancelled")]
    SshCancelled,
    #[error("SSH discovery timed out")]
    SshTimeout,
    #[error("SSH bridge closed; check host trust, authentication, and remote Herdr installation")]
    SshClosed,
    /// `ssh` closed the bridge before it was ready, for the reason classified.
    #[error("SSH bridge closed: {0}")]
    SshRefused(#[source] crate::SshFailure),
    /// Every Herdr installed on the SSH host or WSL distribution was skipped
    /// as unable to serve this client. Fields describe the first one;
    /// `version` is bounded text.
    #[error(
        "Herdr{} on this host cannot serve this app; {}",
        crate::compat::version_note(.version.as_deref()),
        crate::compat::generation_advice(.generation.unwrap_or(0))
    )]
    BridgeIncompatible {
        generation: Option<u32>,
        version: Option<String>,
    },
    #[error("SSH startup output exceeds limit")]
    SshOutputLimit,
    #[error("invalid WSL distribution name")]
    InvalidWslDistro,
    #[error("WSL distributions are only available on Windows")]
    WslUnsupported,
    #[error("WSL did not answer in time; the distribution may be stopped or waiting for setup")]
    WslTimeout,
    #[error("WSL bridge closed; check that the distribution starts and Herdr is installed in it")]
    WslClosed,
    #[error("wsl.exe failed ({0})")]
    WslCommand(std::process::ExitStatus),
    #[error("invalid WSL device list schema")]
    WslCatalogSchema(#[source] serde_json::Error),
    #[error("unsupported WSL device list version, size, or entries")]
    WslCatalog,
    #[error("this WSL distribution is already a device")]
    WslHostExists,
    #[error("this WSL distribution is not a saved device")]
    WslHostMissing,
    #[error("remote Git directory must be an absolute path")]
    InvalidGitDir,
    #[error("remote command failed ({0})")]
    RemoteCommand(std::process::ExitStatus),
    #[error("remote command returned unexpected output")]
    RemoteOutput,
    #[error("SSH file transfer requires a Linux or macOS client")]
    UploadUnsupported,
    #[error("SSH file transfer accepts at most 256 paths")]
    UploadPathLimit,
    #[error("file transfer requires a UTF-8 basename without controls")]
    UploadName,
    #[error("file transfer source is not a regular file")]
    UploadNotFile,
    #[error("file transfer total size exceeds u64")]
    UploadSizeOverflow,
    #[error("file transfer source changed length")]
    UploadSourceChanged,
    #[error("SSH file transfer cancelled")]
    UploadCancelled,
    #[error("SSH file transfer made no progress for 30 seconds")]
    UploadTimeout,
    #[error("invalid or excessive SSH file transfer response")]
    UploadResponse,
    #[error("cleanup requires unchanged absolute paths returned by upload_files")]
    UploadCleanupPath,
    #[error("SSH file transfer failed; check host trust, authentication, and remote storage")]
    UploadExit { status: std::process::ExitStatus },
    #[error("SSH file transfer I/O failed")]
    UploadIo(#[source] io::Error),
    #[error("{source}; remote temporary-file cleanup also failed")]
    UploadCleanup {
        #[source]
        source: Box<Error>,
        cleanup: Box<Error>,
    },
    #[error("host scripts require a Linux or macOS client")]
    ScriptUnsupported,
    #[error("could not start host script")]
    ScriptSpawn(#[source] io::Error),
    #[error("host script I/O failed")]
    ScriptIo(#[source] io::Error),
    #[error("could not read host script input")]
    ScriptInput(#[source] io::Error),
    #[error("could not write host script output")]
    ScriptOutput(#[source] io::Error),
    #[error("host script output exceeds limit")]
    ScriptOutputLimit,
    #[error("host script cancelled")]
    ScriptCancelled,
    #[error("host script made no progress before its deadline")]
    ScriptTimeout,
    #[error("host script worker panicked")]
    ScriptWorker,
    /// `stderr` is a bounded, control-free tail kept for diagnostics.
    #[error("host script failed ({status}): {stderr}")]
    ScriptExit {
        status: std::process::ExitStatus,
        stderr: String,
    },
    #[error("could not start SSH for the port forward")]
    ForwardSpawn(#[source] io::Error),
    #[error("no local port is free to forward to")]
    ForwardLocalPort(#[source] io::Error),
    #[error("could not create the port forward's private control directory")]
    ForwardControl(#[source] io::Error),
    #[error("SSH did not connect in time; check host trust and authentication")]
    ForwardTimeout,
    #[error("SSH could not listen on a local port ({0})")]
    ForwardRefused(std::process::ExitStatus),
    /// Stderr is discarded, as for every SSH child: it can carry banners or secrets.
    #[error("SSH port forward ended ({0}); check host trust, authentication, and the network")]
    ForwardExit(std::process::ExitStatus),
    #[error("endpoint selection is not a regular file")]
    SelectionNotFile,
    #[error("endpoint selection exceeds storage limit")]
    SelectionLimit,
    #[error("unsupported endpoint selection version")]
    SelectionVersion,
    #[error("selected endpoint is absent or disabled")]
    SelectionUnavailable,
    #[error("invalid storage path")]
    StoragePath,
    #[error("storage destination is not a regular file")]
    StorageDestinationNotFile,
    #[error("endpoint catalog is not a regular file")]
    CatalogNotFile,
    #[error("endpoint catalog exceeds storage limit")]
    CatalogLimit,
    #[error("unsupported catalog version or too many profiles")]
    CatalogVersionOrCount,
    #[error("invalid or duplicate endpoint profile id")]
    ProfileId,
    #[error("invalid endpoint label")]
    ProfileLabel,
    #[error("too many sessions to list")]
    SessionLimit,
    /// An endpoint answered a request with an error. The message is the
    /// daemon's own display text; act on `code`, never on the message.
    #[error("{message}")]
    Endpoint {
        code: crate::scrollback::EndpointErrorCode,
        message: String,
    },
    #[error("invalid endpoint response")]
    ResponseSchema(#[source] serde_json::Error),
    #[error("endpoint response carried neither a result nor an error")]
    ResponseMissingResult,
    #[error("endpoint answered with a result of another method")]
    ResponseType,
}

impl Error {
    pub(crate) fn storage(
        operation: StorageOperation,
        path: &Path,
        source: impl Into<Error>,
    ) -> Self {
        Self::Storage {
            operation,
            path: path.to_owned(),
            source: Box::new(source.into()),
        }
    }

    /// Preserve transport retry/cancellation categories, including the historical
    /// InvalidData category for session deadlines and validation failures.
    pub fn kind(&self) -> io::ErrorKind {
        match self {
            Self::Storage { source, .. } => source.kind(),
            Self::Io(error) => error.kind(),
            Self::UploadIo(error) => error.kind(),
            Self::UploadCleanup { source, .. } => source.kind(),
            Self::UploadUnsupported => io::ErrorKind::Unsupported,
            Self::UploadCancelled => io::ErrorKind::Interrupted,
            Self::UploadTimeout => io::ErrorKind::TimedOut,
            Self::UploadPathLimit | Self::UploadName | Self::UploadCleanupPath => {
                io::ErrorKind::InvalidInput
            }
            Self::Protocol(error) => error.kind(),
            Self::Json(error) => error.io_error_kind().unwrap_or(if error.is_eof() {
                io::ErrorKind::UnexpectedEof
            } else {
                io::ErrorKind::InvalidData
            }),
            Self::InvalidSession
            | Self::DefaultSession
            | Self::NoLocalSocket
            | Self::InvalidSshTarget
            | Self::InvalidWslDistro => io::ErrorKind::InvalidInput,
            Self::SshUnsupported | Self::WslUnsupported | Self::ClipboardImageUnsupported => {
                io::ErrorKind::Unsupported
            }
            Self::ClipboardImageCancelled => io::ErrorKind::Interrupted,
            Self::ClipboardImageWriteTimeout | Self::ClipboardImagePreparationTimeout => {
                io::ErrorKind::TimedOut
            }
            Self::Cancelled | Self::SshCancelled => io::ErrorKind::Interrupted,
            Self::EventReceiverDropped | Self::Disconnected => io::ErrorKind::BrokenPipe,
            Self::SocketClosed | Self::SshClosed | Self::WslClosed | Self::ClosedBeforeWelcome => {
                io::ErrorKind::UnexpectedEof
            }
            Self::SshRefused(failure) => match failure {
                crate::SshFailure::HostKey | crate::SshFailure::Auth => {
                    io::ErrorKind::PermissionDenied
                }
                crate::SshFailure::Unreachable => io::ErrorKind::NotConnected,
                crate::SshFailure::HerdrMissing => io::ErrorKind::NotFound,
                crate::SshFailure::Other => io::ErrorKind::UnexpectedEof,
            },
            Self::ForwardSpawn(error)
            | Self::ForwardLocalPort(error)
            | Self::ForwardControl(error) => error.kind(),
            Self::HealthTimeout
            | Self::SshTimeout
            | Self::WslTimeout
            | Self::SessionDeleteTimeout
            | Self::ForwardTimeout => io::ErrorKind::TimedOut,
            Self::Full | Self::ClipboardImageBusy => io::ErrorKind::WouldBlock,
            _ => io::ErrorKind::InvalidData,
        }
    }
}
