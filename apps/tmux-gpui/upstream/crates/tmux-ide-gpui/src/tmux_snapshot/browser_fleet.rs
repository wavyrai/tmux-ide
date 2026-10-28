//! Display-only fleet metadata. Opaque selection authority belongs to the bridge.
#[path = "browser_fleet/diagnostic.rs"]
mod diagnostic;
use serde::Deserialize;
use std::collections::HashSet;

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(in crate::tmux_snapshot) struct Fleet {
    pub groups: Vec<Group>,
    pub preferences: Option<Preferences>,
    pub omitted_groups: u64,
}
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(in crate::tmux_snapshot) struct Group {
    #[serde(default)]
    pub collapsed: bool,
    pub collapse_action: Option<String>,
    pub id: String,
    pub label: String,
    pub state: Phase,
    pub diagnostic: Option<diagnostic::Diagnostic>,
    pub conflict: bool,
    #[serde(default)]
    pub retry: Option<String>,
    #[serde(default)]
    pub disconnect: Option<String>,
    pub omitted_sessions: u64,
    pub sessions: Vec<Session>,
    #[serde(default)]
    pub servers: Vec<Server>,
    #[serde(default)]
    pub omitted_servers: u64,
}
#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(in crate::tmux_snapshot) enum Phase {
    Ready,
    Connecting,
    Disconnected,
}
impl Phase {
    pub fn label(self) -> &'static str {
        match self {
            Self::Ready => "Connected",
            Self::Connecting => "Connecting…",
            Self::Disconnected => "Disconnected",
        }
    }
}
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(in crate::tmux_snapshot) struct Session {
    #[serde(default)]
    pub server_id: Option<String>,
    #[serde(default)]
    pub favorite: bool,
    pub favorite_action: Option<String>,
    #[serde(default)]
    pub active: bool,
    pub id: String,
    pub name: String,
    pub pane_count: u64,
    pub session_id: Option<String>,
    pub selection: Option<String>,
}
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(in crate::tmux_snapshot) struct Server {
    pub id: String,
    pub label: String,
    pub state: ServerPhase,
    pub generation: Option<String>,
    pub selection: Option<String>,
}
#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(in crate::tmux_snapshot) enum ServerPhase {
    Online,
    Offline,
}
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(in crate::tmux_snapshot) struct SelectedServer {
    pub machine_id: String,
    pub machine_label: String,
    pub server_id: String,
    pub generation: String,
    pub label: String,
}
impl SelectedServer {
    pub fn valid(&self, fleet: &Fleet) -> bool {
        fleet.groups.iter().any(|g| {
            g.id == self.machine_id
                && g.label == self.machine_label
                && g.state == Phase::Ready
                && !g.conflict
                && g.servers.iter().any(|s| {
                    s.id == self.server_id
                        && s.label == self.label
                        && s.state == ServerPhase::Online
                        && s.generation.as_ref() == Some(&self.generation)
                })
        })
    }
}
fn text(value: &str, limit: usize) -> bool {
    !value.is_empty() && value.chars().count() <= limit
}
impl Fleet {
    pub(super) fn valid(&self) -> bool {
        let mut groups = HashSet::new();
        let mut tokens = HashSet::new();
        self.preferences.as_ref().is_none_or(Preferences::valid)
            && self.groups.len() <= 64
            && self.omitted_groups <= 9_007_199_254_740_991
            && self.groups.iter().map(|g| g.sessions.len()).sum::<usize>() <= 512
            && self.groups.iter().map(|g| g.servers.len()).sum::<usize>() <= 128
            && self.groups.iter().all(|g| {
                let mut ids = HashSet::new();
                let mut server_ids = HashSet::new();
                g.collapse_action
                    .as_ref()
                    .is_none_or(|token| self.preference_token(token) && tokens.insert(token))
                    && text(&g.id, 256)
                    && g.retry.as_ref().is_none_or(|token| {
                        g.state == Phase::Disconnected
                            && !g.conflict
                            && token.len() == 36
                            && uuid::Uuid::parse_str(token).is_ok()
                            && tokens.insert(token)
                    })
                    && g.disconnect.as_ref().is_none_or(|token| {
                        token.len() == 36
                            && uuid::Uuid::parse_str(token).is_ok()
                            && tokens.insert(token)
                    })
                    && groups.insert(&g.id)
                    && text(&g.label, 256)
                    && g.servers.len() <= 32
                    && g.omitted_servers <= 9_007_199_254_740_991
                    && g.servers.iter().all(|s| {
                        text(&s.id, 512)
                            && server_ids.insert(&s.id)
                            && text(&s.label, 256)
                            && match s.state {
                                ServerPhase::Online => s.generation.as_ref().is_some_and(|g| {
                                    g.len() == 36 && uuid::Uuid::parse_str(g).is_ok()
                                }),
                                ServerPhase::Offline => {
                                    s.generation.is_none() && s.selection.is_none()
                                }
                            }
                            && s.selection.as_ref().is_none_or(|token| {
                                g.state == Phase::Ready
                                    && !g.conflict
                                    && token.len() == 36
                                    && uuid::Uuid::parse_str(token).is_ok()
                                    && tokens.insert(token)
                            })
                    })
                    && g.sessions.len() <= 128
                    && g.omitted_sessions <= 9_007_199_254_740_991
                    && g.sessions.iter().all(|s| {
                        s.favorite_action.as_ref().is_none_or(|token| {
                            self.preference_token(token) && tokens.insert(token)
                        }) && s.server_id.as_ref().is_none_or(|id| {
                            text(id, 512) && g.servers.iter().any(|server| &server.id == id)
                        }) && text(&s.id, 4096)
                            && ids.insert(&s.id)
                            && text(&s.name, 512)
                            && s.pane_count <= 9_007_199_254_740_991
                            && s.session_id.as_ref().is_none_or(|id| text(id, 512))
                            && s.selection.as_ref().is_none_or(|token| {
                                g.state == Phase::Ready
                                    && !g.conflict
                                    && s.session_id.is_some()
                                    && token.len() == 36
                                    && uuid::Uuid::parse_str(token).is_ok()
                                    && tokens.insert(token)
                            })
                    })
            })
    }
    pub fn server(&self, token: &str) -> Option<&Server> {
        self.groups
            .iter()
            .filter(|g| g.state == Phase::Ready && !g.conflict)
            .flat_map(|g| &g.servers)
            .find(|s| s.state == ServerPhase::Online && s.selection.as_deref() == Some(token))
    }
    pub fn session(&self, token: &str) -> Option<&Session> {
        self.groups
            .iter()
            .filter(|g| g.state == Phase::Ready && !g.conflict)
            .flat_map(|g| &g.sessions)
            .find(|s| s.selection.as_deref() == Some(token))
    }
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(in crate::tmux_snapshot) struct Preferences {
    pub revision: u64,
    pub phase: PreferencePhase,
    pub error: Option<String>,
}
#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(in crate::tmux_snapshot) enum PreferencePhase {
    Unavailable,
    Loading,
    Ready,
    Saving,
    Failed,
}
impl Preferences {
    fn valid(&self) -> bool {
        self.revision <= 9_007_199_254_740_991
            && (self.phase != PreferencePhase::Ready || self.revision > 0)
            && self
                .error
                .as_ref()
                .is_none_or(|e| e.len() <= 256 && !e.chars().any(char::is_control))
    }
}
impl Fleet {
    fn preference_token(&self, token: &str) -> bool {
        self.preferences
            .as_ref()
            .is_some_and(|p| p.phase == PreferencePhase::Ready)
            && token.len() == 36
            && uuid::Uuid::parse_str(token).is_ok()
    }
    pub fn preference_action(&self, revision: u64, action: &str, enabled: bool) -> bool {
        self.preferences
            .as_ref()
            .is_some_and(|p| p.revision == revision && p.phase == PreferencePhase::Ready)
            && self.groups.iter().any(|g| {
                (g.collapse_action.as_deref() == Some(action) && enabled != g.collapsed)
                    || g.sessions.iter().any(|s| {
                        s.favorite_action.as_deref() == Some(action) && enabled != s.favorite
                    })
            })
    }
}
impl Group {
    pub fn shows(&self, session: &Session) -> bool {
        !self.collapsed || session.favorite || session.active
    }
}

#[cfg(test)]
#[path = "browser_fleet/preferences_tests.rs"]
mod preferences_tests;
