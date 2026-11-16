use super::*;
/// Why a terminal stream ended, as far as the peer said. The catalog picks the
/// first step of the reconnect from it; every cause reconnects.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(in crate::tmux_snapshot) enum Cause {
    /// No close frame: a reset, an I/O error, a timeout, a failed command.
    #[default]
    Lost,
    /// The daemon closed the stream and was there to say so. Any reason this
    /// app does not know, and 1001 "daemon-shutdown", which a 2.9.22 daemon
    /// sends for every close while it stays up.
    Closed,
    /// 1012 "tmux-server-retired": the daemon stays up, the server has a new
    /// generation. The old lease cannot be renewed, so the catalog is read.
    ServerRetired,
    /// 1012 "daemon-restarting": the daemon comes back in place, perhaps on a
    /// new port. Its record is read again.
    DaemonRestarting,
    /// 1000 "panes-closed": the session's last pane exited.
    PanesClosed,
    /// The ready frame was not the lease's (the owner was rebuilt in between).
    Identity,
    /// The daemon advertised a heartbeat and then sent nothing for its limit.
    Silent,
}
impl Cause {
    /// The daemon sent a close frame, so it was reachable a moment ago.
    pub(in crate::tmux_snapshot) fn daemon_spoke(self) -> bool {
        matches!(
            self,
            Self::Closed | Self::ServerRetired | Self::DaemonRestarting | Self::PanesClosed
        )
    }
}
#[derive(Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub(in crate::tmux_snapshot) enum Command {
    #[serde(rename = "native-editor-open")]
    NativeEditorOpen {
        #[serde(flatten)]
        value: super::super::browser_native_editor::Request,
    },
    #[serde(rename = "native-editor-cancel")]
    NativeEditorCancel {
        #[serde(flatten)]
        value: super::super::browser_native_editor::Cancel,
    },
    #[serde(rename = "native-split-layout")]
    NativeSplitLayout {
        version: u8,
        id: String,
        request: u64,
        sequence: u64,
        window: herdr_client::tmux_control::WindowLink,
    },
    #[serde(rename = "native-owner-action")]
    NativeOwnerAction {
        #[serde(flatten)]
        request: super::super::browser_native_owner::Request,
    },
    #[serde(rename = "native-terminal-interrupted", rename_all = "camelCase")]
    NativeTerminalInterrupted {
        version: u8,
        id: String,
        request: u64,
        pane: String,
        live_session_id: String,
        generation: String,
        presence_revision: u64,
        /// In-process only: the pipe protocol has no such field.
        #[serde(skip)]
        cause: Cause,
    },
    #[serde(rename = "native-terminal-ready", rename_all = "camelCase")]
    NativeTerminalReady {
        version: u8,
        id: String,
        request: u64,
        pane: String,
        live_session_id: String,
        generation: String,
        presence_revision: u64,
        input_ready: bool,
        coherent: bool,
    },
    #[serde(rename = "native-terminal-catalog", rename_all = "camelCase")]
    NativeTerminalCatalog {
        version: u8,
        id: String,
        request: u64,
        pane: String,
        live_session_id: String,
        generation: String,
        presence_revision: u64,
        layouts: Vec<herdr_client::tmux_topology::Layout>,
        /// In-process only. The stream's whole pane set, when the stream
        /// follows pane changes in place (capability 119); `None` when its
        /// set is the lease's.
        #[serde(skip)]
        issued: Option<Vec<String>>,
    },
    #[serde(rename = "native-terminal-refresh")]
    NativeTerminalRefresh {
        id: String,
        request: u64,
        #[serde(rename = "preferredPane", skip_serializing_if = "Option::is_none")]
        preferred_pane: Option<String>,
    },
    #[serde(rename = "native-history", rename_all = "camelCase")]
    NativeHistory {
        version: u8,
        id: String,
        request: u64,
        operation_id: u64,
        body: String,
    },
    #[serde(rename = "native-pane-selected", rename_all = "camelCase")]
    NativePaneSelected {
        id: String,
        from_request: u64,
        request: u64,
        pane: String,
    },
    #[serde(rename = "open-workspace-fleet-agent", rename_all = "camelCase")]
    OpenWorkspaceFleetAgent {
        request: u64,
        from_request: u64,
        scope: u64,
        roster_revision: u64,
        key: String,
    },
    #[serde(rename = "session-tab", rename_all = "camelCase")]
    SessionTab {
        request: u64,
        from_request: u64,
        revision: u64,
        action: String,
    },
    #[serde(rename = "session-history", rename_all = "camelCase")]
    SessionHistory {
        request: u64,
        from_request: u64,
        revision: u64,
        action: String,
    },
    // Home stopped sending this with its agent list (#705); the bridge still
    // honours it until the machine filter is removed end to end.
    #[allow(dead_code)]
    #[serde(rename = "home-agent-filter", rename_all = "camelCase")]
    HomeAgentFilter {
        request: u64,
        roster_revision: u64,
        machine_id: Option<String>,
    },
    #[serde(rename = "home-agent-recovery", rename_all = "camelCase")]
    HomeAgentRecovery {
        request: u64,
        roster_revision: u64,
        action: super::super::home::recovery::Action,
    },
    #[serde(rename = "palette-observe")]
    PaletteObserve {
        request: u64,
        scope: u64,
        active: bool,
        query: String,
    },
    #[serde(rename = "open-palette-agent", rename_all = "camelCase")]
    OpenPaletteAgent {
        request: u64,
        from_request: u64,
        scope: u64,
        roster_revision: u64,
        key: String,
    },
    #[serde(rename = "attention-observe")]
    AttentionObserve {
        request: u64,
        scope: u64,
        active: bool,
    },
    #[serde(rename = "open-attention-agent", rename_all = "camelCase")]
    OpenAttentionAgent {
        request: u64,
        from_request: u64,
        scope: u64,
        roster_revision: u64,
        key: String,
    },
    #[serde(rename = "fleet-disconnect")]
    FleetDisconnect {
        request: u64,
        disconnect: String,
    },
    #[serde(rename = "fleet-retry")]
    FleetRetry {
        request: u64,
        retry: String,
    },
    #[serde(rename = "fleet-server")]
    FleetServer {
        request: u64,
        selection: String,
    },
    #[serde(rename = "fleet-session")]
    FleetSession {
        request: u64,
        selection: String,
    },
    #[serde(rename = "machines")]
    Machines {
        request: u64,
        #[serde(flatten)]
        operation: machines::Operation,
    },
    #[serde(rename = "machine-profile")]
    MachineProfile {
        request: u64,
        id: String,
        revision: u64,
    },
    #[serde(rename = "open-workspace-agent", rename_all = "camelCase")]
    OpenWorkspaceAgent {
        request: u64,
        from_request: u64,
        roster_revision: u64,
        key: String,
        session_id: String,
    },
    #[serde(rename = "open-agent", rename_all = "camelCase")]
    OpenAgent {
        request: u64,
        from_request: u64,
        roster_revision: u64,
        key: String,
    },
    #[serde(rename = "create-local-session")]
    CreateLocalSession {
        request: u64,
        action: String,
        name: String,
    },
    #[serde(rename = "create-session")]
    CreateSession {
        request: u64,
        name: String,
    },
    #[serde(rename = "open-editor")]
    OpenEditor {
        request: u64,
        id: String,
        token: String,
    },
    #[serde(rename = "native-browser-controls")]
    BrowserControls {
        request: u64,
        id: String,
        command: Option<herdr_client::tmux_daemon::BrowserCommand>,
    },
    #[serde(rename = "pane-action")]
    PaneAction {
        request: u64,
        id: String,
        token: String,
        #[serde(flatten)]
        action: super::super::pane_actions::Action,
    },
    #[serde(rename = "split-gesture")]
    SplitGesture {
        request: u64,
        gesture: String,
        #[serde(flatten)]
        update: super::super::divider::canonical::Update,
    },
    #[serde(rename = "resize-gesture")]
    ResizeGesture {
        request: u64,
        gesture: String,
        id: String,
        axis: super::super::divider::Axis,
        #[serde(flatten)]
        update: super::super::divider::gesture::Update,
    },
    #[serde(rename = "resize-pane")]
    ResizePane {
        request: u64,
        id: String,
        token: String,
        axis: super::super::divider::Axis,
        cells: u16,
    },
    Theme {
        id: String,
    },
    #[serde(rename = "fleet-preference")]
    FleetPreference {
        request: u64,
        revision: u64,
        action: String,
        enabled: bool,
    },
    Appearance {
        system: super::super::appearance::System,
    },
    Presence {
        active: bool,
        revision: u64,
    },
    Input {
        #[serde(rename = "inputTarget", skip_serializing_if = "Option::is_none")]
        input_target: Option<String>,
        request: u64,
        id: String,
        input: super::super::keys::Input,
    },
    #[serde(rename_all = "camelCase")]
    Machine {
        request: u64,
        ssh_target: Option<String>,
    },
    Home {
        request: u64,
    },
    Refresh {
        request: u64,
    },
    /// Retry a lost terminal stream now instead of waiting out the backoff.
    #[serde(rename = "retry-reconnect")]
    RetryReconnect {
        request: u64,
    },
    #[serde(rename = "local-setup")]
    LocalSetup {
        request: u64,
    },
    Session {
        request: u64,
        id: String,
    },
    Pane {
        request: u64,
        id: String,
    },
    #[serde(rename = "kitty-missing")]
    KittyMissing {
        digests: Vec<String>,
    },
}
