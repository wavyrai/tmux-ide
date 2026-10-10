//! The owner-facing half of a connection: the cloneable handle that queues
//! ordered commands and typed API requests, and the event receiver beside it.
//! Dropping the last handle stops the worker; queueing is never daemon ack.

use crate::{
    Error, Result, SendError,
    clipboard::{ClipboardImageUpload, ImageLease, ImageSlot},
    event::ClientEvent,
    host_theme::HostTheme,
    method::Method,
    options::{ConnectOptions, validate_options},
    protocol::*,
    queue::CommandSender,
};
use crossbeam_channel::Receiver;
use serde_json::{Value, json};
use std::sync::{
    Arc, Mutex, PoisonError,
    atomic::{AtomicBool, AtomicU64, Ordering},
};

pub struct Client {
    pub handle: ClientHandle,
    pub events: Receiver<ClientEvent>,
}
#[derive(Clone)]
pub struct ClientHandle {
    pub(crate) inner: Arc<HandleInner>,
}
pub(crate) struct HandleInner {
    pub(crate) commands: CommandSender,
    pub(crate) stop: Arc<AtomicBool>,
    pub(crate) next_request: AtomicU64,
    pub(crate) image_busy: Arc<AtomicBool>,
    /// The theme this connection last queued in full. Queued, not acknowledged:
    /// it only spares the daemon repeats and lets later changes go as diffs.
    pub(crate) last_queued_theme: Mutex<Option<HostTheme>>,
    /// Set to have the worker ping an SSH link now; see `check_liveness`.
    pub(crate) liveness: Arc<AtomicBool>,
}
impl Drop for HandleInner {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
    }
}
pub(crate) struct Command {
    pub(crate) boot_id: String,
    pub(crate) bytes: Vec<u8>,
    /// Set when this command is an API request awaiting a correlated response.
    pub(crate) request: Option<PendingRequest>,
    pub(crate) image: Option<ImageSlot>,
}

/// A queued API request, waiting on the single in-flight lease.
pub(crate) struct PendingRequest {
    pub(crate) id: String,
    pub(crate) method: Method,
}

impl ClientHandle {
    /// Reserve FIFO position now, before reading an image in the background.
    /// Only one image may be preparing, queued, or writing per connection.
    pub fn reserve_clipboard_image(
        &self,
        boot_id: &str,
        target: ClientClipboardImageTarget,
    ) -> Result<ClipboardImageUpload> {
        self.reserve_clipboard(boot_id, target, true)
    }

    /// Reserve FIFO position for unknown clipboard content without claiming the
    /// image lease. `complete_input` can publish while another image is active;
    /// `complete` must claim the single-image lease before encoding.
    pub fn reserve_clipboard_input(
        &self,
        boot_id: &str,
        target: ClientClipboardImageTarget,
    ) -> Result<ClipboardImageUpload> {
        self.reserve_clipboard(boot_id, target, false)
    }

    fn reserve_clipboard(
        &self,
        boot_id: &str,
        target: ClientClipboardImageTarget,
        claim_image: bool,
    ) -> Result<ClipboardImageUpload> {
        if self.is_disconnected() {
            return Err(Error::Disconnected);
        }
        if boot_id.is_empty() {
            return Err(Error::MissingBootId);
        }
        validate_clipboard_image_target(&target)?;
        // The Windows pipe wrapper cannot bound writes. Do not expose an upload
        // that could indefinitely prevent cancellation and inbound processing.
        if cfg!(windows) {
            return Err(Error::ClipboardImageUnsupported);
        }
        let lease = Arc::new(ImageLease {
            busy: self.inner.image_busy.clone(),
            claimed: AtomicBool::new(false),
            cancelled: Arc::new(AtomicBool::new(false)),
            finished: Arc::new(AtomicBool::new(false)),
            reserved_at: std::time::Instant::now(),
        });
        if claim_image {
            lease.claim_image()?;
        }
        let (sender, receiver) = crossbeam_channel::bounded(1);
        self.queue(Command {
            boot_id: boot_id.into(),
            bytes: Vec::new(),
            request: None,
            image: Some(ImageSlot {
                receiver,
                lease: lease.clone(),
                writer: Default::default(),
            }),
        })?;
        Ok(ClipboardImageUpload {
            target,
            sender,
            lease,
            stop: self.inner.stop.clone(),
        })
    }

    pub fn disconnect(&self) {
        tracing::debug!("disconnect requested");
        self.inner.stop.store(true, Ordering::Release);
        self.inner.commands.wake();
    }
    /// Have an SSH connection prove it is still alive: ping the host now and
    /// fail the connection if it stays silent for a few seconds, rather than
    /// waiting for the routine check of a quiet link. Use it when the link may
    /// have died unnoticed, as across a sleep. A local connection ignores it.
    pub fn check_liveness(&self) {
        self.inner.liveness.store(true, Ordering::Release);
        self.inner.commands.wake();
    }
    pub fn is_disconnected(&self) -> bool {
        self.inner.stop.load(Ordering::Acquire)
    }

    fn enqueue(
        &self,
        boot_id: &str,
        message: ClientMessage,
        request: Option<PendingRequest>,
    ) -> Result<()> {
        if self.is_disconnected() {
            return Err(SendError::Disconnected);
        }
        if boot_id.is_empty() {
            return Err(Error::MissingBootId);
        }
        let bytes = encode_message(&message, MAX_FRAME_SIZE)?;
        self.queue(Command {
            boot_id: boot_id.into(),
            bytes,
            request,
            image: None,
        })
    }

    fn queue(&self, command: Command) -> Result<()> {
        self.inner.commands.try_send(command)
    }
    pub fn send_input(
        &self,
        boot_id: &str,
        pane_id: &str,
        events: impl IntoIterator<Item = ClientPaneInputEvent>,
    ) -> Result<()> {
        self.enqueue(
            boot_id,
            ClientMessage::ClientShellPaneInput {
                pane_id: pane_id.into(),
                events: events.into_iter().collect(),
            },
            None,
        )
    }
    pub fn send_popup_input(
        &self,
        boot_id: &str,
        terminal_id: &str,
        events: impl IntoIterator<Item = ClientPaneInputEvent>,
    ) -> Result<()> {
        self.enqueue(
            boot_id,
            ClientMessage::ClientShellPopupInput {
                terminal_id: terminal_id.into(),
                events: events.into_iter().collect(),
            },
            None,
        )
    }
    pub fn resize(&self, boot_id: &str, options: ConnectOptions) -> Result<()> {
        validate_options(options)?;
        self.enqueue(
            boot_id,
            ClientMessage::ClientShellResize {
                cell_width_px: options.cell_width_px,
                cell_height_px: options.cell_height_px,
                surface_size: options.surface_size,
                pixel_mouse: false,
            },
            None,
        )
    }
    /// Report the host terminal theme. The first call on a connection queues
    /// all of it; later calls queue only what changed, and nothing when the
    /// theme is unchanged. Each connection starts unknown to the daemon, so a
    /// reconnect, being a new connection, reports the whole theme again.
    pub fn set_host_theme(&self, boot_id: &str, theme: &HostTheme) -> Result<()> {
        let mut last = self
            .inner
            .last_queued_theme
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if last.as_ref() == Some(theme) {
            return Ok(());
        }
        let previous = last.take();
        for update in theme.updates(previous.as_ref()) {
            // `last` stays empty on failure, so the next call starts over in full.
            self.enqueue(
                boot_id,
                ClientMessage::ClientShellHostTheme { update },
                None,
            )?;
        }
        *last = Some(theme.clone());
        Ok(())
    }
    pub fn set_focus(&self, boot_id: &str, focused: bool) -> Result<()> {
        self.enqueue(boot_id, ClientMessage::ClientShellFocus { focused }, None)
    }
    /// Queue upstream's surface-interest API, not window focus. Wait for the
    /// matching Response before considering a host activation/deactivation complete.
    pub fn set_surface_active(&self, boot_id: &str, active: bool) -> Result<String> {
        self.request(
            boot_id,
            Method::ClientShellSurfaceSet,
            json!({"active": active}),
        )
    }
    /// Serialize the API envelope, generate an ID, and queue on the ordered writer.
    /// Only methods advertised in Connected are sent. Responses retain API errors.
    pub fn request(&self, boot_id: &str, method: Method, params: Value) -> Result<String> {
        let id = format!(
            "gpui-{}",
            self.inner.next_request.fetch_add(1, Ordering::Relaxed)
        );
        let request = json!({"id": id, "method": method.as_str(), "params": params}).to_string();
        self.enqueue(
            boot_id,
            ClientMessage::ClientShellEndpointRequest {
                boot_id: boot_id.into(),
                request,
            },
            Some(PendingRequest {
                id: id.clone(),
                method,
            }),
        )?;
        Ok(id)
    }
    pub fn focus_pane(&self, boot_id: &str, pane_id: &str) -> Result<String> {
        self.request(boot_id, Method::PaneFocus, json!({"pane_id": pane_id}))
    }
    pub fn focus_tab(&self, boot_id: &str, tab_id: &str) -> Result<String> {
        self.request(boot_id, Method::TabFocus, json!({"tab_id": tab_id}))
    }
    pub fn focus_workspace(&self, boot_id: &str, workspace_id: &str) -> Result<String> {
        self.request(
            boot_id,
            Method::WorkspaceFocus,
            json!({"workspace_id": workspace_id}),
        )
    }
}
