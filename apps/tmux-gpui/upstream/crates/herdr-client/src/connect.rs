//! Spawning a connection worker. Setup, handshake, and teardown all happen off
//! the caller's thread; failures arrive as events rather than as a return value.

use crate::{
    ConnectTarget, Error, Result, catalog,
    discovery::session_socket,
    event::{ClientEvent, deliver},
    handle::{Client, ClientHandle, HandleInner},
    limits::{COMMAND_CAPACITY, EVENT_CAPACITY},
    options::{ConnectOptions, validate_options},
    queue,
    session::{Signals, run_connection},
    ssh::{self, Bridge},
    transport::Stream,
    wsl,
};
use crossbeam_channel::bounded;
use std::{
    io,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    thread,
};

/// Returns immediately after spawning. Connection/handshake errors arrive as events.
pub fn connect(target: ConnectTarget, options: ConnectOptions) -> Result<Client> {
    connect_with_surface_active(target, options, true)
}

/// Connect without changing `ConnectOptions` literals. Inactive connections require
/// negotiated surface interest and presentation-effect fencing. SSH additionally
/// requires endpoint health checks. All transport work runs off the caller thread.
pub fn connect_with_surface_active(
    target: ConnectTarget,
    options: ConnectOptions,
    surface_active: bool,
) -> Result<Client> {
    connect_with_connector(target, options, surface_active, |target, _| {
        let path = target
            .socket_path()
            .map_err(|error| io::Error::new(error.kind(), error))?;
        Stream::connect(path)
    })
}

/// What an application connector produced: a local socket, or a remote bridge
/// it spawned (see [`crate::connect_command`]) whose child the worker owns.
pub enum Transport {
    Local(Stream),
    Bridge(Bridge),
}

impl From<Stream> for Transport {
    fn from(stream: Stream) -> Self {
        Self::Local(stream)
    }
}

impl From<Bridge> for Transport {
    fn from(bridge: Bridge) -> Self {
        Self::Bridge(bridge)
    }
}

/// Connect using application-specific setup on the I/O worker. SSH and WSL
/// targets always use the built-in remote bridge; local and cloud targets use
/// the connector. The connector should observe `stop` during waits so detach
/// cancels setup.
pub fn connect_with_connector<T: Into<Transport>>(
    target: ConnectTarget,
    options: ConnectOptions,
    surface_active: bool,
    connector: impl FnOnce(&ConnectTarget, &AtomicBool) -> io::Result<T> + Send + 'static,
) -> Result<Client> {
    validate_options(options)?;
    match &target {
        ConnectTarget::Ssh { target, session } => {
            catalog::validate_target(target)?;
            session_socket(std::path::Path::new(""), session)?;
        }
        ConnectTarget::Wsl { distro, session } => wsl::validate(distro, session)?,
        #[cfg(feature = "cloud")]
        ConnectTarget::Cloud { session, .. } => {
            session_socket(std::path::Path::new(""), session)?;
        }
        _ => {}
    }
    let (commands, rx) = queue::channel(COMMAND_CAPACITY)?;
    let (tx, events) = bounded(EVENT_CAPACITY);
    let stop = Arc::new(AtomicBool::new(false));
    let worker_stop = stop.clone();
    let liveness = Arc::new(AtomicBool::new(false));
    let worker_liveness = liveness.clone();
    thread::Builder::new()
        .name("herdr-client-io".into())
        .spawn(move || {
            let transport = match target {
                ConnectTarget::Ssh { .. } => "ssh",
                ConnectTarget::Wsl { .. } => "wsl",
                #[cfg(feature = "cloud")]
                ConnectTarget::Cloud { provider, .. } => provider.key(),
                _ => "local",
            };
            let span = tracing::info_span!("connection", transport);
            let _entered = span.enter();
            tracing::info!(transport, "connection starting");
            let result = (|| {
                let (stream, child) = match &target {
                    ConnectTarget::Ssh { target, session } => {
                        let (stream, child) = ssh::connect(target, session, &worker_stop)?;
                        (stream, Some(child))
                    }
                    ConnectTarget::Wsl { distro, session } => {
                        let (stream, child) = wsl::connect(distro, session, &worker_stop)?;
                        (stream, Some(child))
                    }
                    _ => match connector(&target, &worker_stop)?.into() {
                        Transport::Local(stream) => (stream, None),
                        Transport::Bridge(Bridge { stream, child }) => (stream, Some(child)),
                    },
                };
                run_connection(
                    stream,
                    options,
                    surface_active,
                    child.is_some(),
                    rx,
                    &tx,
                    Signals {
                        stop: &worker_stop,
                        liveness: &worker_liveness,
                    },
                )
                // The child guard is dropped before delivering a disconnect event.
            })();
            if worker_stop.load(Ordering::Acquire) {
                tracing::debug!("connection cancelled");
            } else if let Err(error) = &result {
                tracing::warn!(kind = ?error.kind(), "connection ended with transport or protocol failure");
            } else {
                tracing::info!("connection ended");
            }
            if !worker_stop.load(Ordering::Acquire) {
                if let Some(mismatch) = result.as_ref().err().and_then(Error::version_mismatch) {
                    let _ = deliver(&tx, ClientEvent::VersionMismatch(mismatch), &worker_stop);
                }
                let ssh = match &result {
                    Err(Error::SshRefused(failure)) => Some(*failure),
                    _ => None,
                };
                let reason = result
                    .err()
                    .map(|e| {
                        e.to_string()
                            .chars()
                            .filter(|c| !c.is_control())
                            .take(1024)
                            .collect()
                    })
                    .unwrap_or_else(|| "server disconnected".into());
                let _ = deliver(&tx, ClientEvent::Disconnected { reason, ssh }, &worker_stop);
            }
            worker_stop.store(true, Ordering::Release);
        })?;
    Ok(Client {
        handle: ClientHandle {
            inner: Arc::new(HandleInner {
                commands,
                stop,
                next_request: AtomicU64::new(1),
                image_busy: Arc::new(AtomicBool::new(false)),
                last_queued_theme: Default::default(),
                liveness,
            }),
        },
        events,
    })
}
