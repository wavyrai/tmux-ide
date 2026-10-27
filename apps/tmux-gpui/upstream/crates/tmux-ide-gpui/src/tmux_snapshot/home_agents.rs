//! Bounded display projection. Identity strings remain opaque, including embedded NUL.
use serde::Deserialize;
#[derive(Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(in crate::tmux_snapshot) enum Phase {
    Loading,
    Live,
    Partial,
    Unavailable,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub(in crate::tmux_snapshot) enum Status {
    Working,
    Blocked,
    Done,
    Failed,
    Disconnected,
    Idle,
}
impl Status {
    pub(in crate::tmux_snapshot) fn label(&self) -> &'static str {
        match self {
            Self::Working => "WORKING",
            Self::Blocked => "BLOCKED",
            Self::Done => "DONE",
            Self::Failed => "FAILED",
            Self::Disconnected => "DISCONNECTED",
            Self::Idle => "IDLE",
        }
    }
}
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(in crate::tmux_snapshot) struct Row {
    pub key: String,
    pub session_id: String,
    pub pane_id: Option<String>,
    pub name: String,
    pub session_label: String,
    pub machine_label: Option<String>,
    pub server_label: Option<String>,
    pub project_name: Option<String>,
    pub harness: Option<String>,
    pub team_name: Option<String>,
    pub status: Status,
    pub attention: bool,
    pub available: bool,
}
impl Row {
    pub(in crate::tmux_snapshot) fn matches_query(&self, query: &str) -> bool {
        let query = query.trim().to_lowercase();
        [
            Some(self.name.as_str()),
            Some(self.session_label.as_str()),
            self.machine_label.as_deref(),
            self.server_label.as_deref(),
            self.project_name.as_deref(),
            self.harness.as_deref(),
            self.team_name.as_deref(),
        ]
        .into_iter()
        .flatten()
        .any(|value| value.to_lowercase().contains(&query))
    }
    pub(in crate::tmux_snapshot) fn context_label(&self) -> String {
        [
            self.machine_label.as_deref(),
            self.server_label.as_deref(),
            Some(self.session_label.as_str()),
        ]
        .into_iter()
        .flatten()
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>()
        .join(" · ")
    }
}
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(in crate::tmux_snapshot) struct Roster {
    pub revision: u64,
    pub phase: Phase,
    pub rows: Vec<Row>,
    pub observed_sessions: u64,
    pub total_sessions: u64,
    pub truncated_sessions: u64,
    pub truncated_rows: u64,
    pub note: Option<String>,
}
impl Roster {
    pub(in crate::tmux_snapshot) fn valid(&self) -> bool {
        let display = |s: &str, max| s.chars().count() <= max && !s.chars().any(char::is_control);
        let id = |s: &str| !s.is_empty() && s.chars().count() <= 512;
        let mut keys = std::collections::HashSet::new();
        self.revision > 0
            && self.revision <= 9_007_199_254_740_991
            && [
                self.observed_sessions,
                self.total_sessions,
                self.truncated_sessions,
                self.truncated_rows,
            ]
            .iter()
            .all(|v| *v <= 9_007_199_254_740_991)
            && self.observed_sessions <= self.total_sessions
            && self.truncated_sessions <= self.total_sessions
            && self.rows.len() <= 256
            && self.note.as_ref().is_none_or(|s| display(s, 240))
            && self.rows.iter().all(|r| {
                id(&r.key)
                    && id(&r.session_id)
                    && r.pane_id.as_ref().is_none_or(|s| id(s))
                    && (!r.available || r.pane_id.is_some())
                    && display(&r.name, 160)
                    && display(&r.session_label, 160)
                    && [
                        &r.machine_label,
                        &r.server_label,
                        &r.project_name,
                        &r.harness,
                        &r.team_name,
                    ]
                    .into_iter()
                    .all(|value| value.as_ref().is_none_or(|value| display(value, 160)))
                    && keys.insert(&r.key)
            })
    }
    pub(in crate::tmux_snapshot) fn available(&self, key: &str) -> bool {
        matches!(self.phase, Phase::Live | Phase::Partial)
            && self
                .rows
                .iter()
                .any(|r| r.key == key && r.available && r.pane_id.is_some())
    }
}
/// Reuse the same strict roster decoder after removing the explicit workspace scope.
#[derive(Clone)]
pub(in crate::tmux_snapshot) struct WorkspaceRoster {
    pub session_id: String,
    pub roster: Roster,
}
impl<'de> Deserialize<'de> for WorkspaceRoster {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        use serde::de::Error as _;
        let mut value = serde_json::Value::deserialize(deserializer)?;
        let session_id = value
            .as_object_mut()
            .and_then(|o| o.remove("sessionId"))
            .and_then(|v| v.as_str().map(str::to_owned))
            .ok_or_else(|| D::Error::custom("missing workspace session"))?;
        let roster = serde_json::from_value(value).map_err(D::Error::custom)?;
        Ok(Self { session_id, roster })
    }
}
impl WorkspaceRoster {
    pub(in crate::tmux_snapshot) fn valid(&self) -> bool {
        !self.session_id.is_empty()
            && self.session_id.chars().count() <= 512
            && self.roster.valid()
            && self
                .roster
                .rows
                .iter()
                .all(|r| r.session_id == self.session_id)
    }
}

#[cfg(test)]
#[path = "home_agents/tests.rs"]
mod tests;
