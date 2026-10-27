//! Bounded local-registry publication; connection and mutation authority stays in the bridge.
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(in crate::tmux_snapshot) struct Registry {
    pub(in crate::tmux_snapshot) revision: u64,
    pub(in crate::tmux_snapshot) available: bool,
    pub(in crate::tmux_snapshot) pending: bool,
    pub(in crate::tmux_snapshot) error: Option<String>,
    pub(in crate::tmux_snapshot) message: Option<String>,
    pub(in crate::tmux_snapshot) machines: Vec<Profile>,
}
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(in crate::tmux_snapshot) struct Profile {
    pub(in crate::tmux_snapshot) id: String,
    pub(in crate::tmux_snapshot) label: String,
    pub(in crate::tmux_snapshot) ssh_target: String,
    pub(in crate::tmux_snapshot) expected_environment_id: Option<String>,
    pub(in crate::tmux_snapshot) enabled: bool,
}
fn uuid(value: &str) -> bool {
    value.len() == 36 && uuid::Uuid::parse_str(value).is_ok()
}
fn text(value: &str, maximum: usize) -> bool {
    !value.is_empty() && value.chars().count() <= maximum && !value.chars().any(char::is_control)
}
impl Registry {
    pub(super) fn valid(&self) -> bool {
        let mut ids = HashSet::new();
        // available/pending describe independent read and mutation state. In particular,
        // a filesystem failure can make the registry unavailable while a write is pending.
        self.revision <= 9_007_199_254_740_991
            && self.machines.len() <= 64
            && [&self.error, &self.message]
                .into_iter()
                .all(|value| value.as_ref().is_none_or(|value| text(value, 256)))
            && self.machines.iter().all(|profile| {
                uuid(&profile.id)
                    && ids.insert(profile.id.to_lowercase())
                    && text(&profile.label, 80)
                    && text(&profile.ssh_target, 255)
                    && profile
                        .expected_environment_id
                        .as_ref()
                        .is_none_or(|value| uuid(value))
            })
    }
}

#[derive(Serialize)]
#[serde(tag = "operation", rename_all = "lowercase")]
pub(in crate::tmux_snapshot) enum Operation {
    Read,
    Mutate { revision: u64, change: Change },
}

#[derive(Serialize)]
#[serde(tag = "operation", rename_all = "lowercase")]
pub(in crate::tmux_snapshot) enum Change {
    Edit { id: String, patch: EditPatch },
    Remove { id: String },
    Enable { id: String },
    Disable { id: String },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::tmux_snapshot) struct EditPatch {
    pub label: String,
    pub ssh_target: String,
}
