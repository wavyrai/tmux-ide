//! Bounded semantic catalog invalidations. Notifications never carry catalog
//! authority: every accepted invalidation requires a fresh scoped catalog read.
use serde::Deserialize;
const MAX_SEQUENCE: u64 = 9_007_199_254_740_991;
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CatalogEventIdentity {
    pub protocol_version: u32,
    pub product_version: String,
    pub instance_id: String,
    pub started_at: String,
    #[serde(default, deserialize_with = "super::optional_string")]
    pub environment_id: Option<String>,
}
#[derive(Debug, thiserror::Error)]
pub enum CatalogEventError {
    #[error("invalid catalog event frame")]
    Frame,
    #[error("catalog notification owner changed")]
    Identity,
    #[error("catalog notification subscription unavailable")]
    Unavailable,
    #[error("catalog notification lane is retired")]
    Retired,
}
#[derive(Debug, PartialEq, Eq)]
pub enum CatalogEventEffect {
    Subscribe {
        after_sequence: u64,
    },
    /// The initial barrier also invalidates to close the read/subscribe race.
    Invalidate,
    Unchanged,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Interest {
    resource: String,
    workspace_name: serde_json::Value,
}
#[derive(Deserialize)]
#[serde(tag = "type", deny_unknown_fields, rename_all_fields = "camelCase")]
enum Frame {
    #[serde(rename = "hello")]
    Hello {
        daemon: CatalogEventIdentity,
        sessions: Vec<serde_json::Value>,
        #[serde(default)]
        event_sequence: u64,
    },
    #[serde(rename = "resource.changed")]
    Changed {
        sequence: u64,
        workspace_name: serde_json::Value,
        resource: String,
        revision: u64,
        cause_operation_id: serde_json::Value,
    },
    #[serde(rename = "resource.observed")]
    Observed { sequence: u64 },
    #[serde(rename = "resource.interests-ack")]
    Ack {
        interest_revision: u64,
        sequence: u64,
        unavailable_interests: Vec<Interest>,
    },
    #[serde(rename = "snapshot-required")]
    Snapshot {
        after_sequence: u64,
        #[serde(deserialize_with = "required_nullable_sequence")]
        oldest_available_sequence: Option<u64>,
        current_sequence: u64,
        reason: String,
    },
    #[serde(rename = "pong")]
    Pong,
}
fn required_nullable_sequence<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<u64>, D::Error> {
    Option::<u64>::deserialize(deserializer)
}
#[derive(PartialEq, Eq)]
enum Phase {
    Hello,
    Barrier,
    Live,
    Retired,
}
pub struct CatalogEvents {
    expected: CatalogEventIdentity,
    phase: Phase,
    sequence: u64,
}
impl CatalogEvents {
    /// Expected identity must come from the authenticated discovery owner, never
    /// from this socket's hello or a display/cache record.
    pub fn new(expected: CatalogEventIdentity) -> Self {
        Self {
            expected,
            phase: Phase::Hello,
            sequence: 0,
        }
    }
    pub fn subscription(after_sequence: u64) -> Result<String, CatalogEventError> {
        if after_sequence > MAX_SEQUENCE {
            return Err(CatalogEventError::Frame);
        }
        Ok(
            serde_json::json!({"type":"subscribe", "sessions":[], "interests":[
            {"resource":"workspace-catalog","workspaceName":null}
        ], "legacyEvents":false,"interestRevision":1,"afterSequence":after_sequence})
            .to_string(),
        )
    }
    pub fn ready(&self) -> bool {
        self.phase == Phase::Live
    }
    pub fn receive(&mut self, bytes: &[u8]) -> Result<CatalogEventEffect, CatalogEventError> {
        if self.phase == Phase::Retired {
            return Err(CatalogEventError::Retired);
        }
        let result = self.apply(bytes);
        if result.is_err() {
            self.phase = Phase::Retired;
        }
        result
    }
    fn apply(&mut self, bytes: &[u8]) -> Result<CatalogEventEffect, CatalogEventError> {
        use CatalogEventEffect::{Invalidate, Unchanged};
        if bytes.len() > 64 * 1024 {
            return Err(CatalogEventError::Frame);
        }
        let frame: Frame = serde_json::from_slice(bytes).map_err(|_| CatalogEventError::Frame)?;
        if self.phase == Phase::Hello {
            let Frame::Hello {
                daemon,
                sessions,
                event_sequence,
            } = frame
            else {
                return Err(CatalogEventError::Frame);
            };
            if daemon != self.expected {
                return Err(CatalogEventError::Identity);
            }
            if sessions.len() > 4096 || event_sequence > MAX_SEQUENCE {
                return Err(CatalogEventError::Frame);
            }
            self.sequence = event_sequence;
            self.phase = Phase::Barrier;
            return Ok(CatalogEventEffect::Subscribe {
                after_sequence: event_sequence,
            });
        }
        match frame {
            Frame::Hello { .. } => Err(CatalogEventError::Frame),
            Frame::Pong => Ok(Unchanged),
            Frame::Observed { sequence } => {
                let (_, gap) = self.advance(sequence, false)?;
                Ok(if gap { Invalidate } else { Unchanged })
            }
            Frame::Changed {
                sequence,
                workspace_name,
                resource,
                revision,
                cause_operation_id,
            } => {
                let catalog = matches!(resource.as_str(), "workspace-catalog" | "fleet-catalog");
                let valid_resource = catalog
                    || matches!(
                        resource.as_str(),
                        "application-shell"
                            | "terminal-runtime-inventory"
                            | "workspace-files"
                            | "workspace-changes"
                            | "workspace-missions"
                    );
                if !valid_resource
                    || revision > MAX_SEQUENCE
                    || !(workspace_name.is_null()
                        || workspace_name
                            .as_str()
                            .is_some_and(|v| !v.is_empty() && v.len() <= 1024))
                    || !(cause_operation_id.is_null()
                        || cause_operation_id
                            .as_str()
                            .is_some_and(|v| uuid::Uuid::parse_str(v).is_ok()))
                {
                    return Err(CatalogEventError::Frame);
                }
                let (fresh, gap) = self.advance(sequence, false)?;
                Ok(if gap || (fresh && catalog && workspace_name.is_null()) {
                    Invalidate
                } else {
                    Unchanged
                })
            }
            Frame::Ack {
                interest_revision,
                sequence,
                unavailable_interests,
            } => {
                if self.phase != Phase::Barrier
                    || interest_revision != 1
                    || unavailable_interests.len() > 128
                {
                    return Err(CatalogEventError::Frame);
                }
                for interest in &unavailable_interests {
                    if !matches!(
                        interest.resource.as_str(),
                        "workspace-catalog" | "fleet-catalog"
                    ) || !interest.workspace_name.is_null()
                    {
                        return Err(CatalogEventError::Frame);
                    }
                }
                if !unavailable_interests.is_empty() {
                    return Err(CatalogEventError::Unavailable);
                }
                self.advance(sequence, true)?;
                self.phase = Phase::Live;
                Ok(Invalidate)
            }
            Frame::Snapshot {
                after_sequence,
                oldest_available_sequence,
                current_sequence,
                reason,
            } => {
                if after_sequence > MAX_SEQUENCE
                    || current_sequence > MAX_SEQUENCE
                    || oldest_available_sequence.is_some_and(|s| s == 0 || s > MAX_SEQUENCE)
                    || !matches!(reason.as_str(), "cursor-ahead" | "journal-gap")
                {
                    return Err(CatalogEventError::Frame);
                }
                self.sequence = current_sequence;
                Ok(Invalidate)
            }
        }
    }
    fn advance(&mut self, next: u64, allow_zero: bool) -> Result<(bool, bool), CatalogEventError> {
        if next > MAX_SEQUENCE || (!allow_zero && next == 0) {
            return Err(CatalogEventError::Frame);
        }
        if next <= self.sequence {
            return Ok((false, false));
        }
        let gap = next != self.sequence + 1;
        self.sequence = next;
        Ok((true, gap))
    }
}
#[cfg(test)]
#[path = "catalog_events_tests.rs"]
mod tests;
