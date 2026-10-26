//! Decode only the observation projection; unrelated shell UI fields are not
//! retained or interpreted. Agent and inventory records remain strict.
use super::*;
use std::collections::BTreeSet;
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentActivity {
    Idle,
    Running,
    Waiting,
    Complete,
    Failed,
    Disconnected,
}
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ObservedHarness {
    Codex,
    ClaudeCode,
    Custom,
}
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TeamSource {
    Manual,
    ClaudeCode,
}
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ObservedTeam {
    pub id: String,
    pub name: String,
    pub source: TeamSource,
}
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ObservedNativePane {
    pub server_epoch: String,
    pub pane_birth_id: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ObservedPaneEndpoint {
    kind: String,
    pub environment_id: String,
    pub server_scope: ServerScope,
    pub pane_lifetime_id: String,
    pub workspace_name: String,
    pub semantic_pane_id: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Envelope {
    pub version: u8,
    pub server: ServerScope,
    pub resource: Resource,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Resource {
    pub project: Project,
    pub workspace: Workspace,
    pub terminal_inventory: Inventory,
}
#[derive(Deserialize)]
pub(super) struct Project {
    pub name: String,
}
#[derive(Deserialize)]
pub(super) struct Workspace {
    pub sidebar: Sidebar,
}
#[derive(Deserialize)]
pub(super) struct Sidebar {
    pub agents: Vec<Agent>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Agent {
    pub id: String,
    pub name: String,
    pub harness: ObservedHarness,
    pub activity: AgentActivity,
    #[serde(deserialize_with = "required_option")]
    pub pane_id: Option<String>,
    pub attention: bool,
    #[serde(default, deserialize_with = "present")]
    pub team: Option<ObservedTeam>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Inventory {
    #[serde(deserialize_with = "required_option")]
    active_resource_id: Option<String>,
    pub resources: Vec<Terminal>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Terminal {
    pub id: String,
    title: String,
    kind: super::super::PaneKind,
    active: bool,
    pub attachability: Attachability,
    #[serde(deserialize_with = "required_option")]
    pub interaction_endpoint: Option<ObservedPaneEndpoint>,
    #[serde(deserialize_with = "required_option")]
    pub native_identity: Option<ObservedNativePane>,
    #[serde(default, deserialize_with = "present")]
    pub window_resource_id: Option<String>,
}
#[derive(Deserialize)]
#[serde(tag = "status", rename_all = "lowercase", deny_unknown_fields)]
pub(super) enum Attachability {
    Available {
        #[serde(rename = "semanticPaneId")]
        semantic_pane_id: String,
    },
    Unavailable {
        reason: String,
    },
}
fn required_option<'de, D: serde::Deserializer<'de>, T: Deserialize<'de>>(
    d: D,
) -> Result<Option<T>, D::Error> {
    Option::<T>::deserialize(d)
}
fn uuid(s: &str) -> bool {
    uuid::Uuid::parse_str(s).is_ok()
}
fn display(s: &str, max: usize) -> bool {
    !s.is_empty() && s.encode_utf16().count() <= max
}
fn semantic(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 128
        && s.as_bytes()[0].is_ascii_alphanumeric()
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
}
pub(super) fn workspace(s: &str) -> bool {
    display(s, 160) && !s.contains(['\0', '\r', '\n'])
}
pub(super) fn live_id(s: &str) -> bool {
    digest(s, "live-session.", 20)
}
fn digest(s: &str, prefix: &str, n: usize) -> bool {
    s.strip_prefix(prefix).is_some_and(|s| {
        s.len() == n
            && s.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}
impl Resource {
    pub(super) fn validate(&self, scope: &ServerScope, workspace_name: &str) -> Result<(), Error> {
        let fail = || Error::ResourceFormat;
        if !display(&self.project.name, 160)
            || self.workspace.sidebar.agents.len() > 64
            || self.terminal_inventory.resources.len() > 512
        {
            return Err(fail());
        }
        let mut ids = BTreeSet::new();
        let mut active = None;
        for r in &self.terminal_inventory.resources {
            if !semantic(&r.id) || !display(&r.title, 160) || !ids.insert(&r.id) {
                return Err(fail());
            }
            if r.active && active.replace(&r.id).is_some() {
                return Err(fail());
            }
            match &r.attachability {
                Attachability::Available { semantic_pane_id } => {
                    if semantic_pane_id != &r.id
                        || !crate::tmux_stream::valid_pane(semantic_pane_id)
                    {
                        return Err(fail());
                    }
                }
                Attachability::Unavailable { reason } => {
                    if r.window_resource_id.is_some()
                        || !matches!(
                            reason.as_str(),
                            "invalid-runtime-proof"
                                | "missing-semantic-stamp"
                                | "invalid-semantic-stamp"
                                | "duplicate-semantic-stamp"
                                | "duplicate-runtime-pane-binding"
                                | "not-single-pane-window"
                                | "missing-window-stamp"
                                | "window-stamp-inconsistent"
                                | "duplicate-window-stamp"
                        )
                    {
                        return Err(fail());
                    }
                }
            }
            if r.window_resource_id
                .as_ref()
                .is_some_and(|id| !digest(id, "terminal-window.", 20))
            {
                return Err(fail());
            }
            if let Some(n) = &r.native_identity {
                let birth = n.pane_birth_id.parse::<u64>().ok();
                if !uuid(&n.server_epoch)
                    || birth.is_none_or(|b| b == 0 || b.to_string() != n.pane_birth_id)
                {
                    return Err(fail());
                }
            }
            if let Some(e) = &r.interaction_endpoint
                && (e.kind != "pane"
                    || !uuid(&e.environment_id)
                    || !uuid(&e.pane_lifetime_id)
                    || &e.server_scope != scope
                    || e.workspace_name != workspace_name
                    || e.semantic_pane_id != r.id
                    || !crate::tmux_stream::valid_pane(&e.semantic_pane_id))
            {
                return Err(fail());
            }
        }
        if active != self.terminal_inventory.active_resource_id.as_ref() {
            return Err(fail());
        }
        let mut agents = BTreeSet::new();
        let mut panes = BTreeSet::new();
        for a in &self.workspace.sidebar.agents {
            if !semantic(&a.id) || !agents.insert(&a.id) || !display(&a.name, 160) {
                return Err(fail());
            }
            if let Some(pane) = &a.pane_id
                && (!semantic(pane)
                    || !panes.insert(pane)
                    || !self
                        .terminal_inventory
                        .resources
                        .iter()
                        .any(|r| &r.id == pane && r.kind == super::super::PaneKind::Agent))
            {
                return Err(fail());
            }
            if let Some(t) = &a.team {
                let valid_id = t.id.strip_prefix("team.").is_some_and(|s| {
                    (16..=64).contains(&s.len())
                        && s.bytes()
                            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
                });
                if !valid_id
                    || !display(&t.name, 80)
                    || t.name.trim() != t.name
                    || t.name.chars().any(char::is_control)
                {
                    return Err(fail());
                }
            }
        }
        Ok(())
    }
}

fn present<'de, D: serde::Deserializer<'de>, T: Deserialize<'de>>(
    d: D,
) -> Result<Option<T>, D::Error> {
    T::deserialize(d).map(Some)
}
