use super::{Error, Result};
use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Proof {
    pub workspace_name: String,
    pub semantic_pane_id: String,
    pub generation: String,
    pub incarnation: String,
    pub revision: u64,
    pub state_hash: String,
}
impl Proof {
    pub(super) fn valid(&self) -> bool {
        portable(&self.workspace_name)
            && portable(&self.semantic_pane_id)
            && !self.semantic_pane_id.starts_with("terminal.discovered.")
            && uuid(&self.generation)
            && !self.incarnation.is_empty()
            && self.incarnation.len() <= 256
            && self.revision <= 9_007_199_254_740_991
            && self.state_hash.len() == 16
            && self
                .state_hash
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    }
}
#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "status", rename_all = "lowercase", deny_unknown_fields)]
pub enum AnchorResult {
    Captured {
        token: String,
    },
    Resolved {
        proof: Proof,
        #[serde(rename = "historyIndex")]
        history_index: usize,
    },
    Unavailable,
    Stale,
    Lost,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Envelope {
    version: u8,
    server: Server,
    result: AnchorResult,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Server {
    server_id: String,
    generation: String,
}
/// Decode the owner response in Rust. Caller supplies the exact selected server scope.
pub fn decode_result(bytes: &[u8], server_id: &str, generation: &str) -> Result<AnchorResult> {
    if bytes.len() > 16 * 1024 {
        return Err(Error::Invalid("response size"));
    }
    let response: Envelope = serde_json::from_slice(bytes)?;
    if response.version != 1
        || response.server.server_id != server_id
        || response.server.generation != generation
        || !uuid(generation)
        || server_id.len() != 44
        || !server_id.starts_with("tmux-server.")
        || !server_id[12..]
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(Error::Invalid("server scope"));
    }
    match &response.result {
        AnchorResult::Captured { token } if !uuid(token) => return Err(Error::Invalid("token")),
        AnchorResult::Resolved {
            proof,
            history_index,
        } if !proof.valid() || *history_index as u64 > 9_007_199_254_740_991 => {
            return Err(Error::Invalid("proof"));
        }
        _ => {}
    }
    Ok(response.result)
}
pub(super) fn uuid(s: &str) -> bool {
    s.len() == 36
        && s.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_hexdigit()
            }
        })
        && (s == "00000000-0000-0000-0000-000000000000"
            || s.eq_ignore_ascii_case("ffffffff-ffff-ffff-ffff-ffffffffffff")
            || ((b'1'..=b'8').contains(&s.as_bytes()[14]) && b"89aAbB".contains(&s.as_bytes()[19])))
}
fn portable(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 128
        && s.as_bytes()[0].is_ascii_alphanumeric()
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
        && !["__proto__", "prototype", "constructor"].contains(&s)
}
impl super::AnchorAction {
    /// Owner broker forwards these metadata bytes; terminal rows remain in Rust.
    pub fn request_body(&self, live_session_id: &str) -> Result<Vec<u8>> {
        if live_session_id.len() != 33
            || !live_session_id.starts_with("live-session.")
            || !live_session_id[13..]
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            || !self.proof.valid()
        {
            return Err(Error::Invalid("request identity"));
        }
        let mut proof = serde_json::to_value(&self.proof)?;
        let operation = match &self.operation {
            super::AnchorOperation::Capture { history_index } => {
                if *history_index as u64 > 9_007_199_254_740_991 {
                    return Err(Error::Invalid("history index"));
                }
                serde_json::json!({"kind":"capture","historyIndex":history_index})
            }
            super::AnchorOperation::Resolve { token } => {
                if !uuid(token) {
                    return Err(Error::Invalid("token"));
                }
                let object = proof.as_object_mut().ok_or(Error::Invalid("proof"))?;
                object.remove("revision");
                object.remove("stateHash");
                serde_json::json!({"kind":"resolve","token":token})
            }
        };
        Ok(serde_json::to_vec(
            &serde_json::json!({"version":1,"liveSessionId":live_session_id,"proof":proof,"operation":operation}),
        )?)
    }
}
