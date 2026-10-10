use herdr_client::{
    ClientEvent, Method, SurfaceImages,
    protocol::{ClientShellSnapshot, PaneSurfaceFrame, ServerMessage},
};
use std::sync::Arc;

mod agent_recency;

use agent_recency::AgentRecency;

pub(crate) type DialogResponse = Result<serde_json::Value, Arc<crate::Error>>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConnectionStatus {
    Connecting,
    StartingDaemon,
    AwaitingSnapshot,
    Connected,
    Disconnected,
    Detached,
}

impl ConnectionStatus {
    pub fn is_connected(self) -> bool {
        matches!(self, Self::AwaitingSnapshot | Self::Connected)
    }
}

impl std::fmt::Display for ConnectionStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Connecting => "Connecting...",
            Self::StartingDaemon => "Starting Herdr server...",
            Self::AwaitingSnapshot => "Connected; waiting for snapshot",
            Self::Connected => "Connected",
            Self::Disconnected => "Disconnected",
            Self::Detached => "Detached (daemon still running)",
        })
    }
}

#[derive(Clone)]
pub struct LiveState {
    pub(crate) settings_reload: bool,
    pub(crate) sound_events: std::collections::VecDeque<(
        std::time::Instant,
        herdr_client::protocol::SemanticNotification,
    )>,
    pub(crate) reload_sound: bool,
    /// Decoded OSC 52 clipboard writes from the daemon, in arrival order. The
    /// UI thread drains them to the pasteboard; the queue is bounded like
    /// sounds, since a pane may write faster than the window repaints.
    pub(crate) clipboard_writes: std::collections::VecDeque<String>,
    /// Terminal bells forwarded since the UI last drained them. Only their
    /// presence matters to the window, so a saturating count bounds a burst.
    pub(crate) bells: u16,
    /// The outer window title the daemon pushed: an agent's
    /// `client.window_title.set`, or its rendered `ui.window_title`. `None`
    /// leaves the window on its own title. Sanitized on receipt.
    pub(crate) window_title: Option<String>,
    pub(crate) sound_cancel: Arc<std::sync::atomic::AtomicBool>,
    pub(crate) sound_connection_cancel: Arc<std::sync::atomic::AtomicBool>,
    pub snapshot: Option<Arc<ClientShellSnapshot>>,
    /// When each of `snapshot`'s agents last changed, on a clock shared with
    /// every other connection, so the agents panel can merge hosts by recency.
    pub(crate) agent_recency: AgentRecency,
    /// The pane focused before the current one, in any workspace or tab of
    /// this daemon boot, for Herdr's `last_pane`.
    pub(crate) previous_pane: Option<String>,
    pub surface: Option<Arc<PaneSurfaceFrame>>,
    /// Pixels for the images the connection's surfaces place, by asset key.
    pub(crate) surface_images: Arc<SurfaceImages>,
    pub status: ConnectionStatus,
    pub error: Option<String>,
    /// Why `ssh` refused the bridge, when that is how the connection ended.
    pub(crate) ssh_failure: Option<herdr_client::SshFailure>,
    pub missing_installation: bool,
    /// Why the last handshake was refused, when updating one side fixes it.
    /// Cleared by the next accepted handshake.
    pub version_mismatch: Option<herdr_client::VersionMismatch>,
    /// Same-user peer at the owned standard socket, not executable attestation.
    pub(crate) local_daemon_peer: bool,
    /// `pane.clear` arrived after Herdr 0.9.1; older daemons reject it.
    pub(crate) supports_pane_clear: bool,
    /// `tab.move` reorders a workspace's tabs; daemons that do not offer it
    /// to clients keep their tabs where they are.
    pub(crate) supports_tab_move: bool,
    /// `pane.link.resolve` and `pane.link.activate` let the daemon find links
    /// across wrapped rows and run plugin link handlers; without them links
    /// are found row by row here and always opened by this client.
    pub(crate) supports_link_resolve: bool,
    pub(crate) supports_link_activate: bool,
    /// `pane.copy_search` drives the find bar; without it Find says so.
    pub(crate) supports_copy_search: bool,
    /// `pane.selection.read` copies selections reaching beyond the screen.
    pub(crate) supports_selection_read: bool,
    /// `pane.copy_motion` drives copy mode's text motions.
    pub(crate) supports_copy_motion: bool,
    /// `pane.edit_scrollback` opens a pane's history in the user's editor.
    pub(crate) supports_edit_scrollback: bool,
    pub dirty: bool,
    pub(crate) dialog_response: Option<(String, Option<DialogResponse>)>,
    /// The one request a worktree script is waiting on (`worktree.list` or
    /// `tab.create`), kept apart from dialogs so opening one cannot lose it.
    /// Cleared from the mailbox once the script job has read it.
    pub(crate) script_response: Option<(String, Option<DialogResponse>)>,
    pub(crate) notifications: std::collections::VecDeque<crate::notifications::Notice>,
    pub(crate) notifications_lost: bool,
    outer_focused: Option<bool>,
    pub activation: Option<SurfaceActivation>,
    pub supports_surface: bool,
    // Bounded rename slots survive coalesced snapshots and do not overwrite a
    // worktree operation whose dialog has already closed.
    pub tab_rename: Option<RenameResult>,
    pub pane_rename: Option<RenameResult>,
    /// The one scrollbar or split drag request in flight; the next waits for
    /// it so a slow link coalesces to the latest position instead of queueing
    /// a backlog.
    pub drag_request: Option<String>,
    /// The product announcement this client dismissed. It stays hidden until
    /// the daemon drops it from the snapshot, and reappears if the daemon
    /// rejects the dismissal.
    pub(crate) announcement_dismissal: Option<AnnouncementDismissal>,
    /// Both dismiss methods arrived with endpoint announcements; a daemon that
    /// does not offer one can only have it hidden for this connection.
    pub(crate) supports_announcement_dismiss: bool,
    pub(crate) supports_release_notes_dismiss: bool,
    /// The daemon's `ClientShellKeyboardReportAll`: the focused pane asked for
    /// every key, including releases, as escape codes. Keys the window already
    /// sends as key events then also send their release.
    pub(crate) keyboard_report_all: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct AnnouncementDismissal {
    /// `None` when the daemon does not offer `product_announcement.dismiss`.
    pub request: Option<String>,
    pub version: String,
    pub id: String,
}

impl AnnouncementDismissal {
    fn covers(&self, snapshot: &ClientShellSnapshot) -> bool {
        snapshot
            .product_announcement
            .as_ref()
            .is_some_and(|current| current.version == self.version && current.id == self.id)
    }
}

#[derive(Clone)]
pub struct RenameResult {
    pub request: String,
    pub result: Option<Result<(), Arc<crate::Error>>>,
}

#[derive(Clone)]
pub struct SurfaceActivation {
    pub request: String,
    pub boot: String,
    pub revision: Option<u64>,
    pub failed: bool,
    pub focus: Option<crate::OwnedNavigationTarget>,
    pub active: bool,
}

impl Default for LiveState {
    fn default() -> Self {
        Self {
            settings_reload: false,
            sound_events: Default::default(),
            reload_sound: false,
            clipboard_writes: Default::default(),
            bells: 0,
            window_title: None,
            sound_cancel: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            sound_connection_cancel: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            snapshot: None,
            agent_recency: AgentRecency::default(),
            previous_pane: None,
            surface: None,
            surface_images: Default::default(),
            status: ConnectionStatus::Connecting,
            error: None,
            ssh_failure: None,
            missing_installation: false,
            version_mismatch: None,
            local_daemon_peer: false,
            supports_pane_clear: false,
            supports_tab_move: false,
            supports_link_resolve: false,
            supports_link_activate: false,
            supports_copy_search: false,
            supports_selection_read: false,
            supports_copy_motion: false,
            supports_edit_scrollback: false,
            dirty: true,
            dialog_response: None,
            script_response: None,
            notifications: Default::default(),
            notifications_lost: false,
            keyboard_report_all: false,
            outer_focused: None,
            activation: None,
            supports_surface: false,
            tab_rename: None,
            pane_rename: None,
            drag_request: None,
            announcement_dismissal: None,
            supports_announcement_dismiss: false,
            supports_release_notes_dismiss: false,
        }
    }
}

impl LiveState {
    /// Whether `next` repaints only the terminal: everything else the window
    /// draws from, the sidebar above all, reads as it did in `self`. Every
    /// field is named so a new one must decide whether it can change quietly.
    pub(crate) fn only_surface_changed(&self, next: &Self) -> bool {
        let Self {
            sound_events,
            reload_sound,
            settings_reload,
            clipboard_writes,
            bells,
            window_title,
            sound_cancel,
            sound_connection_cancel,
            snapshot,
            // Changes only with `snapshot`, which is compared below.
            agent_recency: _,
            previous_pane,
            surface: _,
            surface_images: _,
            status,
            error,
            ssh_failure,
            missing_installation,
            version_mismatch,
            local_daemon_peer,
            supports_pane_clear,
            supports_tab_move,
            supports_link_resolve,
            supports_link_activate,
            supports_copy_search,
            supports_selection_read,
            supports_copy_motion,
            supports_edit_scrollback,
            dirty: _,
            dialog_response,
            script_response,
            notifications,
            notifications_lost,
            outer_focused,
            activation,
            supports_surface,
            tab_rename,
            pane_rename,
            drag_request,
            announcement_dismissal,
            supports_announcement_dismiss,
            supports_release_notes_dismiss,
            // Shapes the next key events, not anything drawn.
            keyboard_report_all: _,
        } = next;
        let same_arc = |a: &Option<Arc<_>>, b: &Option<Arc<_>>| match (a, b) {
            (Some(a), Some(b)) => Arc::ptr_eq(a, b),
            (a, b) => a.is_none() && b.is_none(),
        };
        let pending_rename = |a: &Option<RenameResult>, b: &Option<RenameResult>| match (a, b) {
            (Some(a), Some(b)) => {
                a.request == b.request && a.result.is_none() && b.result.is_none()
            }
            (a, b) => a.is_none() && b.is_none(),
        };
        sound_events.is_empty()
            && !reload_sound
            && !settings_reload
            && clipboard_writes.is_empty()
            && *bells == 0
            && *window_title == self.window_title
            && Arc::ptr_eq(sound_cancel, &self.sound_cancel)
            && Arc::ptr_eq(sound_connection_cancel, &self.sound_connection_cancel)
            && same_arc(snapshot, &self.snapshot)
            && *previous_pane == self.previous_pane
            && *status == self.status
            && *error == self.error
            && *ssh_failure == self.ssh_failure
            && *missing_installation == self.missing_installation
            && *version_mismatch == self.version_mismatch
            && *local_daemon_peer == self.local_daemon_peer
            && *supports_pane_clear == self.supports_pane_clear
            && *supports_tab_move == self.supports_tab_move
            && *supports_link_resolve == self.supports_link_resolve
            && *supports_link_activate == self.supports_link_activate
            && *supports_copy_search == self.supports_copy_search
            && *supports_selection_read == self.supports_selection_read
            && *supports_copy_motion == self.supports_copy_motion
            && *supports_edit_scrollback == self.supports_edit_scrollback
            && match (dialog_response, &self.dialog_response) {
                (Some((a, None)), Some((b, None))) => a == b,
                (a, b) => a.is_none() && b.is_none(),
            }
            && match (script_response, &self.script_response) {
                (Some((a, None)), Some((b, None))) => a == b,
                (a, b) => a.is_none() && b.is_none(),
            }
            && notifications.is_empty()
            && !notifications_lost
            && *outer_focused == self.outer_focused
            && match (activation, &self.activation) {
                (Some(a), Some(b)) => {
                    a.request == b.request
                        && a.boot == b.boot
                        && a.revision == b.revision
                        && a.failed == b.failed
                        && a.focus == b.focus
                        && a.active == b.active
                }
                (a, b) => a.is_none() && b.is_none(),
            }
            && *supports_surface == self.supports_surface
            && pending_rename(tab_rename, &self.tab_rename)
            && pending_rename(pane_rename, &self.pane_rename)
            && *drag_request == self.drag_request
            && *announcement_dismissal == self.announcement_dismissal
            && *supports_announcement_dismiss == self.supports_announcement_dismiss
            && *supports_release_notes_dismiss == self.supports_release_notes_dismiss
    }

    fn has_operation_result(&self, request_id: &str) -> bool {
        [&self.dialog_response, &self.script_response]
            .into_iter()
            .flatten()
            .any(|(id, _)| id == request_id)
            || [&self.tab_rename, &self.pane_rename]
                .into_iter()
                .flatten()
                .any(|rename| rename.request == request_id)
            || self.dismissal_request(request_id)
    }

    fn dismissal_request(&self, request_id: &str) -> bool {
        self.announcement_dismissal
            .as_ref()
            .and_then(|dismissal| dismissal.request.as_deref())
            == Some(request_id)
    }

    /// The daemon's product announcement, unless this client dismissed it.
    pub(crate) fn product_announcement(
        &self,
    ) -> Option<&herdr_client::protocol::ClientShellProductAnnouncement> {
        let snapshot = self.snapshot.as_deref()?;
        if self
            .announcement_dismissal
            .as_ref()
            .is_some_and(|dismissal| dismissal.covers(snapshot))
        {
            return None;
        }
        snapshot.product_announcement.as_ref()
    }

    /// Whether a navigation barrier is unacknowledged, failed, or still waiting
    /// for its focus. An acknowledged activation stays recorded afterwards, so
    /// its presence alone does not mean navigation is in flight.
    pub fn activation_pending(&self) -> bool {
        self.activation.as_ref().is_some_and(|activation| {
            activation.failed
                || !activation.active
                || activation.revision.is_none()
                || activation.focus.is_some()
        })
    }

    pub fn surface_ready(&self) -> bool {
        let (Some(snapshot), Some(surface)) = (&self.snapshot, &self.surface) else {
            return false;
        };
        coherent(snapshot, surface)
            && self.activation.as_ref().is_none_or(|activation| {
                !activation.failed
                    && activation.active
                    && activation.boot == snapshot.boot_id
                    && activation
                        .revision
                        .is_some_and(|revision| surface.projection_revision >= revision)
                    && activation.focus.as_ref().is_none_or(|target| match target {
                        crate::NavigationTarget::Workspace(id) => {
                            snapshot.focused_workspace_id.as_ref() == Some(id)
                        }
                        crate::NavigationTarget::Tab(id) => {
                            snapshot.focused_tab_id.as_ref() == Some(id)
                        }
                        crate::NavigationTarget::Pane(id) => {
                            snapshot.focused_pane_id.as_ref() == Some(id)
                        }
                    })
            })
    }

    pub fn daemon_starting(&mut self) {
        self.status = ConnectionStatus::StartingDaemon;
        self.dirty = true;
    }

    pub fn status_text(&self, local_error: Option<&str>) -> String {
        let error = if self.status.is_connected() {
            local_error.or(self.error.as_deref())
        } else {
            self.error.as_deref()
        };
        match error {
            Some(error) => format!("{}: {error}", self.status),
            None => self.status.to_string(),
        }
    }

    /// Track activation without treating receipt or focus gain as presentation.
    pub fn set_outer_focus(&mut self, focused: bool) {
        // A focus report retried after inbox contention must still cause a draw.
        self.dirty |= self.outer_focused != Some(focused);
        self.outer_focused = Some(focused);
    }

    pub fn apply(&mut self, event: ClientEvent) {
        match event {
            ClientEvent::Connected(welcome) => {
                self.settings_reload = false;
                self.supports_pane_clear = Method::PaneClear.advertised_in(&welcome.methods);
                self.supports_tab_move = Method::TabMove.advertised_in(&welcome.methods);
                self.supports_announcement_dismiss =
                    Method::ProductAnnouncementDismiss.advertised_in(&welcome.methods);
                self.supports_release_notes_dismiss =
                    Method::ReleaseNotesDismiss.advertised_in(&welcome.methods);
                self.supports_link_resolve =
                    crate::links::LinkRequest::Resolve.advertised_in(&welcome.methods);
                self.supports_link_activate =
                    crate::links::LinkRequest::Activate.advertised_in(&welcome.methods);
                self.supports_copy_search = Method::PaneCopySearch.advertised_in(&welcome.methods);
                self.supports_selection_read =
                    Method::PaneSelectionRead.advertised_in(&welcome.methods);
                self.supports_copy_motion = Method::PaneCopyMotion.advertised_in(&welcome.methods);
                self.supports_edit_scrollback =
                    Method::PaneEditScrollback.advertised_in(&welcome.methods);
                self.supports_surface = Method::ClientShellSurfaceSet
                    .advertised_in(&welcome.methods)
                    && ["surface_interest", "presentation_effects_fence"]
                        .iter()
                        .all(|capability| {
                            welcome.capabilities.iter().any(|value| value == capability)
                        });
                self.missing_installation = false;
                self.version_mismatch = None;
                // The daemon reports the mode to each new connection.
                self.keyboard_report_all = false;
                self.status = ConnectionStatus::AwaitingSnapshot;
                self.error = None;
            }
            ClientEvent::Snapshot(snapshot) => {
                if self
                    .snapshot
                    .as_ref()
                    .is_some_and(|old| old.boot_id != snapshot.boot_id)
                {
                    self.notifications.clear();
                    self.cancel_sounds();
                    self.sound_cancel = Arc::new(std::sync::atomic::AtomicBool::new(false));
                    // A restarted daemon pushes its own title; the old one's
                    // must not outlive it.
                    self.bells = 0;
                    self.window_title = None;
                }
                if let Some(activation) = &mut self.activation
                    && activation.boot != snapshot.boot_id
                {
                    activation.failed = true;
                }
                self.missing_installation = false;
                if self
                    .surface
                    .as_ref()
                    .is_some_and(|s| !coherent(&snapshot, s))
                {
                    self.surface = None;
                }
                // Once the daemon drops or replaces the announcement there is
                // nothing left to hide.
                if self
                    .announcement_dismissal
                    .as_ref()
                    .is_some_and(|dismissal| !dismissal.covers(&snapshot))
                {
                    self.announcement_dismissal = None;
                }
                self.status = ConnectionStatus::Connected;
                // Pane IDs are only meaningful within one daemon boot.
                self.previous_pane = match &self.snapshot {
                    Some(old) if old.boot_id == snapshot.boot_id => old
                        .focused_pane_id
                        .clone()
                        .filter(|old| Some(old) != snapshot.focused_pane_id.as_ref())
                        .or_else(|| self.previous_pane.take()),
                    _ => None,
                };
                // Pane IDs, and so each agent's history, belong to one boot.
                let previous = self
                    .snapshot
                    .as_deref()
                    .filter(|old| old.boot_id == snapshot.boot_id);
                self.agent_recency.observe(previous, &snapshot);
                self.snapshot = Some(snapshot);
            }
            ClientEvent::Surface(surface) => {
                if self
                    .snapshot
                    .as_ref()
                    .is_some_and(|s| coherent(s, &surface))
                {
                    self.surface = Some(surface);
                }
            }
            ClientEvent::SurfaceImages(images) => self.surface_images = images,
            // The `Disconnected` that follows carries the reason text.
            ClientEvent::VersionMismatch(mismatch) => self.version_mismatch = Some(mismatch),
            ClientEvent::Disconnected { reason, ssh } => {
                self.ssh_failure = ssh;
                self.settings_reload = false;
                self.notifications.clear();
                self.cancel_sounds();
                self.keyboard_report_all = false;
                self.bells = 0;
                self.window_title = None;
                self.status = ConnectionStatus::Disconnected;
                self.error = Some(reason);
                self.snapshot = None;
                self.agent_recency = AgentRecency::default();
                self.surface = None;
                self.announcement_dismissal = None;
                self.surface_images = Default::default();
            }
            ClientEvent::CommandRejected { request_id, reason } => {
                if request_id.is_some() && request_id == self.drag_request {
                    self.drag_request = None;
                }
                if !request_id
                    .as_deref()
                    .is_some_and(|id| self.has_operation_result(id))
                {
                    self.error = Some(reason.to_string());
                }
                let reason = Arc::new(crate::Error::Client(reason));
                for (id, result) in [&mut self.dialog_response, &mut self.script_response]
                    .into_iter()
                    .flatten()
                {
                    if request_id.as_ref() == Some(id) {
                        *result = Some(Err(reason.clone()));
                    }
                }
                for rename in [&mut self.tab_rename, &mut self.pane_rename]
                    .into_iter()
                    .flatten()
                {
                    if request_id.as_ref() == Some(&rename.request) {
                        rename.result = Some(Err(reason.clone()));
                    }
                }
                if let Some(activation) = &mut self.activation
                    && request_id.as_ref() == Some(&activation.request)
                {
                    activation.failed = true;
                }
                if request_id
                    .as_deref()
                    .is_some_and(|id| self.dismissal_request(id))
                {
                    self.announcement_dismissal = None;
                }
            }
            ClientEvent::Response {
                request_id,
                response,
            } => {
                if self.drag_request.as_ref() == Some(&request_id) {
                    self.drag_request = None;
                }
                for rename in [&mut self.tab_rename, &mut self.pane_rename]
                    .into_iter()
                    .flatten()
                {
                    if request_id == rename.request {
                        rename.result = Some(
                            match response.get("error").filter(|error| !error.is_null()) {
                                Some(error) => {
                                    Err(Arc::new(crate::Error::DaemonResponse(error.clone())))
                                }
                                None => Ok(()),
                            },
                        );
                    }
                }
                if let Some(activation) = &mut self.activation
                    && request_id == activation.request
                {
                    let result = &response["result"];
                    activation.revision = (response.get("error").is_none_or(|e| e.is_null())
                        && result["type"] == "client_shell_surface_set"
                        && result["active"] == activation.active)
                        .then(|| result["projection_revision"].as_u64())
                        .flatten();
                    activation.failed = activation.revision.is_none();
                    if activation.failed {
                        self.error = Some("Invalid surface activation acknowledgement".into());
                    }
                }
                if let Some(error) = response.get("error")
                    && !error.is_null()
                    && !self.has_operation_result(&request_id)
                {
                    self.error = Some(crate::Error::DaemonResponse(error.clone()).to_string());
                }
                if self.dismissal_request(&request_id)
                    && response.get("error").is_some_and(|error| !error.is_null())
                {
                    self.announcement_dismissal = None;
                }
                if let Some((id, result)) = &mut self.script_response
                    && *id == request_id
                {
                    *result = Some(Ok(response.clone()));
                }
                if let Some((id, result)) = &mut self.dialog_response
                    && *id == request_id
                {
                    *result = Some(Ok(response));
                }
            }
            ClientEvent::Message(ServerMessage::ClientShellError { message }) => {
                self.error = Some(message)
            }
            ClientEvent::Message(ServerMessage::SemanticNotification(notification)) => {
                if !self.status.is_connected() {
                    return;
                }
                if self.sound_events.len() == crate::sound::MAX_PENDING {
                    self.sound_events.pop_front();
                }
                let received = std::time::Instant::now();
                self.sound_events
                    .push_back((received, notification.clone()));
                if let Some(pane) = notification.pane_id.as_ref() {
                    self.notifications
                        .retain(|n| n.pane_id.as_ref() != Some(pane));
                }
                if self.notifications.len() == crate::notifications::PENDING_LIMIT {
                    self.notifications.pop_front();
                    // A dropped event may have invalidated an already displayed pane.
                    self.notifications_lost = true;
                }
                self.notifications.push_back(
                    crate::notifications::Notice::new(notification, received)
                        .with_snapshot(self.snapshot.as_deref()),
                );
            }
            ClientEvent::Message(ServerMessage::ReloadSoundConfig) => {
                self.reload_sound = true;
                self.settings_reload = true;
            }
            ClientEvent::Message(ServerMessage::Clipboard { data }) => {
                // OSC 52 bytes from a pane, base64-encoded by the daemon. Only
                // bounded UTF-8 text is written; anything else is dropped.
                if let Some(text) = crate::osc52::decode(&data) {
                    while self.clipboard_writes.len() >= crate::osc52::MAX_PENDING {
                        self.clipboard_writes.pop_front();
                    }
                    self.clipboard_writes.push_back(text);
                } else {
                    tracing::debug!("dropped an invalid or oversized clipboard payload");
                }
            }
            ClientEvent::Message(ServerMessage::TerminalBell { count }) => {
                if count == 0 || !self.status.is_connected() {
                    return;
                }
                self.bells = self.bells.saturating_add(count);
            }
            ClientEvent::Message(ServerMessage::WindowTitle { title }) => {
                let title = title.as_deref().and_then(sanitize_window_title);
                if title == self.window_title {
                    return;
                }
                self.window_title = title;
            }
            ClientEvent::Message(ServerMessage::ClientShellKeyboardReportAll { enabled }) => {
                if enabled == self.keyboard_report_all {
                    return;
                }
                self.keyboard_report_all = enabled;
            }
            // Herdr's own TUI drops `Notify` in client-shell mode as well. A
            // shell client is notified through `SemanticNotification`, which
            // drives toasts and sounds here; `Notify` is the flat form for
            // direct terminal clients.
            ClientEvent::Message(ServerMessage::Notify { .. })
            // Tells the TUI whether to turn on its outer terminal's mouse
            // reporting. Every native mouse event already reaches this window,
            // and each surface pane's `mouse_reporting` decides between local
            // selection and forwarding for the pane under the pointer.
            | ClientEvent::Message(ServerMessage::MouseCapture { .. })
            // Sent only to direct `herdr attach` terminal clients, never to a
            // client shell; the daemon encodes keys for each pane itself.
            | ClientEvent::Message(ServerMessage::DirectTerminalKeyboardProtocol { .. })
            // ANSI frames and kitty graphics for the TUI's `TerminalAnsi`
            // renderer; this client asks for semantic surfaces instead.
            | ClientEvent::Message(ServerMessage::Terminal(_))
            | ClientEvent::Message(ServerMessage::Graphics { .. })
            | ClientEvent::Message(ServerMessage::GraphicsTransmissionRetired { .. })
            // Never read: a daemon-named path is untrusted (see AGENTS.md).
            | ClientEvent::Message(ServerMessage::GraphicsFile { .. })
            // Legacy terminal handshake and binary snapshot; generation-1
            // endpoints use the `endpoint.*` controls, which the session
            // handles before anything reaches this state.
            | ClientEvent::Message(ServerMessage::Welcome { .. })
            | ClientEvent::Message(ServerMessage::ClientShellSnapshot(_))
            // Consumed by the session worker and never forwarded here.
            | ClientEvent::Message(ServerMessage::ServerShutdown { .. })
            | ClientEvent::Message(ServerMessage::PaneSurface(_))
            | ClientEvent::Message(ServerMessage::PaneSurfacePatch(_))
            | ClientEvent::Message(ServerMessage::ClientShellEndpointResponseChunk { .. })
            | ClientEvent::Message(ServerMessage::EndpointControl { .. }) => return,
        }
        // Focus is evidence for completing one navigation, not a permanent
        // constraint on later server-driven focus changes. Settle in the inbox
        // reducer so coalesced updates cannot miss the successful transition.
        if self.surface_ready()
            && let Some(activation) = &mut self.activation
        {
            activation.focus = None;
        }
        self.dirty = true;
    }

    pub(crate) fn cancel_sounds(&mut self) {
        self.sound_cancel
            .store(true, std::sync::atomic::Ordering::Release);
        self.sound_events.clear();
        self.reload_sound = false;
    }
}

/// Longest window title shown, in characters, as Herdr caps its own.
pub(crate) const MAX_WINDOW_TITLE_CHARS: usize = 200;

/// Daemon titles are untrusted pane-influenced text: drop control characters
/// (escape, BEL, C1 terminators included) and cap the length, as Herdr's
/// `sanitize_window_title_text` does. A blank result means no title.
fn sanitize_window_title(title: &str) -> Option<String> {
    let title = title
        .chars()
        .filter(|ch| !ch.is_control())
        .take(MAX_WINDOW_TITLE_CHARS)
        .collect::<String>();
    let title = title.trim();
    (!title.is_empty()).then(|| title.to_owned())
}

fn coherent(snapshot: &ClientShellSnapshot, surface: &PaneSurfaceFrame) -> bool {
    snapshot.boot_id == surface.boot_id && snapshot.revision == surface.projection_revision
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests;
