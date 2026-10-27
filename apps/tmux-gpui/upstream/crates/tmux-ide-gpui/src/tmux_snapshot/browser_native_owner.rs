//! Typed broker HTTP requests, admitted only by the native authority owner.
use super::browser_direct::NativePresentation;
use herdr_client::tmux_controller::{Controller, OwnerEvent, OwnerOutcome, OwnerState};
use serde::{Deserialize, Serialize};
const SAFE: u64 = 9_007_199_254_740_991;
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "action")]
pub(super) enum Action {
    #[serde(rename = "new-window")]
    NewWindow,
    #[serde(rename = "new-agent")]
    NewAgent { name: String, harness: Harness },
}
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(super) enum Harness {
    Claude,
    Codex,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Request {
    pub(super) version: u8,
    pub(super) id: String,
    pub(super) request: u64,
    pub(super) sequence: u64,
    pub(super) operation_id: String,
    pub(super) live_session_id: String,
    pub(super) generation: String,
    pub(super) pane: String,
    #[serde(flatten)]
    pub(super) action: Action,
}
#[derive(Debug, thiserror::Error)]
pub(super) enum Error {
    #[error("native owner action is stale or unavailable")]
    Rejected,
    #[error("invalid native owner scope or response")]
    Invalid,
    #[error("native owner controller failed")]
    Controller(#[from] herdr_client::tmux_controller::Error),
}
pub(super) struct Completion {
    pub reissue: bool,
    pub target_pane: Option<String>,
    pub outcome: OwnerOutcome,
}
pub(super) enum Event {
    Request(Request),
    Completed(Completion),
}
struct Pending {
    action: Action,
    operation: String,
    sequence: u64,
    source: String,
}
pub(super) struct Owner {
    gate: OwnerState,
    id: String,
    request: u64,
    workspace: String,
    session: String,
    generation: String,
    highest: u64,
    pending: Option<Pending>,
}
impl Owner {
    pub fn new(
        id: String,
        request: u64,
        workspace: String,
        session: String,
        generation: String,
    ) -> Result<Self, Error> {
        if uuid::Uuid::parse_str(&id).is_err()
            || uuid::Uuid::parse_str(&generation).is_err()
            || request > SAFE
            || !text(&workspace, 512)
            || !text(&session, 512)
        {
            return Err(Error::Invalid);
        }
        Ok(Self {
            gate: OwnerState::default(),
            id,
            request,
            workspace,
            session,
            generation,
            highest: 0,
            pending: None,
        })
    }
    pub fn update_request(&mut self, request: u64) -> Result<(), Error> {
        if self.busy() || request <= self.request || request > SAFE {
            return Err(Error::Invalid);
        }
        self.request = request;
        Ok(())
    }
    pub fn busy(&self) -> bool {
        self.gate.busy()
    }
    pub fn submit(
        &mut self,
        c: &Controller,
        presentation: &NativePresentation,
        pane: &str,
        token: Option<&str>,
        action: Action,
        now: u64,
    ) -> Result<(), Error> {
        if self.highest >= SAFE || self.pending.is_some() || !valid_action(&action) {
            return Err(Error::Rejected);
        }
        let lifetime = presentation
            .resolve_action(pane, token.ok_or(Error::Rejected)?)
            .ok_or(Error::Rejected)?;
        if lifetime.generation != self.generation {
            return Err(Error::Rejected);
        }
        let operation = uuid::Uuid::new_v4().to_string();
        self.gate
            .submit(c, pane, &lifetime, &operation, now)
            .map_err(|error| match error {
                herdr_client::tmux_controller::Error::Control(
                    herdr_client::tmux_control::Error::Busy
                    | herdr_client::tmux_control::Error::Lifetime,
                ) => Error::Rejected,
                other => Error::Controller(other),
            })?;
        self.highest += 1;
        self.pending = Some(Pending {
            action,
            operation,
            sequence: self.highest,
            source: pane.into(),
        });
        Ok(())
    }
    pub fn poll(&mut self, c: &mut Controller, now: u64) -> Result<Option<Event>, Error> {
        match self.gate.poll(c, now)? {
            None => Ok(None),
            Some(OwnerEvent::Authorized(auth)) => {
                let p = self.pending.as_ref().ok_or(Error::Invalid)?;
                if p.operation != auth.operation_id
                    || p.source != auth.pane
                    || auth.lifetime.generation != self.generation
                {
                    return Err(Error::Invalid);
                }
                Ok(Some(Event::Request(Request {
                    version: 1,
                    id: self.id.clone(),
                    request: self.request,
                    sequence: p.sequence,
                    operation_id: p.operation.clone(),
                    live_session_id: self.session.clone(),
                    generation: self.generation.clone(),
                    pane: p.source.clone(),
                    action: p.action.clone(),
                })))
            }
            Some(OwnerEvent::Completed(done)) => {
                self.pending = None;
                Ok(Some(Event::Completed(Completion {
                    reissue: done.submitted,
                    target_pane: None,
                    outcome: done.outcome,
                })))
            }
        }
    }
    pub(super) fn waiting_receipt(&self) -> bool {
        self.gate.busy() && !self.gate.waiting()
    }
    pub(super) fn poll_interrupted(&mut self, now: u64) -> Option<Completion> {
        let done = self.gate.poll_interrupted(now)?;
        self.pending = None;
        Some(Completion {
            reissue: done.submitted,
            target_pane: None,
            outcome: done.outcome,
        })
    }
    pub fn cancel_waiting(&mut self) {
        if self.gate.cancel_waiting().is_some() {
            self.pending = None;
        }
    }
    /// Only a bounded exact correlated response can settle the submitted HTTP operation.
    pub fn response(&mut self, bytes: &[u8]) -> Result<Option<Completion>, Error> {
        if bytes.len() > 16384 {
            return Err(Error::Invalid);
        }
        let response: Response = serde_json::from_slice(bytes).map_err(|_| Error::Invalid)?;
        self.response_native(response)
    }
    pub(super) fn response_native(
        &mut self,
        response: Response,
    ) -> Result<Option<Completion>, Error> {
        if response.kind != "native-owner-action-result"
            || response.version != 1
            || response.id != self.id
            || response.request != self.request
        {
            return Err(Error::Invalid);
        }
        let Some(p) = self.pending.as_ref() else {
            return Ok(None);
        };
        if response.sequence != p.sequence || response.operation_id != p.operation {
            return Ok(None);
        }
        let target = validate_result(&response, p, &self.generation, &self.workspace)?;
        let Some(done) = self.gate.complete(&p.operation, target.is_some()) else {
            return Ok(None);
        };
        self.pending = None;
        Ok(Some(Completion {
            reissue: done.submitted,
            target_pane: target,
            outcome: done.outcome,
        }))
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Response {
    #[serde(rename = "type")]
    kind: String,
    version: u8,
    pub(super) id: String,
    pub(super) request: u64,
    sequence: u64,
    operation_id: String,
    status: String,
    #[serde(default, deserialize_with = "receipt_present")]
    receipt: Option<Receipt>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Receipt {
    operation_id: String,
    daemon_instance_id: String,
    outcome: String,
    resource: Resource,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Resource {
    resource_version: u8,
    workspace_name: String,
    semantic_pane_id: String,
    display_title: String,
    kind: String,
    harness_profile_id: serde_json::Value,
    role: serde_json::Value,
    mission_id: serde_json::Value,
}
fn validate_result(
    response: &Response,
    pending: &Pending,
    generation: &str,
    workspace: &str,
) -> Result<Option<String>, Error> {
    if matches!(response.status.as_str(), "failed" | "busy") && response.receipt.is_none() {
        return Ok(None);
    }
    let receipt = response.receipt.as_ref().ok_or(Error::Invalid)?;
    let resource = &receipt.resource;
    if response.status != "created"
        || receipt.operation_id != pending.operation
        || receipt.daemon_instance_id != generation
        || receipt.outcome != "created"
        || resource.resource_version != 1
        || resource.workspace_name != workspace
        || !reference(&resource.semantic_pane_id)
        || resource.semantic_pane_id == pending.source
        || !text(&resource.display_title, 80)
    {
        return Err(Error::Invalid);
    }
    let matches = match &pending.action {
        Action::NewWindow => {
            resource.kind == "terminal"
                && resource.harness_profile_id.is_null()
                && resource.role.is_null()
                && resource.mission_id.is_null()
        }
        Action::NewAgent { name, harness } => {
            resource.kind == "agent"
                && resource.display_title == *name
                && resource.harness_profile_id.as_str()
                    == Some(match harness {
                        Harness::Claude => "claude",
                        Harness::Codex => "codex",
                    })
                && resource.role.as_str() == Some("implementer")
                && resource.mission_id.is_null()
        }
    };
    if !matches {
        return Err(Error::Invalid);
    }
    Ok(Some(resource.semantic_pane_id.clone()))
}
fn text(value: &str, max: usize) -> bool {
    !value.is_empty()
        && value.encode_utf16().count() <= max
        && value.trim() == value
        && !value.chars().any(char::is_control)
}
fn reference(value: &str) -> bool {
    text(value, 160) && !value.contains(['/', '\\']) && !value.starts_with(['%', '$', '@'])
}
fn valid_action(action: &Action) -> bool {
    match action {
        Action::NewWindow => true,
        Action::NewAgent { name, .. } => text(name, 80),
    }
}
#[cfg(test)]
#[path = "browser_native_owner_tests.rs"]
mod tests;

fn receipt_present<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Receipt>, D::Error> {
    Receipt::deserialize(deserializer).map(Some)
}

impl Response {
    pub(super) fn native(
        request: &Request,
        receipt: Option<herdr_client::tmux_daemon::CreatedPane>,
        busy: bool,
    ) -> Self {
        let receipt = receipt.map(|r| Receipt {
            operation_id: r.operation_id,
            daemon_instance_id: r.daemon_instance_id,
            outcome: match r.outcome {
                herdr_client::tmux_daemon::PaneCreateOutcome::Created => "created",
                herdr_client::tmux_daemon::PaneCreateOutcome::Replayed => "replayed",
            }
            .into(),
            resource: Resource {
                resource_version: r.resource.resource_version,
                workspace_name: r.resource.workspace_name,
                semantic_pane_id: r.resource.semantic_pane_id,
                display_title: r.resource.display_title,
                kind: match r.resource.kind {
                    herdr_client::tmux_daemon::PaneKind::Terminal => "terminal",
                    herdr_client::tmux_daemon::PaneKind::Agent => "agent",
                }
                .into(),
                harness_profile_id: r
                    .resource
                    .harness_profile_id
                    .map_or(serde_json::Value::Null, Into::into),
                role: r.resource.role.map_or(serde_json::Value::Null, Into::into),
                mission_id: r
                    .resource
                    .mission_id
                    .map_or(serde_json::Value::Null, Into::into),
            },
        });
        Self {
            kind: "native-owner-action-result".into(),
            version: 1,
            id: request.id.clone(),
            request: request.request,
            sequence: request.sequence,
            operation_id: request.operation_id.clone(),
            status: if receipt.is_some() {
                "created"
            } else if busy {
                "busy"
            } else {
                "failed"
            }
            .into(),
            receipt,
        }
    }
}
