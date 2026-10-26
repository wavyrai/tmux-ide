use super::{Error, ServerClient};
use serde::Deserialize;
use uuid::Uuid;

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CreateOutcome {
    Created,
    Adopted,
    Replayed,
}
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreatedSession {
    pub operation_id: String,
    pub daemon_instance_id: String,
    pub outcome: CreateOutcome,
    #[serde(default, deserialize_with = "super::optional_string")]
    pub live_session_id: Option<String>,
    pub fleet_session_id: String,
    pub workspace_name: String,
    pub display_name: String,
}
impl ServerClient {
    /// Send once with a caller-retained operation ID. An uncertain outcome must
    /// be reconciled; do not create a fresh ID or automatically replay the action.
    pub fn create_session(
        &self,
        operation_id: Uuid,
        display_name: &str,
    ) -> Result<CreatedSession, Error> {
        self.assert_current()?;
        let display_name = display_name.trim();
        if !valid_display(display_name) {
            return Err(Error::ActionInput);
        }
        let scope = self.scope();
        let body=serde_json::json!({"operationId":operation_id.to_string(),"expectedDaemonInstanceId":scope.generation,
            "intent":{"displayName":display_name,"includeLiveSessionId":true,"expectedDaemonInstanceId":scope.generation}}).to_string();
        let path = format!(
            "api/v1/tmux-servers/{}/{}/sessions/create",
            scope.server_id, scope.generation
        );
        let result = self
            .daemon
            .post_resource(&path, body.as_bytes())
            .and_then(|bytes| {
                self.assert_current()?;
                let parsed = parse(&bytes, operation_id, &scope.generation);
                self.assert_current()?;
                parsed
            });
        result.map_err(|source| Error::ActionUncertain {
            operation_id,
            source: Box::new(source),
        })
    }
}
pub(super) fn valid_display(value: &str) -> bool {
    !value.is_empty()
        && value.encode_utf16().count() <= 100
        && !value.starts_with('-')
        && value
            .chars()
            .all(|c| c > '\u{1f}' && !('\u{7f}'..='\u{9f}').contains(&c))
}
pub(super) fn parse(
    bytes: &[u8],
    operation_id: Uuid,
    generation: &str,
) -> Result<CreatedSession, Error> {
    let mut result: CreatedSession =
        serde_json::from_slice(bytes).map_err(|_| Error::ResourceFormat)?;
    if result.operation_id != operation_id.to_string() || result.daemon_instance_id != generation {
        return Err(Error::ServerChanged);
    }
    let Some(fleet) = result.fleet_session_id.strip_prefix("session.") else {
        return Err(Error::ResourceFormat);
    };
    if !(16..=64).contains(&fleet.len())
        || !fleet
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err(Error::ResourceFormat);
    }
    result.workspace_name = result.workspace_name.trim().to_owned();
    result.display_name = result.display_name.trim().to_owned();
    if result.workspace_name.is_empty()
        || result.workspace_name.encode_utf16().count() > 160
        || result
            .workspace_name
            .chars()
            .any(|c| c < ' ' || c == '\u{7f}')
        || !valid_display(&result.display_name)
        || result.live_session_id.as_ref().is_some_and(|id| {
            id.strip_prefix("live-session.").is_none_or(|s| {
                s.len() != 20
                    || !s
                        .bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            })
        })
    {
        return Err(Error::ResourceFormat);
    }
    Ok(result)
}
#[cfg(test)]
#[path = "create_session_tests.rs"]
mod tests;
