use crate::{
    config::Theme,
    state::{ConnectionStatus, LiveState},
    terminal::InputTarget,
};
use herdr_client::{
    ClientEvent, ClientHandle, ConnectOptions, ConnectTarget, HostTheme, Method,
    connect_with_connector,
    protocol::{ClientHostAppearance, ClientHostColor, ClientPaneInputEvent},
};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};

pub(crate) struct ConnectionBridge {
    pub target: ConnectTarget,
    pub handle: Option<ClientHandle>,
    pub inbox: Arc<Mutex<LiveState>>,
    pub drained: Arc<AtomicBool>,
    pub integrations: Arc<Mutex<IntegrationInbox>>,
    pub(crate) links: Arc<Mutex<crate::links::LinkInbox>>,
    /// Scrollback answers, fenced with the connection like the main inbox.
    pub scrollback: Arc<Mutex<crate::scrollback::Inbox>>,
    sound_cancel: Arc<AtomicBool>,
}

/// One integration operation, independent of the modal dialog response slot.
#[derive(Default)]
pub(crate) struct IntegrationInbox {
    pub list: bool,
    pub install: bool,
    pub pending: Option<(String, Option<crate::Result<serde_json::Value>>)>,
}

impl IntegrationInbox {
    fn apply(&mut self, event: ClientEvent) -> Option<ClientEvent> {
        match &event {
            ClientEvent::Connected(welcome) => {
                self.list = Method::IntegrationList.advertised_in(&welcome.methods);
                self.install = Method::IntegrationInstall.advertised_in(&welcome.methods);
            }
            ClientEvent::Disconnected { .. } => {
                self.list = false;
                self.install = false;
                if let Some((_, result)) = &mut self.pending {
                    *result = Some(Err(crate::Error::NotConnected));
                }
            }
            _ => {}
        }
        let Some((id, result)) = &mut self.pending else {
            return Some(event);
        };
        match event {
            ClientEvent::Response {
                request_id,
                response,
            } if request_id == *id => {
                *result = Some(Ok(response));
                None
            }
            ClientEvent::CommandRejected {
                request_id: Some(request_id),
                reason,
            } if request_id == *id => {
                *result = Some(Err(crate::Error::Client(reason)));
                None
            }
            event => Some(event),
        }
    }
}

/// What the daemon is told about this client's terminal: the colors cells are
/// painted with, and the system appearance rather than the theme's lightness,
/// so Herdr's light and dark theme overrides follow the OS as they would in a
/// terminal that reports its color scheme.
pub(crate) fn host_theme(theme: &Theme, light: bool) -> HostTheme {
    let rgb = |color: u32| {
        let [_, r, g, b] = color.to_be_bytes();
        ClientHostColor { r, g, b }
    };
    HostTheme {
        foreground: rgb(theme.foreground),
        background: rgb(theme.background),
        palette: theme.palette.map(rgb),
        appearance: if light {
            ClientHostAppearance::Light
        } else {
            ClientHostAppearance::Dark
        },
    }
}

impl ConnectionBridge {
    pub fn new(target: ConnectTarget) -> Self {
        let state = LiveState::default();
        Self {
            target,
            handle: None,
            sound_cancel: state.sound_connection_cancel.clone(),
            inbox: Arc::new(Mutex::new(state)),
            drained: Arc::new(AtomicBool::new(true)),
            integrations: Arc::default(),
            links: Arc::default(),
            scrollback: Arc::default(),
        }
    }

    fn reset(&mut self, status: ConnectionStatus, active: bool) {
        // Retire audio even when the event reducer holds the inbox. Boot-scoped
        // cancellation alone cannot be reached without that lock.
        self.sound_cancel.store(true, Ordering::Release);
        if let Ok(mut state) = self.inbox.try_lock() {
            state.cancel_sounds();
        }
        if let Some(handle) = self.handle.take() {
            handle.disconnect();
        }
        let mut state = LiveState::default();
        state.status = status;
        state.set_outer_focus(active);
        self.sound_cancel = state.sound_connection_cancel.clone();
        // Old readers and deferred paint acknowledgements retain only the old inbox.
        self.inbox = Arc::new(Mutex::new(state));
        self.drained = Arc::new(AtomicBool::new(true));
        self.integrations = Arc::default();
        self.links = Arc::default();
        self.scrollback = Arc::default();
    }

    pub fn detach(&mut self, active: bool) {
        tracing::debug!("Connection bridge detaching");
        self.reset(ConnectionStatus::Detached, active);
    }

    pub fn reconnect(&mut self, options: ConnectOptions, active: bool, surface_active: bool) {
        tracing::debug!("Connection bridge reconnecting");
        self.reset(ConnectionStatus::Connecting, active);
        self.start(options, surface_active, |events| {
            std::thread::Builder::new()
                .name("herdr-gui-events".into())
                .spawn(events)
                .map(|_| ())
        });
    }

    fn start(
        &mut self,
        options: ConnectOptions,
        surface_active: bool,
        spawn: impl FnOnce(Box<dyn FnOnce() + Send>) -> std::io::Result<()>,
    ) {
        self.drained = Arc::new(AtomicBool::new(false));
        let target = self.target.clone();
        let startup_inbox = self.inbox.clone();
        let result =
            connect_with_connector(target, options, surface_active, move |target, stop| {
                #[cfg(feature = "cloud")]
                if matches!(target, ConnectTarget::Cloud { .. }) {
                    return crate::cloud::connect(target, stop);
                }
                let result = crate::daemon::connect(target, stop, || {
                    tracing::debug!("Connection bridge starting local daemon");
                    if let Ok(mut state) = startup_inbox.lock()
                        && state.status == ConnectionStatus::Connecting
                    {
                        state.daemon_starting();
                    }
                })
                .map(|(stream, local)| {
                    if let Ok(mut state) = startup_inbox.lock() {
                        state.local_daemon_peer = local;
                        state.dirty = true;
                    }
                    stream
                });
                if let Err(error) = &result {
                    let category = if crate::daemon::is_missing_installation(error) {
                        "missing_installation"
                    } else {
                        "daemon_connect"
                    };
                    tracing::debug!(category, error_kind = ?error.kind(), raw_os_error = ?error.raw_os_error(), "Connection bridge connector failed");
                }
                if result
                    .as_ref()
                    .is_err_and(crate::daemon::is_missing_installation)
                    && let Ok(mut state) = startup_inbox.lock()
                    && state.status == ConnectionStatus::StartingDaemon
                {
                    state.missing_installation = true;
                    state.dirty = true;
                }
                result.map(herdr_client::Transport::from)
            })
            .map_err(crate::Error::from)
            .and_then(|client| {
                self.handle = Some(client.handle);
                let inbox = self.inbox.clone();
                let drained = self.drained.clone();
                let integrations = self.integrations.clone();
                let links = self.links.clone();
                let scrollback = self.scrollback.clone();
                // Drain ordered events even while GPUI is busy; retain only coherent state.
                spawn(Box::new(move || {
                    while let Ok(event) = client.events.recv() {
                        match &event {
                            ClientEvent::Connected(_) => tracing::debug!("Connection bridge connected"),
                            ClientEvent::Disconnected { .. } => tracing::debug!(category = "transport_disconnected", "Connection bridge disconnected"),
                            _ => {}
                        }
                        let event = match integrations.lock() {
                            Ok(mut integrations) => integrations.apply(event),
                            Err(_) => Some(event),
                        };
                        let event = event.and_then(|event| match scrollback.lock() {
                            Ok(mut scrollback) => scrollback.apply(event),
                            Err(_) => Some(event),
                        });
                        let event = event.and_then(|event| match links.lock() {
                            Ok(mut links) => links.apply(event),
                            Err(_) => Some(event),
                        });
                        if let Ok(mut state) = inbox.lock() {
                            match event {
                                Some(event) => state.apply(event),
                                // A link answer changes nothing the live state
                                // holds, but the window polls only when it is dirty.
                                None => state.dirty = true,
                            }
                        }
                    }
                    drained.store(true, Ordering::Release);
                    tracing::debug!("Connection bridge event reader drained");
                }))
                .map_err(crate::Error::from)
            });
        if let Err(error) = result {
            tracing::warn!(
                category = "bridge_startup",
                "Connection bridge startup failed"
            );
            self.drained.store(true, Ordering::Release);
            if let Some(handle) = self.handle.take() {
                handle.disconnect();
            }
            if let Ok(mut state) = self.inbox.lock() {
                state.apply(ClientEvent::Disconnected {
                    reason: error.to_string(),
                    ssh: None,
                });
            }
        }
    }

    /// Cheap enough to call every display frame: never blocks the UI thread.
    pub fn has_update(&self) -> bool {
        self.inbox.try_lock().is_ok_and(|state| state.dirty)
    }

    pub fn take_update(&self) -> Option<LiveState> {
        let mut state = self.inbox.try_lock().ok()?;
        if !state.dirty {
            return None;
        }
        state.dirty = false;
        // Deliver the single response once rather than cloning a potentially large
        // checkout list into every subsequent surface update.
        let response = state
            .dialog_response
            .as_mut()
            .and_then(|(_, result)| result.take());
        let notifications = std::mem::take(&mut state.notifications);
        let notifications_lost = std::mem::take(&mut state.notifications_lost);
        let sounds = std::mem::take(&mut state.sound_events);
        let reload_sound = std::mem::take(&mut state.reload_sound);
        let clipboard_writes = std::mem::take(&mut state.clipboard_writes);
        let bells = std::mem::take(&mut state.bells);
        let mut update = state.clone();
        update.settings_reload = false;
        update.notifications = notifications;
        update.notifications_lost = notifications_lost;
        update.sound_events = sounds;
        update.reload_sound = reload_sound;
        update.clipboard_writes = clipboard_writes;
        update.bells = bells;
        if let Some((_, result)) = &mut update.dialog_response {
            *result = response;
        }
        Some(update)
    }

    /// Drain only when the background settings loader can accept a reload.
    /// Inbox contention leaves the coalesced request pending for the next poll.
    pub(crate) fn take_settings_reload(&self) -> bool {
        self.inbox
            .try_lock()
            .map(|mut state| std::mem::take(&mut state.settings_reload))
            .unwrap_or(false)
    }

    pub fn request_dialog(
        &self,
        boot_id: &str,
        method: Method,
        params: serde_json::Value,
    ) -> crate::Result<String> {
        // Register while holding the mailbox so even an immediate rejection is retained.
        let mut state = self
            .inbox
            .try_lock()
            .map_err(|_| crate::Error::ConnectionBusy)?;
        let id = self
            .handle
            .as_ref()
            .ok_or(crate::Error::NotConnected)?
            .request(boot_id, method, params)?;
        state.dialog_response = Some((id.clone(), None));
        Ok(id)
    }

    /// Queues the request a worktree script waits on, correlated in its own
    /// slot so a dialog opened meanwhile cannot take its answer.
    pub(crate) fn request_script(
        &self,
        boot_id: &str,
        method: Method,
        params: serde_json::Value,
    ) -> crate::Result<String> {
        let mut state = self
            .inbox
            .try_lock()
            .map_err(|_| crate::Error::ConnectionBusy)?;
        let id = self
            .handle
            .as_ref()
            .ok_or(crate::Error::NotConnected)?
            .request(boot_id, method, params)?;
        state.script_response = Some((id.clone(), None));
        Ok(id)
    }

    pub fn request_integration(
        &self,
        boot_id: &str,
        method: Method,
        params: serde_json::Value,
    ) -> crate::Result<String> {
        // Registration and event delivery share this lock, including immediate rejection.
        let mut inbox = self
            .integrations
            .try_lock()
            .map_err(|_| crate::Error::ConnectionBusy)?;
        if inbox.pending.is_some() {
            return Err(crate::Error::ConnectionBusy);
        }
        let supported = match method {
            Method::IntegrationList => inbox.list,
            Method::IntegrationInstall => inbox.install,
            _ => false,
        };
        if !supported {
            return Err(herdr_client::Error::UnsupportedMethod.into());
        }
        let id = self
            .handle
            .as_ref()
            .ok_or(crate::Error::NotConnected)?
            .request(boot_id, method, params)?;
        inbox.pending = Some((id.clone(), None));
        Ok(id)
    }

    /// Queues a link request without waiting on the event reader: a busy
    /// mailbox is reported as such, and the caller tries again later.
    pub(crate) fn request_link(
        &self,
        request: crate::links::LinkRequest,
        cell: &crate::links::LinkCell,
    ) -> crate::Result<String> {
        let mut links = self
            .links
            .try_lock()
            .map_err(|_| crate::Error::ConnectionBusy)?;
        links.request(
            self.handle.as_ref().ok_or(crate::Error::NotConnected)?,
            request,
            cell,
        )
    }

    /// Report `theme` once this connection has a snapshot to address it to.
    /// The handle skips repeats and starts over on every new connection, so
    /// this is safe to call whenever the theme or appearance may have changed.
    pub fn sync_host_theme(&self, live: &LiveState, theme: &HostTheme) {
        let (Some(handle), Some(snapshot)) = (&self.handle, &live.snapshot) else {
            return;
        };
        if !live.status.is_connected() {
            return;
        }
        // A full queue leaves nothing recorded; the next sync resends it all.
        if let Err(error) = handle.set_host_theme(&snapshot.boot_id, theme) {
            tracing::debug!(%error, "Connection bridge host theme not queued");
        }
    }

    pub fn send_input(
        handle: &ClientHandle,
        boot_id: &str,
        target: &InputTarget,
        event: ClientPaneInputEvent,
    ) -> Result<(), herdr_client::SendError> {
        match target {
            InputTarget::Pane(id) => handle.send_input(boot_id, id, [event]),
            InputTarget::Popup(id) => handle.send_popup_input(boot_id, id, [event]),
        }
    }
}

impl Drop for ConnectionBridge {
    fn drop(&mut self) {
        self.sound_cancel.store(true, Ordering::Release);
        if let Ok(mut state) = self.inbox.try_lock() {
            state.cancel_sounds();
        }
        // Detach this client only; never kill a daemon or PTY.
        if let Some(handle) = &self.handle {
            tracing::debug!("Connection bridge dropping client");
            handle.disconnect();
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests;
