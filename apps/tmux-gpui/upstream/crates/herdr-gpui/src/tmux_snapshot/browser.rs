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
use super::display_frame::DisplayFrame;
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
    pub renderer_probe_scope: Option<super::renderer_probe::Scope>,
    pub diagnostics: Option<super::diagnostics::Versions>,
    pub native_diagnostics: Option<super::browser_native_editor::Diagnostics>,
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
    pub input_targets: Vec<super::pending_input::Target>,
    /// Native lifecycle identity only; never permission to dispatch input.
    pub native_focus_target: Option<super::pending_input::Target>,
    pub input_target_rejected: bool,
    pub copy_region: Option<super::copy::Region>,
    pub regions: Vec<super::hit_regions::Region>,
    pub request: u64,
    pub input_ready: bool,
    pub retained_preview: bool,
    pub native_frame_scope: Option<super::browser_native_preview::Route>,
    pub native_retained_preview: Option<super::browser_native_preview::Route>,
    pub history_offset: u32,
    pub presence_revision: u64,
    pub sessions: Vec<Choice>,
    pub panes: Vec<Choice>,
    pub session_catalog_complete: bool,
    pub preferred_pane: Option<String>,
    pub selected_session: Option<String>,
    pub selected_pane: Option<String>,
    pub status: String,
    pub frame: Option<DisplayFrame>,
    /// Kitty graphics placements in frame cells.
    pub graphics: Vec<super::kitty_graphics::Placement>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Publication {
    diagnostics: Option<super::diagnostics::Versions>,
    native_diagnostics: Option<super::browser_native_editor::Diagnostics>,
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
    input_targets: Option<Vec<super::pending_input::Target>>,
    #[serde(default)]
    input_target_rejected: bool,
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
    // Compatibility null field only; non-null terminal payloads are rejected before decode.
    snapshot: Option<Box<serde_json::value::RawValue>>,
    retained_preview: Option<Box<serde_json::value::RawValue>>,
    native_frame_scope: Option<super::browser_native_preview::Route>,
    native_retained_preview: Option<super::browser_native_preview::Route>,
    #[serde(default)]
    graphics: Vec<super::kitty_graphics::Placement>,
}
#[path = "browser_commands.rs"]
mod commands;
pub(super) use commands::Command;
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
        self.accept_publication(serde_json::from_slice(line)?)
    }
    fn accept_publication(&mut self, p: Publication) -> Result<State, Error> {
        if p.snapshot.is_some()
            || p.retained_preview.is_some()
            || p.input_ready
            || !p.graphics.is_empty()
            || !p.regions.is_empty()
            || p.copy_region.is_some()
            || p.selection_identity.is_some()
            || p.pane_actions.is_some()
            || p.resize_token.is_some()
            || p.split_layout.is_some()
            || p.split_gesture.is_some()
            || p.resize_gesture.is_some()
            || p.resize_gesture_supported
            || p.input_targets
                .as_ref()
                .is_some_and(|targets| !targets.is_empty())
            || p.history_offset != 0
        {
            return Err(Error::Invalid("broker terminal payload is unsupported"));
        }
        if p.native_diagnostics.as_ref().is_some_and(|d| {
            !d.valid()
                || d.request != p.request
                || p.surface != Some(Surface::Workspace)
                || p.selected_pane.as_deref() != Some(d.pane.as_str())
        }) {
            return Err(Error::Invalid("invalid native diagnostics"));
        }
        if p.native_frame_scope
            .iter()
            .chain(p.native_retained_preview.iter())
            .any(|r| !r.valid())
        {
            return Err(Error::Invalid("invalid native preview proof"));
        }
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
        super::pending_input::validate_targets(p.input_targets.as_deref().unwrap_or(&[]))?;
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
        if p.history_offset > 1000
            || (p.history_offset > 0
                && (p.snapshot.is_none()
                    || p.selected_pane.is_none()
                    || p.input_ready
                    || surface != Surface::Workspace))
        {
            return Err(Error::Invalid("invalid history offset"));
        }
        self.connection = Some(p.connection);
        self.sequence = p.sequence;
        self.request = p.request;
        Ok(State {
            diagnostics: p.diagnostics,
            native_diagnostics: p.native_diagnostics,
            pointer_modes: None,
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
            input_targets: p.input_targets.unwrap_or_default(),
            native_focus_target: None,
            renderer_probe_scope: None,
            input_target_rejected: p.input_target_rejected,
            copy_region: p.copy_region,
            regions: p.regions,
            request: p.request,
            input_ready: p.input_ready,
            retained_preview,
            native_frame_scope: p.native_frame_scope,
            native_retained_preview: p.native_retained_preview,
            history_offset: p.history_offset,
            presence_revision: p.presence_revision,
            sessions: p.sessions,
            panes: p.panes,
            session_catalog_complete: p.session_catalog_complete,
            preferred_pane: p.preferred_pane,
            selected_session: p.selected_session,
            selected_pane: p.selected_pane,
            status: p.status,
            frame: None,
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
#[cfg(test)]
fn rejection_reason(error: &Error) -> &'static str {
    match error {
        Error::Invalid(reason) => reason,
        Error::Json(_) => "invalid JSON or schema",
        Error::TooLarge => "snapshot exceeds size limit",
        Error::Io(_) => "snapshot read failed",
        Error::Arguments => "invalid snapshot arguments",
    }
}

#[path = "browser_native_transport.rs"]
mod native_transport;
#[path = "browser_transport.rs"]
mod transport;
pub(super) use transport::start;

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
    // Static link-click fixture adapter, deliberately separate from the production broker Reader.
    let publication: Publication = serde_json::from_slice(bytes)?;
    let snapshot = publication
        .snapshot
        .as_ref()
        .ok_or(Error::Invalid("static fixture missing frame"))?;
    let (frame, modes) = decode::live_frame(snapshot.get().as_bytes())?;
    let mut metadata: serde_json::Value = serde_json::from_slice(bytes)?;
    for field in [
        "snapshot",
        "retainedPreview",
        "copyRegion",
        "selectionIdentity",
        "paneActions",
        "resizeToken",
        "splitLayout",
        "splitGesture",
        "resizeGesture",
        "diagnostics",
    ] {
        metadata[field] = serde_json::Value::Null;
    }
    metadata["inputReady"] = false.into();
    metadata["resizeGestureSupported"] = false.into();
    metadata["historyOffset"] = 0.into();
    for field in ["inputTargets", "regions", "graphics"] {
        metadata[field] = serde_json::json!([]);
    }
    let mut state = Reader::default().accept(&serde_json::to_vec(&metadata)?)?;
    state.frame = Some(DisplayFrame::from(Arc::new(frame)));
    state.pointer_modes = modes;
    state.input_ready = publication.input_ready;
    state.input_targets = publication.input_targets.unwrap_or_default();
    state.copy_region = publication.copy_region;
    state.regions = publication.regions;
    state.selection_identity = publication.selection_identity;
    Ok(state)
}

#[cfg(test)]
#[path = "browser_frame_tests.rs"]
mod frame_tests;

#[cfg(feature = "integration-test")]
pub(super) fn start_journey(
    input: impl Read + Send + 'static,
    output: impl Write + Send + 'static,
) -> Bridge {
    native_transport::start_io(
        Default::default(),
        || BufReader::new(input),
        || output,
        false,
    )
}
