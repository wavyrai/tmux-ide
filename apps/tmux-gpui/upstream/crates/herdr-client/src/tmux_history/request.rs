use super::{AnchorOperation, AnchorResult, Error, Proof, Result, wire::uuid};
use serde::{Deserialize, Serialize};
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Identity {
    workspace_name: String,
    semantic_pane_id: String,
    generation: String,
    incarnation: String,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(untagged)]
enum RequestProof {
    Capture(Proof),
    Resolve(Identity),
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WireRequest {
    version: u8,
    live_session_id: String,
    proof: RequestProof,
    operation: AnchorOperation,
}
/// Validated owner metadata. Private fields prevent callers changing its scope
/// after validation. Deliberately has no Debug implementation for opaque tokens.
#[derive(Clone)]
pub struct AnchorRequest(WireRequest);
impl AnchorRequest {
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        if bytes.len() > 16 * 1024 {
            return Err(Error::Invalid("request size"));
        }
        let value: WireRequest = serde_json::from_slice(bytes)?;
        let live = value.live_session_id.strip_prefix("live-session.");
        if value.version != 1
            || live.is_none_or(|s| {
                s.len() != 20
                    || !s
                        .bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            })
        {
            return Err(Error::Invalid("request identity"));
        }
        let valid = match (&value.proof, &value.operation) {
            (RequestProof::Capture(proof), AnchorOperation::Capture { history_index }) => {
                proof.valid() && *history_index as u64 <= 9_007_199_254_740_991
            }
            (RequestProof::Resolve(id), AnchorOperation::Resolve { token }) => {
                uuid(token)
                    && Proof {
                        workspace_name: id.workspace_name.clone(),
                        semantic_pane_id: id.semantic_pane_id.clone(),
                        generation: id.generation.clone(),
                        incarnation: id.incarnation.clone(),
                        revision: 0,
                        state_hash: "0000000000000000".into(),
                    }
                    .valid()
            }
            _ => false,
        };
        if !valid {
            return Err(Error::Invalid("request proof"));
        }
        Ok(Self(value))
    }
    pub fn body(&self) -> Result<Vec<u8>> {
        Ok(serde_json::to_vec(&self.0)?)
    }
    pub fn live_session_id(&self) -> &str {
        &self.0.live_session_id
    }
    pub fn identity(&self) -> (&str, &str, &str, &str) {
        match &self.0.proof {
            RequestProof::Capture(p) => (
                &p.workspace_name,
                &p.semantic_pane_id,
                &p.generation,
                &p.incarnation,
            ),
            RequestProof::Resolve(p) => (
                &p.workspace_name,
                &p.semantic_pane_id,
                &p.generation,
                &p.incarnation,
            ),
        }
    }
    pub fn check_result(&self, result: &AnchorResult) -> Result<()> {
        match (&self.0.operation, result) {
            (AnchorOperation::Capture { .. }, AnchorResult::Resolved { .. })
            | (AnchorOperation::Resolve { .. }, AnchorResult::Captured { .. }) => {
                return Err(Error::Invalid("response operation"));
            }
            (_, AnchorResult::Resolved { proof, .. })
                if self.identity()
                    != (
                        proof.workspace_name.as_str(),
                        proof.semantic_pane_id.as_str(),
                        proof.generation.as_str(),
                        proof.incarnation.as_str(),
                    ) =>
            {
                return Err(Error::Invalid("response proof"));
            }
            _ => {}
        }
        Ok(())
    }
}
#[cfg(test)]
#[path = "request_tests.rs"]
mod tests;
