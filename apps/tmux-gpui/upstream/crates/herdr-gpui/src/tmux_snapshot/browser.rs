//! Bounded browser state and commands. All pipe I/O runs off the UI thread.
use super::{Error, decode};
#[path = "home_agents.rs"]
pub(super) mod home_agents;
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
    pub split_layout: Option<super::divider::canonical::Layout>,
    pub split_gesture: Option<super::divider::canonical::Ack>,
    pub resize_gesture_supported: bool,
    pub resize_gesture: Option<super::divider::gesture::Ack>,
    pub workspace_agents: Option<home_agents::WorkspaceRoster>,
    pub home_agents: Option<home_agents::Roster>,
    pub create_session: Option<CreateSession>,
    pub pane_actions: Option<PaneActions>,
    pub resize_token: Option<String>,
    pub surface: Surface,
    pub home_phase: HomePhase,
    pub appearance: Option<super::appearance::Appearance>,
    pub copy_region: Option<super::copy::Region>,
    pub regions: Vec<super::hit_regions::Region>,
    pub request: u64,
    pub input_ready: bool,
    pub presence_revision: u64,
    pub sessions: Vec<Choice>,
    pub panes: Vec<Choice>,
    pub selected_session: Option<String>,
    pub selected_pane: Option<String>,
    pub status: String,
    pub frame: Option<Arc<FrameData>>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Publication {
    split_layout: Option<super::divider::canonical::Layout>,
    split_gesture: Option<super::divider::canonical::Ack>,
    #[serde(default)]
    resize_gesture_supported: bool,
    resize_gesture: Option<super::divider::gesture::Ack>,
    workspace_agents: Option<home_agents::WorkspaceRoster>,
    home_agents: Option<home_agents::Roster>,
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
    regions: Vec<super::hit_regions::Region>,
    version: u8,
    connection: String,
    sequence: u64,
    request: u64,
    input_ready: bool,
    #[serde(default)]
    presence_revision: u64,
    sessions: Vec<Choice>,
    panes: Vec<Choice>,
    selected_session: Option<String>,
    selected_pane: Option<String>,
    status: String,
    snapshot: Option<serde_json::Value>,
}
#[derive(Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub(super) enum Command {
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
    #[serde(rename = "create-session")]
    CreateSession {
        request: u64,
        name: String,
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
    Home {
        request: u64,
    },
    Refresh {
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
            || p.appearance.as_ref().is_some_and(|a| !a.valid())
            || p.home_agents.as_ref().is_some_and(|r| !r.valid())
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
            || (p.snapshot.is_some() && p.selected_pane.is_none())
        {
            return Err(Error::Invalid("invalid browser state"));
        }
        let frame = p
            .snapshot
            .map(|s| decode::frame(&serde_json::to_vec(&s)?).map(Arc::new))
            .transpose()?;
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
            split_layout: p.split_layout,
            split_gesture: p.split_gesture,
            resize_gesture_supported: p.resize_gesture_supported,
            resize_gesture: p.resize_gesture,
            workspace_agents: p.workspace_agents,
            home_agents: p.home_agents,
            create_session: p.create_session,
            pane_actions: p.pane_actions,
            resize_token: p.resize_token,
            surface,
            home_phase: p.home.map_or(HomePhase::Live, |home| home.phase),
            appearance: p.appearance,
            copy_region: p.copy_region,
            regions: p.regions,
            request: p.request,
            input_ready: p.input_ready,
            presence_revision: p.presence_revision,
            sessions: p.sessions,
            panes: p.panes,
            selected_session: p.selected_session,
            selected_pane: p.selected_pane,
            status: p.status,
            frame,
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
pub(super) fn start() -> Bridge {
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
            let state = match count {
                Ok(n) if n > 0 && n <= 8 * 1024 * 1024 && line.last() == Some(&b'\n') => {
                    reader.accept(&line).ok()
                }
                _ => None,
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
#[path = "browser_home_tests.rs"]
mod home_tests;
