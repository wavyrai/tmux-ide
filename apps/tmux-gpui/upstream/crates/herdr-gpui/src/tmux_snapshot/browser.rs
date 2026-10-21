//! Bounded browser state and commands. All pipe I/O runs off the UI thread.
use super::{Error, decode};
#[path = "browser_fleet.rs"]
pub(super) mod fleet;
#[path = "home_agents.rs"]
pub(super) mod home_agents;
#[path = "browser_local_session.rs"]
pub(super) mod local_session;
#[path = "browser_local_setup.rs"]
pub(super) mod local_setup;
#[path = "browser_machines.rs"]
pub(super) mod machines;
use herdr_client::protocol::FrameData;
use serde::{Deserialize, Serialize};
use std::{
    io::{BufRead, BufReader, Read, Write},
    sync::{Arc, Mutex, mpsc},
};

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(super) struct Choice {
    pub pane_count: Option<u64>,
    pub id: String,
    pub label: String,
    pub window_id: Option<String>,
    pub window_label: Option<String>,
}
impl Choice {
    pub(super) fn pane_count_label(&self) -> Option<String> {
        self.pane_count
            .map(|count| format!("{count} {}", if count == 1 { "pane" } else { "panes" }))
    }
}
#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(super) enum Surface {
    #[default]
    Home,
    Workspace,
}
#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(super) enum HomePhase {
    Loading,
    #[default]
    Live,
    Unavailable,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Home {
    phase: HomePhase,
}
#[derive(Clone, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(super) struct PaneActions {
    pub token: String,
    pub id: String,
    pub zoomed: bool,
}
#[derive(Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(super) enum CreatePhase {
    Idle,
    Pending,
    Failed,
}
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct CreateSession {
    pub phase: CreatePhase,
    pub error: Option<String>,
    pub revision: u64,
}
#[derive(Clone, Default)]
pub(super) struct State {
    pub diagnostics: Option<super::diagnostics::Versions>,
    pub pointer_modes: Option<decode::PointerModes>,
    pub local_setup: Option<local_setup::Setup>,
    pub local_session_create: Option<local_session::Capability>,
    pub machines: Option<machines::Registry>,
    pub fleet: Option<fleet::Fleet>,
    pub selected_server: Option<fleet::SelectedServer>,
    pub split_layout: Option<super::divider::canonical::Layout>,
    pub split_gesture: Option<super::divider::canonical::Ack>,
    pub resize_gesture_supported: bool,
    pub resize_gesture: Option<super::divider::gesture::Ack>,
    pub workspace_fleet_agents: Option<super::workspace_fleet_agents::Publication>,
    pub workspace_fleet_agent_rejected: Option<super::workspace_fleet_agents::Rejected>,
    pub workspace_agents: Option<home_agents::WorkspaceRoster>,
    pub home_agents: Option<home_agents::Roster>,
    pub home_agent_filter: Option<super::home::machine_filter::Capability>,
    pub home_agent_recovery: Option<super::home::recovery::Capability>,
    pub session_tabs: Option<super::session_tabs::Publication>,
    pub session_tab_result: Option<super::session_tabs::Result>,
    pub session_history: Option<super::session_history::Capability>,
    pub session_history_rejected: Option<super::session_history::Rejected>,
    pub palette_supported: bool,
    pub palette_selection_rejected: Option<super::picker::attention::Rejected>,
    pub palette_agents: Option<super::picker::attention::Publication>,
    pub attention_supported: bool,
    pub attention_selection_rejected: Option<super::picker::attention::Rejected>,
    pub attention_agents: Option<super::picker::attention::Publication>,
    pub create_session: Option<CreateSession>,
    pub pane_actions: Option<PaneActions>,
    pub resize_token: Option<String>,
    pub surface: Surface,
    pub home_phase: HomePhase,
    pub appearance: Option<super::appearance::Appearance>,
    pub selection_identity: Option<String>,
    pub copy_region: Option<super::copy::Region>,
    pub regions: Vec<super::hit_regions::Region>,
    pub request: u64,
    pub input_ready: bool,
    pub retained_preview: bool,
    pub history_offset: u32,
    pub presence_revision: u64,
    pub sessions: Vec<Choice>,
    pub panes: Vec<Choice>,
    pub session_catalog_complete: bool,
    pub preferred_pane: Option<String>,
    pub selected_session: Option<String>,
    pub selected_pane: Option<String>,
    pub status: String,
    pub frame: Option<Arc<FrameData>>,
    /// Kitty graphics placements in frame cells.
    pub graphics: Vec<super::kitty_graphics::Placement>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Publication {
    diagnostics: Option<super::diagnostics::Versions>,
    local_setup: Option<local_setup::Setup>,
    local_session_create: Option<local_session::Capability>,
    fleet: Option<fleet::Fleet>,
    selected_server: Option<fleet::SelectedServer>,
    machines: Option<machines::Registry>,
    split_layout: Option<super::divider::canonical::Layout>,
    split_gesture: Option<super::divider::canonical::Ack>,
    #[serde(default)]
    resize_gesture_supported: bool,
    resize_gesture: Option<super::divider::gesture::Ack>,
    workspace_fleet_agents: Option<super::workspace_fleet_agents::Publication>,
    workspace_fleet_agent_rejected: Option<super::workspace_fleet_agents::Rejected>,
    workspace_agents: Option<home_agents::WorkspaceRoster>,
    home_agents: Option<home_agents::Roster>,
    home_agent_filter: Option<super::home::machine_filter::Capability>,
    home_agent_recovery: Option<super::home::recovery::Capability>,
    session_tabs: Option<super::session_tabs::Publication>,
    session_tab_result: Option<super::session_tabs::Result>,
    session_history: Option<super::session_history::Capability>,
    session_history_rejected: Option<super::session_history::Rejected>,
    #[serde(default)]
    palette_supported: bool,
    palette_selection_rejected: Option<super::picker::attention::Rejected>,
    palette_agents: Option<super::picker::attention::Publication>,
    #[serde(default)]
    attention_supported: bool,
    attention_selection_rejected: Option<super::picker::attention::Rejected>,
    attention_agents: Option<super::picker::attention::Publication>,
    create_session: Option<CreateSession>,
    pane_actions: Option<PaneActions>,
    resize_token: Option<String>,
    surface: Option<Surface>,
    home: Option<Home>,
    #[serde(default)]
    appearance: Option<super::appearance::Appearance>,
    #[serde(default)]
    copy_region: Option<super::copy::Region>,
    #[serde(default)]
    selection_identity: Option<String>,
    #[serde(default)]
    regions: Vec<super::hit_regions::Region>,
    version: u8,
    connection: String,
    sequence: u64,
    request: u64,
    input_ready: bool,
    #[serde(default)]
    history_offset: u32,
    #[serde(default)]
    presence_revision: u64,
    sessions: Vec<Choice>,
    panes: Vec<Choice>,
    #[serde(default)]
    session_catalog_complete: bool,
    preferred_pane: Option<String>,
    selected_session: Option<String>,
    selected_pane: Option<String>,
    status: String,
    // Kept raw: the terminal grid is decoded once, straight into the painter frame.
    snapshot: Option<Box<serde_json::value::RawValue>>,
    retained_preview: Option<RetainedPreview>,
    #[serde(default)]
    graphics: Vec<super::kitty_graphics::Placement>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RetainedPreview {
    snapshot: Box<serde_json::value::RawValue>,
}
#[derive(Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub(super) enum Command {
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
        action: super::home::recovery::Action,
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
    #[serde(rename = "pane-action")]
    PaneAction {
        request: u64,
        id: String,
        token: String,
        #[serde(flatten)]
        action: super::pane_actions::Action,
    },
    #[serde(rename = "split-gesture")]
    SplitGesture {
        request: u64,
        gesture: String,
        #[serde(flatten)]
        update: super::divider::canonical::Update,
    },
    #[serde(rename = "resize-gesture")]
    ResizeGesture {
        request: u64,
        gesture: String,
        id: String,
        axis: super::divider::Axis,
        #[serde(flatten)]
        update: super::divider::gesture::Update,
    },
    #[serde(rename = "resize-pane")]
    ResizePane {
        request: u64,
        id: String,
        token: String,
        axis: super::divider::Axis,
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
        system: super::appearance::System,
    },
    Presence {
        active: bool,
        revision: u64,
    },
    Input {
        request: u64,
        id: String,
        input: super::keys::Input,
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
pub(super) type Mailbox = Arc<Mutex<Option<Option<State>>>>;
pub(super) struct Bridge {
    pub mailbox: Mailbox,
    pub commands: mpsc::SyncSender<Command>,
}
#[derive(Default)]
struct Reader {
    connection: Option<String>,
    sequence: u64,
    request: u64,
}
impl Reader {
    fn accept(&mut self, line: &[u8]) -> Result<State, Error> {
        let p: Publication = serde_json::from_slice(line)?;
        let surface = p.surface.unwrap_or(if p.selected_session.is_some() {
            Surface::Workspace
        } else {
            Surface::Home
        });
        if p.local_setup.is_some() && surface != Surface::Home {
            return Err(Error::Invalid("Local setup requires Home"));
        }
        local_session::validate(&p, surface)?;
        let retained_preview = p.retained_preview.is_some();
        if p.selection_identity.as_ref().is_some_and(|identity| {
            identity.len() != 64
                || !identity
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                || surface != Surface::Workspace
                || retained_preview
                || p.snapshot.is_none()
                || p.selected_pane.is_none()
                || p.copy_region.is_none()
        }) {
            return Err(Error::Invalid("Invalid selection identity"));
        }
        if p.diagnostics.is_some()
            && (surface != Surface::Workspace
                || !p.input_ready
                || retained_preview
                || p.snapshot.is_none())
        {
            return Err(Error::Invalid(
                "Diagnostic versions require current live workspace",
            ));
        }
        if retained_preview
            && (surface != Surface::Workspace
                || p.snapshot.is_some()
                || p.input_ready
                || p.selected_pane.is_some()
                || p.history_offset != 0
                || p.copy_region.is_some()
                || !p.regions.is_empty()
                || p.resize_token.is_some()
                || p.split_layout.is_some()
                || p.split_gesture.is_some()
                || p.resize_gesture.is_some()
                || p.pane_actions.is_some())
        {
            return Err(Error::Invalid(
                "Retained preview contains terminal authority",
            ));
        }
        if p.selected_server.as_ref().is_some_and(|selected| {
            surface != Surface::Home || p.fleet.as_ref().is_none_or(|fleet| !selected.valid(fleet))
        }) {
            return Err(Error::Invalid("Invalid selected server"));
        }
        if p.home_agent_recovery.as_ref().is_some_and(|c| {
            surface != Surface::Home
                || p.fleet.is_none()
                || c.revision == 0
                || c.revision > 9_007_199_254_740_991
                || p.home_agents
                    .as_ref()
                    .is_none_or(|r| r.revision != c.revision)
        }) {
            return Err(Error::Invalid("Invalid Home agent recovery"));
        }
        if p.home_agent_filter.as_ref().is_some_and(|c| {
            surface != Surface::Home
                || c.revision == 0
                || c.revision > 9_007_199_254_740_991
                || p.home_agents
                    .as_ref()
                    .is_none_or(|r| r.revision != c.revision)
                || p.fleet.as_ref().is_none_or(|f| {
                    c.machine_id
                        .as_ref()
                        .is_some_and(|id| !f.groups.iter().any(|g| &g.id == id))
                })
        }) {
            return Err(Error::Invalid("Invalid Home agent filter"));
        }
        // Home is a detached catalog, never a hidden terminal authority owner.
        if surface == Surface::Home
            && (p.selected_session.is_some()
                || p.selected_pane.is_some()
                || !p.panes.is_empty()
                || p.snapshot.is_some()
                || p.input_ready
                || p.split_layout.is_some()
                || p.split_gesture.is_some()
                || p.resize_token.is_some()
                || p.pane_actions.is_some()
                || p.copy_region.is_some()
                || !p.regions.is_empty())
        {
            return Err(Error::Invalid("Home contains terminal state"));
        }
        if p.pane_actions.as_ref().is_some_and(|a| {
            a.token.len() != 36
                || uuid::Uuid::parse_str(&a.token).is_err()
                || Some(&a.id) != p.selected_pane.as_ref()
                || !p.input_ready
                || p.snapshot.is_none()
                || p.selected_session.is_none()
                || !p.panes.iter().any(|pane| pane.id == a.id)
        }) {
            return Err(Error::Invalid("Invalid pane actions"));
        }
        if p.split_gesture.as_ref().is_some_and(|a| !a.valid()) {
            return Err(Error::Invalid("Invalid split gesture"));
        }
        if p.resize_gesture.as_ref().is_some_and(|a| !a.valid()) {
            return Err(Error::Invalid("Invalid resize gesture"));
        }
        if p.resize_token
            .as_ref()
            .is_some_and(|token| token.len() != 36 || uuid::Uuid::parse_str(token).is_err())
            || p.machines.as_ref().is_some_and(|m| !m.valid())
            || p.fleet.as_ref().is_some_and(|f| !f.valid())
            || p.appearance.as_ref().is_some_and(|a| !a.valid())
            || p.home_agents.as_ref().is_some_and(|r| !r.valid())
            || p.workspace_fleet_agents.as_ref().is_some_and(|r| {
                !r.valid() || r.request != p.request || p.surface != Some(Surface::Workspace)
            })
            || p.workspace_fleet_agent_rejected
                .as_ref()
                .is_some_and(|r| !r.valid() || r.from_request != p.request)
            || p.session_tabs
                .as_ref()
                .is_some_and(|t| !t.valid() || t.request != p.request)
            || p.session_tab_result
                .as_ref()
                .is_some_and(|r| !r.valid() || r.from_request != p.request)
            || p.session_history.as_ref().is_some_and(|h| !h.valid())
            || p.session_history_rejected
                .as_ref()
                .is_some_and(|h| !h.valid() || h.from_request != p.request)
            || p.palette_agents.as_ref().is_some_and(|r| !r.valid())
            || p.palette_selection_rejected
                .as_ref()
                .is_some_and(|r| !r.valid())
            || p.attention_agents.as_ref().is_some_and(|r| !r.valid())
            || p.attention_selection_rejected
                .as_ref()
                .is_some_and(|r| !r.valid())
            || p.workspace_agents.as_ref().is_some_and(|r| {
                !r.valid()
                    || surface != Surface::Workspace
                    || Some(&r.session_id) != p.selected_session.as_ref()
            })
            || p.version != 1
            || p.connection.is_empty()
            || p.connection.len() > 128
            || self.connection.as_ref().is_some_and(|c| *c != p.connection)
            || p.sequence <= self.sequence
            || p.request < self.request
            || p.request > 9_007_199_254_740_991
            || p.create_session
                .as_ref()
                .and_then(|state| state.error.as_ref())
                .is_some_and(|error| error.len() > 256 || error.chars().any(char::is_control))
            || p.create_session
                .as_ref()
                .is_some_and(|state| state.revision > 9_007_199_254_740_991)
            || p.status.len() > 256
            || !valid_choices(&p.sessions)
            || !valid_choices(&p.panes)
            || p.selected_session
                .as_ref()
                .is_some_and(|id| !p.sessions.iter().any(|s| &s.id == id))
            || p.selected_pane
                .as_ref()
                .is_some_and(|id| !p.panes.iter().any(|s| &s.id == id))
            || p.preferred_pane.as_ref().is_some_and(|id| {
                !p.session_catalog_complete
                    || surface != Surface::Workspace
                    || p.selected_session.is_none()
                    || p.selected_pane.is_some()
                    || p.snapshot.is_some()
                    || p.input_ready
                    || !p
                        .panes
                        .iter()
                        .any(|pane| &pane.id == id && pane.window_id.is_some())
            })
            || (p.snapshot.is_some() && p.selected_pane.is_none())
        {
            return Err(Error::Invalid("invalid browser state"));
        }
        let (frame, pointer_modes) = match (&p.snapshot, &p.retained_preview) {
            (Some(live), _) => {
                let (frame, modes) = decode::frame_with_pointer_modes(live.get().as_bytes())?;
                (Some(Arc::new(frame)), modes)
            }
            (None, Some(preview)) => (
                Some(Arc::new(decode::frame(preview.snapshot.get().as_bytes())?)),
                None,
            ),
            (None, None) => (None, None),
        };
        match frame.as_deref() {
            Some(frame) => super::kitty_graphics::validate(&p.graphics, frame.width, frame.height)?,
            None if !p.graphics.is_empty() => {
                return Err(Error::Invalid("kitty graphics without a frame"));
            }
            None => {}
        }
        if !super::hit_regions::valid(&p.regions, frame.as_deref(), &p.panes) {
            return Err(Error::Invalid("invalid pane regions"));
        }
        if p.copy_region.as_ref().is_some_and(|r| {
            frame
                .as_ref()
                .is_none_or(|f| !r.valid(f, p.selected_pane.as_deref()))
        }) {
            return Err(Error::Invalid("invalid copy region"));
        }
        if p.history_offset > 1000
            || (p.history_offset > 0
                && (frame.is_none()
                    || p.selected_pane.is_none()
                    || p.input_ready
                    || surface != Surface::Workspace))
        {
            return Err(Error::Invalid("invalid history offset"));
        }
        if p.split_layout.as_ref().is_some_and(|layout| {
            !p.input_ready
                || !layout.matches(
                    frame.as_deref(),
                    &p.regions,
                    &p.panes,
                    p.selected_session.as_deref(),
                    p.selected_pane.as_deref(),
                )
        }) {
            return Err(Error::Invalid("Invalid split layout presentation"));
        }
        self.connection = Some(p.connection);
        self.sequence = p.sequence;
        self.request = p.request;
        Ok(State {
            diagnostics: p.diagnostics,
            pointer_modes,
            local_setup: p.local_setup,
            local_session_create: p.local_session_create,
            machines: p.machines,
            fleet: p.fleet,
            selected_server: p.selected_server,
            split_layout: p.split_layout,
            split_gesture: p.split_gesture,
            resize_gesture_supported: p.resize_gesture_supported,
            resize_gesture: p.resize_gesture,
            workspace_agents: p.workspace_agents,
            home_agents: p.home_agents,
            home_agent_filter: p.home_agent_filter,
            home_agent_recovery: p.home_agent_recovery,
            palette_supported: p.palette_supported,
            workspace_fleet_agents: p.workspace_fleet_agents,
            workspace_fleet_agent_rejected: p.workspace_fleet_agent_rejected,
            session_tabs: p.session_tabs,
            session_tab_result: p.session_tab_result,
            session_history: p.session_history,
            session_history_rejected: p.session_history_rejected,
            palette_selection_rejected: p.palette_selection_rejected,
            palette_agents: p.palette_agents,
            attention_supported: p.attention_supported,
            attention_selection_rejected: p.attention_selection_rejected,
            attention_agents: p.attention_agents,
            create_session: p.create_session,
            pane_actions: p.pane_actions,
            resize_token: p.resize_token,
            surface,
            home_phase: p.home.map_or(HomePhase::Live, |home| home.phase),
            appearance: p.appearance,
            selection_identity: p.selection_identity,
            copy_region: p.copy_region,
            regions: p.regions,
            request: p.request,
            input_ready: p.input_ready,
            retained_preview,
            history_offset: p.history_offset,
            presence_revision: p.presence_revision,
            sessions: p.sessions,
            panes: p.panes,
            session_catalog_complete: p.session_catalog_complete,
            preferred_pane: p.preferred_pane,
            selected_session: p.selected_session,
            selected_pane: p.selected_pane,
            status: p.status,
            frame,
            graphics: p.graphics,
        })
    }
}
fn valid_choices(choices: &[Choice]) -> bool {
    let mut ids = std::collections::HashSet::new();
    choices.len() <= 512
        && choices.iter().all(|c| {
            !c.id.is_empty()
                && c.id.len() <= 512
                && c.pane_count
                    .is_none_or(|count| count <= 9_007_199_254_740_991)
                && c.label.len() <= 512
                && !c.label.chars().any(char::is_control)
                && c.window_id.as_ref().is_none_or(|v| {
                    !v.is_empty() && v.len() <= 512 && !v.chars().any(char::is_control)
                })
                && c.window_label
                    .as_ref()
                    .is_none_or(|v| v.len() <= 512 && !v.chars().any(char::is_control))
                && ids.insert(&c.id)
        })
}
// Never include the untrusted publication or serde error text in logs.
fn rejection_reason(error: &Error) -> &'static str {
    match error {
        Error::Invalid(reason) => reason,
        Error::Json(_) => "invalid JSON or schema",
        Error::TooLarge => "snapshot exceeds size limit",
        Error::Io(_) => "snapshot read failed",
        Error::Arguments => "invalid snapshot arguments",
    }
}

pub(super) fn start(kitty: super::kitty_graphics::Store) -> Bridge {
    let mailbox = Arc::new(Mutex::new(None));
    let incoming = mailbox.clone();
    std::thread::spawn(move || {
        let mut input = BufReader::new(std::io::stdin().lock());
        let mut reader = Reader::default();
        loop {
            let mut line = Vec::new();
            let count = input
                .by_ref()
                .take(8 * 1024 * 1024 + 1)
                .read_until(b'\n', &mut line);
            if matches!(count, Ok(n) if n > 0 && n <= 8 * 1024 * 1024)
                && line.last() == Some(&b'\n')
                && super::kitty_graphics::is_chunk_line(&line)
            {
                // Image bytes ride beside publications; a bad chunk only loses
                // that image, which the window reports missing.
                if let Err(error) = kitty.accept_line(&line) {
                    eprintln!(
                        "tmux-preview: kitty image chunk rejected: {}",
                        rejection_reason(&error)
                    );
                }
                continue;
            }
            let state = match count {
                Ok(n) if n > 0 && n <= 8 * 1024 * 1024 && line.last() == Some(&b'\n') => {
                    match reader.accept(&line) {
                        Ok(state) => Some(state),
                        Err(error) => {
                            // JSON errors can contain terminal content or identifiers.
                            // Only static validation reasons are safe to report.
                            eprintln!(
                                "tmux-preview: browser publication rejected: {}",
                                rejection_reason(&error)
                            );
                            None
                        }
                    }
                }
                Ok(0) => {
                    eprintln!("tmux-preview: browser publication stream ended");
                    None
                }
                Ok(n) if n > 8 * 1024 * 1024 => {
                    eprintln!("tmux-preview: browser publication exceeds size limit");
                    None
                }
                Ok(_) => {
                    eprintln!("tmux-preview: browser publication missing newline");
                    None
                }
                Err(error) => {
                    eprintln!(
                        "tmux-preview: browser publication read failed: {:?}",
                        error.kind()
                    );
                    None
                }
            };
            let done = state.is_none();
            if let Ok(mut slot) = incoming.lock() {
                *slot = Some(state);
            }
            if done {
                break;
            }
        }
    });
    let (commands, receiver) = mpsc::sync_channel::<Command>(32);
    std::thread::spawn(move || {
        let mut output = std::io::stdout().lock();
        for command in receiver {
            let Ok(mut line) = serde_json::to_vec(&command) else {
                break;
            };
            line.push(b'\n');
            if output
                .write_all(&line)
                .and_then(|_| output.flush())
                .is_err()
            {
                break;
            }
        }
    });
    Bridge { mailbox, commands }
}
#[cfg(test)]
#[path = "browser_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "browser_history_tests.rs"]
mod history_tests;

#[cfg(test)]
#[path = "browser_home_tests.rs"]
mod home_tests;

#[cfg(test)]
#[path = "browser_session_tests.rs"]
mod session_tests;

#[cfg(test)]
#[path = "browser_machine_tests.rs"]
mod machine_tests;

#[cfg(test)]
#[path = "browser_fleet_tests.rs"]
mod fleet_tests;

#[cfg(test)]
#[path = "browser_fleet_retry_tests.rs"]
mod fleet_retry_tests;

#[cfg(test)]
#[path = "browser_fleet_disconnect_tests.rs"]
mod fleet_disconnect_tests;

#[cfg(test)]
#[path = "browser_fleet_server_tests.rs"]
mod fleet_server_tests;

#[cfg(test)]
#[path = "browser_palette_tests.rs"]
mod palette_tests;

#[cfg(test)]
#[path = "browser_session_history_tests.rs"]
mod session_history_tests;

#[cfg(test)]
#[path = "browser_workspace_fleet_tests.rs"]
mod workspace_fleet_tests;

#[cfg(test)]
#[path = "browser_session_tabs_tests.rs"]
mod session_tabs_tests;

#[cfg(test)]
#[path = "browser_retained_preview_tests.rs"]
mod retained_preview_tests;

#[cfg(test)]
#[path = "browser_local_setup_tests.rs"]
mod local_setup_tests;

#[cfg(test)]
#[path = "browser_selection_identity_tests.rs"]
mod selection_identity_tests;

#[cfg(test)]
pub(super) fn fixture_state(bytes: &[u8]) -> Result<State, Error> {
    Reader::default().accept(bytes)
}
