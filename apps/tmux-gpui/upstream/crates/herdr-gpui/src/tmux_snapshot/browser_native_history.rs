//! Only opaque anchor tokens persist across native connection lifetimes.
use super::{Error, browser::Command, browser_direct::NativePresentation};
use herdr_client::tmux_history::{Ticket, decode_result};
use serde::Deserialize;
use std::{cell::RefCell, collections::BTreeMap, rc::Rc};
type Key = (String, String, String, String, String);
pub(super) type Cache = Rc<RefCell<BTreeMap<Key, String>>>;
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(super) struct Response {
    #[serde(rename = "type")]
    kind: String,
    version: u8,
    pub id: String,
    pub request: u64,
    operation_id: u64,
    status: Status,
    body: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum Status {
    Ok,
    Unsupported,
    Failed,
}
impl Response {
    pub fn parse(bytes: &[u8]) -> Result<Self, Error> {
        if bytes.len() > 20 * 1024 {
            return Err(Error::Invalid("native history response too large"));
        }
        let value: Self = serde_json::from_slice(bytes)?;
        if value.kind != "native-history-result"
            || value.version != 1
            || uuid::Uuid::parse_str(&value.id).is_err()
            || value.request > 9_007_199_254_740_991
            || value.operation_id > 9_007_199_254_740_991
            || value.body.as_ref().is_some_and(|s| s.len() > 16 * 1024)
            || matches!(value.status, Status::Ok) != value.body.is_some()
        {
            return Err(Error::Invalid("invalid native history response"));
        }
        Ok(value)
    }
}
pub(super) struct History {
    key: Option<Key>,
    cache: Cache,
    operation: u64,
    pending: Option<(u64, Ticket, u64)>,
    restore: Option<String>,
}
impl History {
    pub fn new(
        scope: Option<(String, String)>,
        workspace: String,
        session: String,
        pane: String,
        cache: Cache,
    ) -> Self {
        let key = scope.map(|(server, generation)| (server, generation, workspace, session, pane));
        let restore = key
            .as_ref()
            .and_then(|key| cache.borrow().get(key).cloned());
        Self {
            key,
            cache,
            operation: 0,
            pending: None,
            restore,
        }
    }
    pub fn save(&self, presentation: &NativePresentation) {
        let Some(key) = &self.key else {
            return;
        };
        if self.restore.is_some() || presentation.history_pane() != Some(key.4.as_str()) {
            return;
        }
        let mut cache = self.cache.borrow_mut();
        if let Some(token) = presentation.history_token() {
            if cache.len() >= 64 && !cache.contains_key(key) {
                cache.pop_first();
            }
            cache.insert(key.clone(), token.into());
        } else {
            cache.remove(key);
        }
    }
    /// Called before replacing the selected pane's viewport.
    pub fn before_pane(&mut self, pane: &str, presentation: &NativePresentation) {
        if self.key.as_ref().is_none_or(|key| key.4 == pane) {
            return;
        }
        self.save(presentation);
        if let Some(key) = self.key.as_mut() {
            key.4 = pane.into();
            self.restore = self.cache.borrow().get(key).cloned();
        }
        self.pending = None;
    }
    pub fn after_pane(&mut self, presentation: &mut NativePresentation, now: u64) -> bool {
        if let Some(token) = self.restore.take() {
            presentation.restore_history(token, now);
            true
        } else {
            false
        }
    }
    /// Navigation drains the latest capture for at most three seconds, without replay.
    pub fn drain(&mut self, presentation: &mut NativePresentation, now: u64) -> bool {
        if self
            .pending
            .as_ref()
            .is_some_and(|(_, _, deadline)| now >= *deadline)
            && let Some((_, ticket, _)) = self.pending.take()
        {
            presentation.fail_history(&ticket);
            self.save(presentation);
        }
        self.pending.is_some()
    }
    pub fn request(
        &mut self,
        presentation: &mut NativePresentation,
        id: &str,
        request: u64,
        session: &str,
        now: u64,
    ) -> Result<Option<Command>, Error> {
        let Some(action) = presentation.take_history_action() else {
            return Ok(None);
        };
        if self.key.is_none() {
            presentation.fail_history(&action.ticket);
            return Ok(None);
        }
        self.operation = self
            .operation
            .checked_add(1)
            .filter(|n| *n <= 9_007_199_254_740_991)
            .ok_or(Error::Invalid("native history operation exhausted"))?;
        let body = action
            .request_body(session)
            .map_err(|_| Error::Invalid("native history request identity"))?;
        let body = String::from_utf8(body)
            .map_err(|_| Error::Invalid("native history request encoding"))?;
        self.pending = Some((self.operation, action.ticket, now.saturating_add(3000)));
        Ok(Some(Command::NativeHistory {
            version: 1,
            id: id.into(),
            request,
            operation_id: self.operation,
            body,
        }))
    }
    pub fn response(
        &mut self,
        presentation: &mut NativePresentation,
        response: Response,
        now: u64,
    ) -> Result<bool, Error> {
        if self
            .pending
            .as_ref()
            .is_none_or(|(operation, _, _)| *operation != response.operation_id)
        {
            return Ok(false);
        }
        let Some((_, ticket, _)) = self.pending.take() else {
            return Ok(false);
        };
        if matches!(response.status, Status::Failed) {
            presentation.fail_history(&ticket);
            return Ok(true);
        }
        let result = match (response.status, response.body, self.key.as_ref()) {
            (Status::Ok, Some(body), Some(key)) => Some(
                decode_result(body.as_bytes(), &key.0, &key.1)
                    .map_err(|_| Error::Invalid("native history scope rejected"))?,
            ),
            _ => None,
        };
        let changed = presentation.complete_history(&ticket, result, now);
        self.save(presentation);
        Ok(changed)
    }
}

#[cfg(test)]
#[path = "browser_native_history_tests.rs"]
mod tests;
