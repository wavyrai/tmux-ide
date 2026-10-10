//! GUI-owned endpoint catalog and connection lifetimes. Each attempt has its own
//! inbox, so retired workers can never publish into a replacement connection.
use super::{
    HerdrWindow, LiveState, NavigationTarget, WheelAccumulator, connection::ConnectionBridge,
    state::ConnectionStatus,
};
use gpui::Context;
use herdr_client::{ClientHandle, ConnectOptions, ConnectTarget, SshFailure, VersionMismatch};
use std::{
    collections::HashSet,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

mod catalog;
mod polling;
mod wake;

pub(super) use catalog::Catalog;
pub(super) use wake::WakeClock;

pub(super) const LOCAL: &str = "local";
/// Saved SSH endpoints are keyed `ssh:<profile-id>`, so no catalog ID can
/// collide with `LOCAL`.
const SAVED_PREFIX: &str = "ssh:";
/// Saved WSL distributions are keyed `wsl:<distribution>`; a distribution is
/// saved at most once.
pub(crate) const WSL_PREFIX: &str = "wsl:";

/// The catalog profile ID behind a saved SSH endpoint's ID, which is what the
/// `herdr machine` commands and per-device credentials are keyed by.
pub(crate) fn saved_profile_id(endpoint_id: &str) -> Option<&str> {
    endpoint_id
        .strip_prefix(SAVED_PREFIX)
        .filter(|id| herdr_client::valid_profile_id(id))
}
const ACTIVATION_TIMEOUT: Duration = Duration::from_secs(5);
const STABLE_CONNECTION_PERIOD: Duration = Duration::from_secs(60);
/// Upstream rechecks failed SSH machines every 30 seconds, so authentication
/// repaired outside the app (a new master, a loaded key) is picked up promptly.
const MAX_RETRY_DELAY: Duration = Duration::from_secs(30);

/// How much of the window an update changes. Ordered, so several updates
/// combine into the widest.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord)]
pub(super) enum Redraw {
    #[default]
    None,
    /// Only the terminal surface: the sidebar keeps its last layout.
    Terminal,
    Window,
}

pub(super) struct Release {
    inbox: Arc<Mutex<LiveState>>,
    drained: Arc<AtomicBool>,
    phase: ReleasePhase,
    boot: String,
}

enum ReleasePhase {
    Deferred(ClientHandle),
    Sent(String),
    Disconnecting,
}

impl Release {
    fn resolved(&mut self) -> bool {
        // Disconnect() requests shutdown; only the event receiver closing proves
        // that this generation's transport is gone. Catalog removal alone is not
        // sufficient evidence to let another surface take ownership.
        if self.drained.load(Ordering::Acquire) {
            return true;
        }
        let Ok(mut state) = self.inbox.try_lock() else {
            return false;
        };
        if let ReleasePhase::Deferred(handle) = &self.phase {
            // Queue and register under the same lock, but never wait for that lock
            // on the UI thread. The destination stays fenced until acknowledgement.
            if !state.status.is_connected()
                || state
                    .snapshot
                    .as_ref()
                    .is_none_or(|s| s.boot_id != self.boot)
            {
                handle.disconnect();
                self.phase = ReleasePhase::Disconnecting;
                return false;
            }
            state.set_outer_focus(false);
            state.surface = None;
            state.dirty = true;
            let result = handle
                .set_focus(&self.boot, false)
                .and_then(|()| handle.set_surface_active(&self.boot, false));
            match result {
                Ok(request) => {
                    state.activation = Some(super::state::SurfaceActivation {
                        request: request.clone(),
                        boot: self.boot.clone(),
                        revision: None,
                        failed: false,
                        focus: None,
                        active: false,
                    });
                    self.phase = ReleasePhase::Sent(request);
                }
                Err(_) => {
                    handle.disconnect();
                    self.phase = ReleasePhase::Disconnecting;
                }
            }
        }
        match &self.phase {
            ReleasePhase::Sent(request) => state.activation.as_ref().is_some_and(|a| {
                a.request == *request
                    && a.boot == self.boot
                    && !a.active
                    && !a.failed
                    && a.revision.is_some()
            }),
            _ => false,
        }
    }
}

pub(super) struct Endpoint {
    pub id: String,
    pub label: String,
    pub connection: ConnectionBridge,
    pub enabled: bool,
    /// The target the saved entry named when this endpoint was last reconciled
    /// against it. Its own session may have been picked in the sessions list
    /// since, so a catalog change can only be told from such a pick by
    /// remembering what the catalog said.
    saved: Option<ConnectTarget>,
    pub collapsed: bool,
    pub collapsed_repos: HashSet<String>,
    pub live: LiveState,
    pub generation: u64,
    pub(crate) toasts: crate::notifications::Toasts,
    /// Derived from `live.snapshot`; refreshed by `sync_live` whenever `live` changes.
    pub(crate) config_diagnostic: crate::config_diagnostic::ConfigDiagnostic,
    /// The last refused handshake's update advice. Unlike `live`, it survives
    /// the retries that reset the bridge, until a handshake is accepted.
    pub(crate) version_mismatch: Option<VersionMismatch>,
    retry_at: Instant,
    attempts: u32,
    online_since: Option<Instant>,
    /// Why the last connection ended, from the drop until a replacement has a
    /// snapshot. Each retry replaces `live`, so the outage outlives it here.
    outage: Option<String>,
    detached: bool,
    initial_surface: bool,
    sounds: crate::sound::Policy,
}

impl Endpoint {
    pub fn surface_requested(&self) -> bool {
        self.initial_surface
    }

    /// Trades this endpoint's connection, and its projection, for another
    /// client of the same daemon that said hello with an active surface, as
    /// an editor group's own connection does. The caller keeps the one this
    /// endpoint had.
    pub(crate) fn trade_connection(
        &mut self,
        connection: &mut ConnectionBridge,
        live: &mut LiveState,
    ) {
        std::mem::swap(&mut self.connection, connection);
        std::mem::swap(&mut self.live, live);
        self.sync_live();
        self.initial_surface = true;
    }

    /// Refreshes state derived from `live` after it is replaced.
    pub(crate) fn sync_live(&mut self) {
        self.config_diagnostic.sync(
            self.live
                .snapshot
                .as_deref()
                .and_then(|snapshot| snapshot.config_diagnostic.as_deref()),
        );
    }
    pub fn new(id: String, label: String, target: ConnectTarget, enabled: bool) -> Self {
        Self {
            id,
            label,
            connection: ConnectionBridge::new(target),
            enabled,
            saved: None,
            collapsed: false,
            collapsed_repos: HashSet::new(),
            live: LiveState::default(),
            generation: 0,
            toasts: Default::default(),
            config_diagnostic: Default::default(),
            version_mismatch: None,
            retry_at: Instant::now(),
            attempts: 0,
            online_since: None,
            outage: None,
            detached: false,
            initial_surface: false,
            sounds: Default::default(),
        }
    }

    fn stop(&mut self) {
        self.toasts.entries.clear();
        self.connection.detach(false);
        self.initial_surface = false;
        self.online_since = None;
        self.generation += 1;
        self.live = self.connection.take_update().unwrap_or_default();
        self.sync_live();
    }

    /// The SSH target and session this device was saved with. The sessions list
    /// may have pointed the live connection at another of the host's sessions,
    /// so whatever speaks for the saved device (duplicate checks, the device's
    /// own menu) reads this instead. One never reconciled against the catalog
    /// has only its live target to go on.
    pub(crate) fn saved_ssh(&self) -> Option<(&str, &str)> {
        match self.saved_target() {
            ConnectTarget::Ssh { target, session } => Some((target, session)),
            _ => None,
        }
    }

    /// The target this device was saved with, SSH or WSL alike; see
    /// [`Self::saved_ssh`].
    pub(crate) fn saved_target(&self) -> &ConnectTarget {
        self.saved.as_ref().unwrap_or(&self.connection.target)
    }

    /// Point this endpoint at another target, retiring the old transport. The
    /// endpoint keeps its identity, label, and sidebar state; nothing the old
    /// connection produced survives it.
    fn retarget(&mut self, target: ConnectTarget) {
        self.stop();
        self.outage = None;
        self.connection = ConnectionBridge::new(target);
        self.detached = false;
        self.attempts = 0;
        self.version_mismatch = None;
        // The replacement transport has produced no state of its own yet.
        self.live = LiveState::default();
        self.sync_live();
    }

    fn connect(&mut self, options: ConnectOptions, active: bool) {
        self.stop();
        self.detached = false;
        self.initial_surface = active;
        self.attempts = self.attempts.saturating_add(1);
        self.connection.reconnect(options, false, active);
        self.live = self.connection.take_update().unwrap_or_default();
        self.sync_live();
        self.toasts.receive(self.live.notifications.drain(..));
        self.retry_at = Instant::now() + self.retry_delay();
    }

    fn poll(&mut self, now: Instant) -> Redraw {
        let mut changed = Redraw::None;
        if let Some(mut state) = self.connection.take_update() {
            changed = if self.live.only_surface_changed(&state) {
                Redraw::Terminal
            } else {
                Redraw::Window
            };
            if state.notifications_lost
                || !state.status.is_connected()
                || self
                    .live
                    .snapshot
                    .as_ref()
                    .zip(state.snapshot.as_ref())
                    .is_some_and(|(old, new)| old.boot_id != new.boot_id)
            {
                self.toasts.entries.clear();
            }
            self.toasts.receive(state.notifications.drain(..));
            if state.version_mismatch.is_some() {
                self.version_mismatch = state.version_mismatch.clone();
            } else if state.status.is_connected() {
                self.version_mismatch = None;
            }
            // The worker stops the handle before its disconnect state reaches
            // the inbox, so a drop already seen learns its reason here.
            if self.connection.handle.is_none()
                && self.outage.is_some()
                && !state.status.is_connected()
            {
                if let Some(error) = &state.error {
                    self.outage = Some(error.clone());
                }
                let needs_user =
                    |live: &LiveState| live.ssh_failure.is_some_and(SshFailure::needs_user);
                if needs_user(&state) && !needs_user(&self.live) {
                    self.retry_at = self.retry_at.max(now + MAX_RETRY_DELAY);
                }
            }
            self.live = state;
            self.sync_live();
        }
        if self
            .connection
            .handle
            .as_ref()
            .is_some_and(ClientHandle::is_disconnected)
        {
            self.connection.handle = None;
            // A host that refused for a reason only the user can fix is not
            // redialled every few seconds meanwhile.
            let delay = if self.live.ssh_failure.is_some_and(SshFailure::needs_user) {
                MAX_RETRY_DELAY
            } else {
                self.retry_delay()
            };
            self.retry_at = now + delay;
            self.outage = Some(
                self.live
                    .error
                    .clone()
                    .unwrap_or_else(|| "connection lost".into()),
            );
            changed = Redraw::Window;
        }
        if self.connection.handle.is_some()
            && self.live.status.is_connected()
            && self.live.snapshot.is_some()
        {
            self.outage = None;
            let since = self.online_since.get_or_insert(now);
            if now.duration_since(*since) >= STABLE_CONNECTION_PERIOD {
                self.attempts = 0;
            }
        } else {
            self.online_since = None;
        }
        changed
    }

    /// Dial again at once, keeping the backoff earned so far for any later
    /// failure. Detached and disabled endpoints stay as they are.
    fn retry_now(&mut self, now: Instant) {
        self.retry_at = self.retry_at.min(now);
    }

    /// Why the endpoint is reconnecting, while it is.
    pub(crate) fn outage(&self) -> Option<&str> {
        self.outage.as_deref()
    }

    fn retry_delay(&self) -> Duration {
        Duration::from_millis(500u64 << self.attempts.min(8)).min(MAX_RETRY_DELAY)
    }

    pub fn status(&self) -> &'static str {
        if !self.enabled {
            "disabled"
        } else if self.detached {
            "detached"
        } else if let Some(mismatch) = &self.version_mismatch {
            // A refused handshake is an outage too, but says what fixes it.
            match mismatch {
                VersionMismatch::DaemonOutdated { .. } => "Herdr update needed",
                VersionMismatch::ClientOutdated { .. } => "app update needed",
            }
        } else if self.outage.is_some() {
            // Before `live`: a stopped handle can precede its disconnect state.
            "reconnecting"
        } else if self.live.status.is_connected() {
            "online"
        } else if self.live.error.is_some() {
            "reconnecting"
        } else {
            "connecting"
        }
    }
}

impl Drop for Endpoint {
    fn drop(&mut self) {
        self.stop();
    }
}

impl HerdrWindow {
    /// Move every matching live target in this window away from a session that
    /// the user confirmed for deletion. This retires transports without I/O on
    /// the UI thread. The caller reconnects the selected endpoint if it moved.
    pub(super) fn retarget_session_for_deletion(&mut self, target: &ConnectTarget) -> bool {
        let mut selected_changed = false;
        for (index, endpoint) in self.endpoints.iter_mut().enumerate() {
            let replacement = match target {
                ConnectTarget::Session {
                    name,
                    development: false,
                } if name != "default"
                    && index == 0
                    && target.socket_path().ok().is_some_and(|path| {
                        endpoint.connection.target.socket_path().ok() == Some(path)
                    }) =>
                {
                    Some(ConnectTarget::Session {
                        name: "default".into(),
                        development: false,
                    })
                }
                _ if target
                    .remote_session()
                    .is_some_and(|session| session != "default")
                    && endpoint.connection.target == *target =>
                {
                    target.remote_host().map(|host| host.target("default"))
                }
                _ => None,
            };
            if let Some(replacement) = replacement {
                endpoint.retarget(replacement);
                selected_changed |= index == self.selected_endpoint;
            }
        }
        selected_changed
    }

    pub(super) fn reconnect(&mut self, cx: &mut Context<Self>) {
        let index = self.selected_endpoint;
        if !self.endpoints[index].enabled {
            return;
        }
        self.install_warning_shown = false;
        self.version_notice_shown = false;
        self.endpoints[index].attempts = 0;
        self.endpoints[index].connect(self.options, index == 0);
        self.reset_selected(cx);
    }

    pub(super) fn detach_endpoint(&mut self, cx: &mut Context<Self>) {
        let endpoint = &mut self.endpoints[self.selected_endpoint];
        endpoint.stop();
        endpoint.outage = None;
        endpoint.detached = true;
        endpoint.live.status = ConnectionStatus::Detached;
        if let Ok(mut state) = endpoint.connection.inbox.lock() {
            *state = endpoint.live.clone();
        }
        self.reset_selected(cx);
    }

    pub(super) fn reset_selected(&mut self, cx: &mut Context<Self>) {
        if let Some(transfer) = &self.file_transfer {
            transfer.cancel();
        }
        for image in &self.pending_images {
            image.cancel();
        }
        self.clear_pending_input();
        self.menu.reset();
        self.selection_epoch += 1;
        self.discard_composition(cx);
        let endpoint = &self.endpoints[self.selected_endpoint];
        self.selected_generation = endpoint.generation;
        self.live = endpoint.live.clone();
        if !endpoint.initial_surface {
            self.live.surface = None;
        }
        // Another connection's picture is not this one's, so a detach or a
        // retarget starts from an empty terminal area. A reconnect after a drop
        // keeps the last picture, dimmed, until the new connection's arrives.
        if endpoint.outage.is_none() {
            self.presentation.clear();
        }
        self.selection = None;
        self.terminal_mouse = None;
        self.pressed_terminal_link = None;
        self.flash = None;
        self.local_error = None;
        self.last_queued_options = None;
        self.sent_focus = None;
        self.wheel = WheelAccumulator::default();
        self.activation_deadline = (self.selected_endpoint != 0 && !endpoint.detached)
            .then(|| Instant::now() + ACTIVATION_TIMEOUT);
        self.pending_navigation = None;
        self.pending_toast = None;
    }

    pub(super) fn select_endpoint(&mut self, id: &str, cx: &mut Context<Self>) -> bool {
        if !self.switch_endpoint(id, cx) {
            return false;
        }
        self.catalog.choose(id);
        if let Some(error) = self.catalog.poll_write() {
            self.local_error = Some(format!("Save host selection: {error}"));
            cx.notify();
        }
        true
    }

    /// The installation this window's local endpoint belongs to. A development
    /// target lists the development catalog's sessions, not the release ones.
    pub(super) fn local_development(&self) -> bool {
        matches!(
            self.endpoints[0].connection.target,
            ConnectTarget::Session {
                development: true,
                ..
            }
        )
    }

    /// Attach this window to another named local session. The local endpoint
    /// keeps its identity, so the session changes its target rather than adding
    /// an endpoint for every session on the machine.
    pub(super) fn select_local_session(&mut self, name: &str, cx: &mut Context<Self>) {
        let target = ConnectTarget::Session {
            name: name.to_owned(),
            development: self.local_development(),
        };
        if self.selected_endpoint == 0 && self.endpoints[0].connection.target == target {
            return;
        }
        // Retarget before selecting: the poll loop reconnects endpoint zero, so
        // it must never still name the session it is leaving.
        if self.endpoints[0].connection.target != target {
            self.endpoints[0].retarget(target);
        }
        if self.selected_endpoint != 0 && !self.switch_endpoint(LOCAL, cx) {
            return;
        }
        // This is a deliberate move off any remote selection, which must not be
        // restored over it on the next launch.
        self.catalog.choose(LOCAL);
        self.reconnect(cx);
        // After the reconnect: resetting the connection clears the error slot.
        if let Some(error) = self.catalog.poll_write() {
            self.local_error = Some(format!("Save host selection: {error}"));
        }
        cx.notify();
    }

    /// Attach this window to another session of a saved device. The device keeps
    /// its identity, so the session changes that endpoint's target rather than
    /// adding an endpoint for every session the host has.
    pub(super) fn select_device_session(
        &mut self,
        id: &str,
        session: &str,
        cx: &mut Context<Self>,
    ) {
        let Some(index) = self
            .endpoints
            .iter()
            .position(|endpoint| endpoint.id == id && endpoint.enabled)
        else {
            return;
        };
        // Only a remote device has a session to name; the local endpoint has
        // its own path through `select_local_session`.
        let Some(host) = self.endpoints[index].connection.target.remote_host() else {
            return;
        };
        let target = host.target(session);
        if self.selected_endpoint == index && self.endpoints[index].connection.target == target {
            return;
        }
        // Retarget before switching, exactly as attaching to a local session
        // does: the poll loop reconnects this endpoint, so it must never still
        // name the session the window is leaving.
        let retargeted = self.endpoints[index].connection.target != target;
        if retargeted {
            self.endpoints[index].retarget(target);
        }
        if self.selected_endpoint != index && !self.switch_endpoint(id, cx) {
            return;
        }
        self.catalog.choose(id);
        // Only a session this device was not already on needs a new connection:
        // choosing the device itself keeps the transport it has, the way choosing
        // it from the picker does.
        if retargeted {
            self.reconnect(cx);
        }
        // After the reconnect: resetting the connection clears the error slot.
        if let Some(error) = self.catalog.poll_write() {
            self.local_error = Some(format!("Save host selection: {error}"));
        }
        cx.notify();
    }

    fn switch_endpoint(&mut self, id: &str, cx: &mut Context<Self>) -> bool {
        let Some(index) = self.endpoints.iter().position(|e| e.id == id && e.enabled) else {
            return false;
        };
        if index == self.selected_endpoint {
            return true;
        }
        if index != 0
            && self.endpoints[self.selected_endpoint]
                .live
                .status
                .is_connected()
            && !self.endpoints[self.selected_endpoint].live.supports_surface
        {
            self.local_error = Some("Current endpoint does not support surface switching".into());
            cx.notify();
            return false;
        }
        self.release_selected();
        if index == 0 {
            // Local is the escape hatch and never waits on a remote release. An
            // unsent release must still retire its exact source transport.
            for release in &self.pending_releases {
                if let ReleasePhase::Deferred(handle) = &release.phase {
                    handle.disconnect();
                }
            }
            self.pending_releases.clear();
        }
        self.selected_endpoint = index;
        if self.device_filter.is_some() {
            self.device_filter = Some(id.to_owned());
        }
        self.reset_selected(cx);
        // The picture kept for an outage is the previous endpoint's.
        self.presentation.clear();
        self.activation_deadline =
            (!self.endpoints[index].detached).then(|| Instant::now() + ACTIVATION_TIMEOUT);
        cx.notify();
        true
    }

    fn release_selected(&mut self) {
        let endpoint = &mut self.endpoints[self.selected_endpoint];
        // A handshake started with an active surface cannot be demoted without
        // its boot ID. Retire that attempt rather than let it finish in background.
        if endpoint.initial_surface
            && (endpoint.connection.handle.is_none() || endpoint.live.snapshot.is_none())
        {
            endpoint.stop();
            endpoint.retry_at = Instant::now();
            return;
        }
        if endpoint.initial_surface
            && let (Some(handle), Some(snapshot)) =
                (&endpoint.connection.handle, &endpoint.live.snapshot)
        {
            let mut release = Release {
                inbox: endpoint.connection.inbox.clone(),
                drained: endpoint.connection.drained.clone(),
                phase: ReleasePhase::Deferred(handle.clone()),
                boot: snapshot.boot_id.clone(),
            };
            if !release.resolved() {
                self.pending_releases.push(release);
            }
        } else if let Ok(mut state) = endpoint.connection.inbox.try_lock() {
            state.set_outer_focus(false);
            state.surface = None;
        }
        endpoint.initial_surface = false;
        endpoint.live.surface = None;
    }

    pub(super) fn navigate_endpoint(
        &mut self,
        endpoint: &str,
        target: NavigationTarget<&str>,
        cx: &mut Context<Self>,
    ) -> bool {
        if self.menu.page.is_some() {
            return false;
        }
        if !self.select_endpoint(endpoint, cx) {
            return false;
        }
        self.pending_toast = None;
        self.pending_navigation = None;
        if self.input_ready() {
            self.navigate(target, cx);
        } else {
            self.pending_navigation = Some((&target).into());
        }
        true
    }

    pub(super) fn input_ready(&self) -> bool {
        self.pending_toast.is_none() && self.navigation_ready()
    }

    // A coherent surface permits the deferred navigation attempt, not terminal
    // input while its toast target is still waiting for inbox validation.
    pub(crate) fn navigation_ready(&self) -> bool {
        self.surface_activation_ready() && self.surface_matches_options()
    }

    /// Whether the daemon's frame is the size this client asked for. A
    /// mismatch means someone else resized the tab (a CLI, or another
    /// window): the size has to be asked for again, not only waited on.
    pub(crate) fn surface_matches_options(&self) -> bool {
        self.live.surface.as_ref().is_some_and(|surface| {
            surface.frame.width == self.options.surface_size.cols
                && surface.frame.height == self.options.surface_size.rows
        })
    }

    pub(crate) fn surface_activation_ready(&self) -> bool {
        self.endpoints[self.selected_endpoint]
            .connection
            .handle
            .is_some()
            && self.endpoints[self.selected_endpoint].surface_requested()
            && self.pending_releases.is_empty()
            && self.live.surface_ready()
    }
}

// The fixtures drive the real client over bound Unix sockets and POSIX processes.
#[cfg(all(test, unix))]
mod lifecycle_tests;

#[cfg(test)]
mod tests;
