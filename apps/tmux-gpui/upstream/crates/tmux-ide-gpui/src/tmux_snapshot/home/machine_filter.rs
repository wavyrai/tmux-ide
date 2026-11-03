//! The daemon's agent machine filter capability. Home no longer offers the
//! filter (#705): agents show on their sessions' rows, every machine's.
use serde::Deserialize;
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(in crate::tmux_snapshot) struct Capability {
    pub revision: u64,
    pub machine_id: Option<String>,
}
