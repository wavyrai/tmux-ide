//! What a connection reports to its owner, and the bounded, cancellable
//! delivery that never blocks the worker on a slow consumer.

use crate::{
    Error, Result, VersionMismatch,
    limits::POLL,
    protocol::{endpoint::EndpointServerWelcome, *},
    surface_images::SurfaceImages,
};
use crossbeam_channel::{SendTimeoutError, Sender};
use serde_json::Value;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

#[derive(Debug)]
pub enum ClientEvent {
    Connected(EndpointServerWelcome),
    Snapshot(Arc<ClientShellSnapshot>),
    /// Complete text baseline, including after a cell patch. Its graphics
    /// scene carries placements only; the pixels arrive as `SurfaceImages`.
    Surface(Arc<PaneSurfaceFrame>),
    /// Every image the surfaces this connection emits may place, sent before
    /// the surface that first needs a change. Replaces the previous set.
    SurfaceImages(Arc<SurfaceImages>),
    Response {
        request_id: String,
        response: Value,
    },
    /// Queued command was not sent (stale boot, unsupported method, or busy).
    CommandRejected {
        request_id: Option<String>,
        reason: Error,
    },
    /// Notifications, clipboard, title, bell, and other non-surface wire events.
    Message(ServerMessage),
    /// The handshake was refused because one side must be updated. Sent
    /// just before the `Disconnected` that ends the connection.
    VersionMismatch(VersionMismatch),
    Disconnected {
        reason: String,
        /// Why `ssh` refused the bridge, when the connection never got past it.
        ssh: Option<crate::SshFailure>,
    },
}

pub(crate) fn deliver(
    tx: &Sender<ClientEvent>,
    mut event: ClientEvent,
    stop: &AtomicBool,
) -> Result<()> {
    let mut reported_backpressure = false;
    loop {
        if stop.load(Ordering::Acquire) {
            return Err(Error::Cancelled);
        }
        match tx.send_timeout(event, POLL) {
            Ok(()) => return Ok(()),
            Err(SendTimeoutError::Timeout(e)) => {
                if !reported_backpressure {
                    tracing::debug!(category = "event_queue", "client backpressure");
                    reported_backpressure = true;
                }
                event = e;
            }
            Err(SendTimeoutError::Disconnected(_)) => {
                return Err(Error::EventReceiverDropped);
            }
        }
    }
}
