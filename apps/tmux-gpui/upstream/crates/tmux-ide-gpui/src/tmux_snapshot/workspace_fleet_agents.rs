//! Persistent observed fleet agents; routing and selection identity stay with the bridge.
use super::browser_ui::sidebar::{Row, Target};
use super::{SnapshotView, browser};
use browser::home_agents::{Phase, Roster};
use gpui::Context;
use serde::Deserialize;
const MAX: u64 = 9_007_199_254_740_991;
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct SessionScope {
    pub machine: String,
    pub server: String,
    pub generation: String,
    pub session: String,
}
#[derive(Clone)]
pub(super) struct Publication {
    pub request: u64,
    pub scope: u64,
    pub roster: Roster,
    pub selected_key: Option<String>,
    // Native observation provenance; never inferred from display names or opaque keys.
    pub sessions: std::collections::BTreeMap<String, SessionScope>,
}
impl<'de> Deserialize<'de> for Publication {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        use serde::de::Error as _;
        let mut value = serde_json::Value::deserialize(deserializer)?;
        let object = value
            .as_object_mut()
            .ok_or_else(|| D::Error::custom("invalid fleet agents"))?;
        let request = object
            .remove("request")
            .and_then(|v| v.as_u64())
            .ok_or_else(|| D::Error::custom("missing request"))?;
        let scope = object
            .remove("scope")
            .and_then(|v| v.as_u64())
            .ok_or_else(|| D::Error::custom("missing scope"))?;
        let selected_key = serde_json::from_value(
            object
                .remove("selectedKey")
                .ok_or_else(|| D::Error::custom("missing selected key"))?,
        )
        .map_err(D::Error::custom)?;
        let roster = serde_json::from_value(value).map_err(D::Error::custom)?;
        Ok(Self {
            request,
            scope,
            selected_key,
            sessions: Default::default(),
            roster,
        })
    }
}
impl Publication {
    pub(super) fn valid(&self) -> bool {
        self.request <= MAX
            && self.scope > 0
            && self.scope <= MAX
            && self.roster.valid()
            && self
                .selected_key
                .as_ref()
                .is_none_or(|key| self.roster.rows.iter().any(|r| &r.key == key))
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(super) struct Rejected {
    pub request: u64,
    pub from_request: u64,
    pub scope: u64,
    pub roster_revision: u64,
    pub key: String,
}
impl Rejected {
    pub(super) fn valid(&self) -> bool {
        self.request > self.from_request
            && self.request <= MAX
            && self.scope > 0
            && self.scope <= MAX
            && self.roster_revision > 0
            && self.roster_revision <= MAX
            && !self.key.is_empty()
            && self.key.chars().count() <= 512
    }
}
#[derive(Default)]
pub(super) struct Owner {
    pub pending: Option<Rejected>,
    pub last_request: u64,
}
fn row(label: String, detail: Option<String>) -> Row {
    Row {
        label,
        pane_count: detail,
        selected: false,
        target: None,
        depth: 0,
        machine: None,
        agent: None,
        icon: None,
        favorite: None,
        summary: None,
        attention: 0,
    }
}
pub(super) fn rows(state: &browser::State) -> Vec<Row> {
    let Some(p) = state
        .workspace_fleet_agents
        .as_ref()
        .filter(|p| p.request == state.request && p.valid())
    else {
        return Vec::new();
    };
    if state.surface != browser::Surface::Workspace {
        return Vec::new();
    }
    let mut out = Vec::new();
    if !p.roster.rows.is_empty() {
        out.push(row("Agent activity".into(), None));
    }
    if let Some(status) = match p.roster.phase {
        Phase::Loading => Some("Refreshing agents…"),
        Phase::Unavailable => Some("Agent observations unavailable"),
        _ => None,
    } {
        out.push(row(status.into(), None));
    }
    if let Some(note) = &p.roster.note {
        out.push(row(note.clone(), None));
    }
    if p.roster.truncated_sessions > 0 || p.roster.truncated_rows > 0 {
        out.push(row(
            format!(
                "{} sessions · {} agents omitted",
                p.roster.truncated_sessions, p.roster.truncated_rows
            ),
            None,
        ));
    }
    for agent in &p.roster.rows {
        let mut r = row(agent.name.clone(), Some(agent.context_label()));
        r.selected = p.selected_key.as_ref() == Some(&agent.key);
        r.agent = Some(agent.key.clone());
        if p.roster.available(&agent.key) {
            r.target = Some(Target::FleetAgent {
                scope: p.scope,
                revision: p.roster.revision,
                key: agent.key.clone(),
            });
        }
        out.push(r);
    }
    out
}
impl SnapshotView {
    pub(super) fn select_workspace_fleet_agent(
        &mut self,
        request: u64,
        scope: u64,
        revision: u64,
        key: &str,
        cx: &mut Context<Self>,
    ) {
        if request != self.browser_request
            || self.browser_state.request != request
            || self.browser_state.surface != browser::Surface::Workspace
            || !self.presence.ready()
            || self.picker.is_some()
            || self.new_session.is_some()
            || self.pane_actions.is_some()
            || !self.marked.is_empty()
            || self.divider.is_some()
            || self.workspace_fleet_agents.pending.is_some()
            || self.session_tabs.pending.is_some()
            || self.session_history.pending.is_some()
            || self.palette.pending.is_some()
            || self.attention.pending.is_some()
            || !self
                .browser_state
                .workspace_fleet_agents
                .as_ref()
                .is_some_and(|p| {
                    p.request == request
                        && p.scope == scope
                        && p.roster.revision == revision
                        && p.roster.available(key)
                })
        {
            return;
        }
        let Some(next) = self.next_navigation_request() else {
            return;
        };
        self.workspace_fleet_agents.last_request = next;
        let pending = Rejected {
            request: next,
            from_request: request,
            scope,
            roster_revision: revision,
            key: key.into(),
        };
        if self.browser_commands.as_ref().is_some_and(|s| {
            s.try_send(browser::Command::OpenWorkspaceFleetAgent {
                request: next,
                from_request: request,
                scope,
                roster_revision: revision,
                key: key.into(),
            })
            .is_ok()
        }) {
            self.workspace_fleet_agents.pending = Some(pending);
        } else {
            self.browser_state.status =
                "Fleet agent navigation queue unavailable — choose again".into();
        }
        cx.notify();
    }
    pub(super) fn accept_workspace_fleet_agent_state(
        &mut self,
        state: &browser::State,
        cx: &mut Context<Self>,
    ) {
        let Some(p) = self.workspace_fleet_agents.pending.as_ref() else {
            return;
        };
        if self.browser_request != p.from_request
            || (state.request == p.from_request
                && state.workspace_fleet_agent_rejected.as_ref() == Some(p))
        {
            self.workspace_fleet_agents.pending = None;
        } else if state.request == p.request {
            self.browser_request = p.request;
            self.workspace_fleet_agents.pending = None;
            self.pending_session_open = None;
            self.header_controls = Default::default();
            self.sidebar_keyboard.active = false;
            self.cancel_attention();
            self.cancel_palette();
            self.picker = None;
            self.new_session = None;
            self.pane_actions = None;
            self.divider = None;
            self.clear_selection(cx);
            self.discard_composition(cx);
            self.wheel = Default::default();
            self.last_resize = None;
        }
    }
}
