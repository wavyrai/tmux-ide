//! One-shot semantic pane creation. The caller retains operation identity and
//! controller authority; this owner endpoint never acquires or invents a lease.
use super::{Error, ServerClient};
use serde::{Deserialize, Serialize};
use uuid::Uuid;
#[derive(Clone)]
pub enum NewPane {
    Terminal,
    Agent { name: String, harness: AgentHarness },
}
#[derive(Clone, Copy)]
pub enum AgentHarness {
    Claude,
    Codex,
}
impl AgentHarness {
    fn name(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
        }
    }
}
#[derive(Clone)]
pub struct PaneCreation {
    pub workspace_name: String,
    pub live_session_id: String,
    pub source_pane: String,
    pub kind: NewPane,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreatedPane {
    pub operation_id: String,
    pub daemon_instance_id: String,
    pub outcome: PaneCreateOutcome,
    pub resource: CreatedPaneResource,
}
#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PaneCreateOutcome {
    Created,
    Replayed,
}
#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PaneKind {
    Terminal,
    Agent,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreatedPaneResource {
    pub resource_version: u8,
    pub workspace_name: String,
    pub semantic_pane_id: String,
    pub display_title: String,
    pub kind: PaneKind,
    #[serde(deserialize_with = "nullable_string")]
    pub harness_profile_id: Option<String>,
    #[serde(deserialize_with = "nullable_string")]
    pub role: Option<String>,
    #[serde(deserialize_with = "nullable_string")]
    pub mission_id: Option<String>,
}
fn nullable_string<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    Option::<String>::deserialize(d)
}
impl ServerClient {
    pub fn create_pane(
        &self,
        operation_id: Uuid,
        creation: &PaneCreation,
    ) -> Result<CreatedPane, Error> {
        self.assert_current()?;
        let scope = self.scope();
        let body = body(operation_id, &scope.generation, creation)?;
        let path = format!(
            "api/v1/tmux-servers/{}/{}/panes/create?liveSessionId={}",
            scope.server_id, scope.generation, creation.live_session_id
        );
        let result = self
            .daemon
            .post_resource_with_options(&path, &body, &[], std::time::Duration::from_secs(5))
            .and_then(|bytes| {
                self.assert_current()?;
                let receipt = parse(&bytes, operation_id, &scope.generation, creation)?;
                self.assert_current()?;
                Ok(receipt)
            });
        result.map_err(|source| Error::ActionUncertain {
            operation_id,
            source: Box::new(source),
        })
    }
}
fn body(operation_id: Uuid, generation: &str, c: &PaneCreation) -> Result<Vec<u8>, Error> {
    if !workspace(&c.workspace_name)
        || !reference(&c.source_pane)
        || !c
            .live_session_id
            .strip_prefix("live-session.")
            .is_some_and(|v| {
                v.len() == 20
                    && v.bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            })
    {
        return Err(Error::ActionInput);
    }
    let mut intent = serde_json::json!({"workspaceName":c.workspace_name,"kind":"terminal","placement":{"kind":"window"}});
    if let NewPane::Agent { name, harness } = &c.kind {
        if !text(name, 80) {
            return Err(Error::ActionInput);
        }
        intent["kind"] = "agent".into();
        intent["displayTitle"] = name.clone().into();
        intent["harnessProfileId"] = harness.name().into();
        intent["role"] = "implementer".into();
    }
    serde_json::to_vec(&serde_json::json!({"operationId":operation_id.to_string(),"expectedDaemonInstanceId":generation,"intent":intent})).map_err(|_| Error::ActionInput)
}
fn parse(
    bytes: &[u8],
    operation_id: Uuid,
    generation: &str,
    c: &PaneCreation,
) -> Result<CreatedPane, Error> {
    if bytes.len() > 32 * 1024 {
        return Err(Error::ResourceFormat);
    }
    let receipt: CreatedPane = serde_json::from_slice(bytes).map_err(|_| Error::ResourceFormat)?;
    let r = &receipt.resource;
    if receipt.operation_id != operation_id.to_string()
        || receipt.daemon_instance_id != generation
        || r.workspace_name != c.workspace_name
    {
        return Err(Error::ServerChanged);
    }
    if r.resource_version != 1
        || !reference(&r.semantic_pane_id)
        || r.semantic_pane_id == c.source_pane
        || !text(&r.display_title, 80)
        || r.mission_id.is_some()
    {
        return Err(Error::ResourceFormat);
    }
    let matched = match &c.kind {
        NewPane::Terminal => {
            r.kind == PaneKind::Terminal && r.harness_profile_id.is_none() && r.role.is_none()
        }
        NewPane::Agent { name, harness } => {
            r.kind == PaneKind::Agent
                && r.display_title == *name
                && r.harness_profile_id.as_deref() == Some(harness.name())
                && r.role.as_deref() == Some("implementer")
        }
    };
    if !matched {
        return Err(Error::ResourceFormat);
    }
    Ok(receipt)
}
fn canonical(value: &str) -> bool {
    value.trim_matches(|c| matches!(c, '\u{0009}'..='\u{000D}' | '\u{0020}' | '\u{00A0}' | '\u{1680}' | '\u{2000}'..='\u{200A}' | '\u{2028}' | '\u{2029}' | '\u{202F}' | '\u{205F}' | '\u{3000}' | '\u{FEFF}')) == value
}
fn text(value: &str, max: usize) -> bool {
    !value.is_empty()
        && value.encode_utf16().count() <= max
        && canonical(value)
        && !value
            .chars()
            .any(|c| c <= '\u{1f}' || ('\u{7f}'..='\u{9f}').contains(&c))
}
fn workspace(value: &str) -> bool {
    !value.is_empty()
        && value.encode_utf16().count() <= 160
        && canonical(value)
        && !value.chars().any(|c| c < ' ' || c == '\u{7f}')
}
fn reference(value: &str) -> bool {
    text(value, 160) && !value.contains(['/', '\\']) && !value.starts_with(['%', '$', '@'])
}
#[cfg(test)]
#[path = "create_pane_tests.rs"]
mod tests;
