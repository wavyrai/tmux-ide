//! One-use local editor reads. No geometry authority, terminal input, or cwd crosses this pipe.
use super::browser_direct::NativePresentation;
use herdr_client::{
    tmux_control::{Authority, Lifetime},
    tmux_controller::Controller,
};
use serde::{Deserialize, Serialize};
const SAFE: u64 = 9_007_199_254_740_991;
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Request {
    pub(super) version: u8,
    pub(super) id: String,
    pub(super) request: u64,
    pub(super) sequence: u64,
    pub(super) operation_id: String,
    pub(super) presence_revision: u64,
    pub(super) pane: String,
    pub(super) generation: String,
    pub(super) incarnation: String,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Cancel {
    pub(super) version: u8,
    pub(super) id: String,
    pub(super) request: u64,
    pub(super) operation_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Response {
    #[serde(rename = "type")]
    kind: String,
    version: u8,
    pub id: String,
    pub request: u64,
    operation_id: String,
    sequence: u64,
    status: Status,
}
#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum Status {
    Opened,
    Unavailable,
    Stale,
    Failed,
    Busy,
}
impl Response {
    pub(super) fn native(request: &Request, status: Status) -> Self {
        Self {
            kind: "native-editor-result".into(),
            version: 1,
            id: request.id.clone(),
            request: request.request,
            operation_id: request.operation_id.clone(),
            sequence: request.sequence,
            status,
        }
    }

    pub fn parse(bytes: &[u8]) -> Option<Self> {
        if bytes.len() > 2048 {
            return None;
        }
        let value: Self = serde_json::from_slice(bytes).ok()?;
        (value.kind == "native-editor-result"
            && value.version == 1
            && uuid::Uuid::parse_str(&value.id).is_ok()
            && uuid::Uuid::parse_str(&value.operation_id).is_ok()
            && value.request <= SAFE
            && value.sequence > 0
            && value.sequence <= SAFE)
            .then_some(value)
    }
}
struct Pending {
    request: Request,
    token: String,
    lifetime: Lifetime,
    deadline: u64,
}
#[derive(Default)]
pub(super) struct Editor {
    highest: u64,
    pending: Option<Pending>,
}
pub(super) struct ReadContext<'a> {
    pub id: &'a str,
    pub request: u64,
    pub pane: &'a str,
    pub token: &'a str,
    pub presence: u64,
}
impl Editor {
    pub fn submit(
        &mut self,
        c: &Controller,
        p: &NativePresentation,
        context: ReadContext<'_>,
        now: u64,
    ) -> Option<Request> {
        let lifetime = p.resolve_action(context.pane, context.token)?;
        if c.selected() != context.pane
            || !c.owns(Authority::Input)
            || c.selectable(context.pane).as_ref() != Some(&lifetime)
        {
            return None;
        }
        self.begin(context, lifetime, now)
    }
    fn begin(&mut self, context: ReadContext<'_>, lifetime: Lifetime, now: u64) -> Option<Request> {
        let ReadContext {
            id,
            request,
            pane,
            token,
            presence,
        } = context;
        if self.pending.is_some()
            || request > SAFE
            || presence > SAFE
            || self.highest >= SAFE
            || uuid::Uuid::parse_str(id).is_err()
        {
            return None;
        }
        self.highest += 1;
        let command = Request {
            version: 1,
            id: id.into(),
            request,
            sequence: self.highest,
            operation_id: uuid::Uuid::new_v4().to_string(),
            presence_revision: presence,
            pane: pane.into(),
            generation: lifetime.generation.clone(),
            incarnation: lifetime.incarnation.clone(),
        };
        self.pending = Some(Pending {
            request: command.clone(),
            token: token.into(),
            lifetime,
            deadline: now.saturating_add(8000),
        });
        Some(command)
    }
    pub fn poll(
        &mut self,
        c: &Controller,
        p: &NativePresentation,
        request: u64,
        presence: u64,
        now: u64,
    ) -> Option<Cancel> {
        let current = self.pending.as_ref().is_none_or(|pending| {
            pending.request.request == request
                && pending.request.presence_revision == presence
                && c.selected() == pending.request.pane
                && c.owns(Authority::Input)
                && p.resolve_action(&pending.request.pane, &pending.token)
                    .as_ref()
                    == Some(&pending.lifetime)
                && c.selectable(&pending.request.pane).as_ref() == Some(&pending.lifetime)
        });
        self.cancel_if(current, now)
    }
    fn cancel_if(&mut self, current: bool, now: u64) -> Option<Cancel> {
        if self
            .pending
            .as_ref()
            .is_some_and(|pending| !current || now >= pending.deadline)
        {
            self.cancel()
        } else {
            None
        }
    }
    pub fn cancel(&mut self) -> Option<Cancel> {
        let pending = self.pending.take()?;
        Some(Cancel {
            version: 1,
            id: pending.request.id,
            request: pending.request.request,
            operation_id: pending.request.operation_id,
        })
    }
    pub fn response(&mut self, response: Response) -> Option<&'static str> {
        let pending = self.pending.as_ref()?;
        if response.id != pending.request.id
            || response.request != pending.request.request
            || response.sequence != pending.request.sequence
            || response.operation_id != pending.request.operation_id
        {
            return None;
        }
        self.pending = None;
        Some(match response.status {
            Status::Opened => "Folder open request sent to VS Code",
            Status::Unavailable => "Open folder requires verified local daemon discovery",
            Status::Stale => "Editor selection changed — select the pane and try again",
            Status::Failed => {
                "Could not open folder in VS Code — check VS Code is installed, then reselect the pane and retry"
            }
            Status::Busy => "Editor request already pending",
        })
    }
}

/// Display-only server versions, scoped independently from terminal cell delivery.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Diagnostics {
    pub id: String,
    pub request: u64,
    pub pane: String,
    generation: String,
    presence_revision: u64,
    versions: super::diagnostics::Versions,
}
impl Diagnostics {
    pub fn valid(&self) -> bool {
        uuid::Uuid::parse_str(&self.id).is_ok()
            && uuid::Uuid::parse_str(&self.generation).is_ok()
            && self.request <= SAFE
            && self.presence_revision <= SAFE
            && !self.pane.is_empty()
            && self.pane.len() <= 128
            && !self.pane.chars().any(char::is_control)
    }
    pub fn versions(
        &self,
        id: &str,
        request: u64,
        pane: &str,
        generation: &str,
        presence: u64,
    ) -> Option<super::diagnostics::Versions> {
        (self.id == id
            && self.request == request
            && self.pane == pane
            && self.generation == generation
            && self.presence_revision == presence)
            .then(|| self.versions.clone())
    }
}

#[cfg(test)]
#[path = "browser_native_editor_tests.rs"]
mod tests;
