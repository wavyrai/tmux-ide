//! Local fleet preferences and cached display data. Cached sessions are not live
//! selection authority; callers must resolve fresh server generations before use.
use super::{Error, LocalDaemon, machines::Identity};
use crate::tmux_handoff::ServerScope;
use serde::{Deserialize, Serialize};
use std::{
    sync::{
        LazyLock,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
const RESPONSE_LIMIT: u64 = 64 * 1024 * 1024;
const SAFE_INTEGER: u64 = 9_007_199_254_740_991;
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct FleetClientState {
    pub version: u8,
    pub favorites: Vec<String>,
    pub collapsed: Vec<String>,
    pub recent: Vec<String>,
    pub catalog: Vec<FleetCachedRoute>,
}
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct FleetCachedRoute {
    pub route_id: String,
    #[serde(deserialize_with = "nullable_string")]
    pub environment_id: Option<String>,
    #[serde(deserialize_with = "nullable_string")]
    pub generation: Option<String>,
    pub seen_at: u64,
    pub sessions: Vec<FleetCachedSession>,
}
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct FleetCachedSession {
    pub id: String,
    #[serde(
        default,
        deserialize_with = "super::optional_string",
        skip_serializing_if = "Option::is_none"
    )]
    pub live_session_id: Option<String>,
    #[serde(
        default,
        deserialize_with = "optional_scope",
        skip_serializing_if = "Option::is_none"
    )]
    pub server: Option<ServerScope>,
    #[serde(
        default,
        deserialize_with = "super::optional_string",
        skip_serializing_if = "Option::is_none"
    )]
    pub server_label: Option<String>,
    pub name: String,
    pub pane_count: u16,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "kebab-case", deny_unknown_fields)]
pub enum FleetPreferenceChange {
    Cache {
        route: FleetCachedRoute,
    },
    Favorite {
        key: String,
        enabled: bool,
    },
    Collapse {
        key: String,
        enabled: bool,
    },
    Visit {
        key: String,
    },
    ForgetRoute {
        #[serde(rename = "routeId")]
        route_id: String,
    },
}
fn nullable_string<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    Option::<String>::deserialize(d)
}
fn optional_scope<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<ServerScope>, D::Error> {
    ServerScope::deserialize(d).map(Some)
}
fn uuid(value: &str) -> bool {
    if value.len() != 36 || uuid::Uuid::parse_str(value).is_err() {
        return false;
    }
    // Match the pinned Zod UUID schema, including its nil/max exceptions.
    value == "00000000-0000-0000-0000-000000000000"
        || value == "ffffffff-ffff-ffff-ffff-ffffffffffff"
        || ((b'1'..=b'8').contains(&value.as_bytes()[14])
            && matches!(
                value.as_bytes()[19],
                b'8' | b'9' | b'a' | b'A' | b'b' | b'B'
            ))
}
fn route_id(value: &str) -> bool {
    value == "local" || uuid(value)
}
fn text(value: &str, limit: usize) -> bool {
    static FORBIDDEN: LazyLock<Result<regex::Regex, regex::Error>> =
        LazyLock::new(|| regex::Regex::new(r"[\p{Cc}\p{Cf}]"));
    !value.is_empty()
        && value.encode_utf16().count() <= limit
        && FORBIDDEN.as_ref().is_ok_and(|r| !r.is_match(value))
}
impl FleetCachedRoute {
    fn valid(&self) -> bool {
        route_id(&self.route_id)
            && self.environment_id.as_deref().is_none_or(uuid)
            && self.generation.as_deref().is_none_or(|s| text(s, 1024))
            && self.seen_at <= SAFE_INTEGER
            && self.sessions.len() <= 64
            && self.sessions.iter().all(|s| {
                text(&s.id, 1024)
                    && s.live_session_id.as_deref().is_none_or(|v| text(v, 1024))
                    && text(&s.name, 255)
                    && s.server_label.as_deref().is_none_or(|v| text(v, 255))
                    && s.pane_count <= 4096
                    && s.server.as_ref().is_none_or(|scope| {
                        uuid(&scope.generation)
                            && scope
                                .server_id
                                .strip_prefix("tmux-server.")
                                .is_some_and(|suffix| {
                                    suffix.len() == 32
                                        && suffix.bytes().all(|b| {
                                            b.is_ascii_digit() || (b'a'..=b'f').contains(&b)
                                        })
                                })
                    })
            })
    }
}
impl FleetClientState {
    pub fn validated(mut self) -> Result<Self, Error> {
        if self.version != 1
            || self.favorites.len() > 128
            || self.collapsed.len() > 64
            || self.recent.len() > 64
            || self.catalog.len() > 64
            || !self
                .favorites
                .iter()
                .chain(&self.collapsed)
                .chain(&self.recent)
                .all(|s| text(s, 1024))
            || !self.catalog.iter().all(FleetCachedRoute::valid)
        {
            return Err(Error::ResourceFormat);
        }
        // Canonical route IDs normalize through SavedMachineIdSchema.
        for route in &mut self.catalog {
            route.route_id.make_ascii_lowercase();
        }
        Ok(self)
    }
}
impl FleetPreferenceChange {
    fn validate(&self) -> Result<(), Error> {
        let valid = match self {
            Self::Cache { route } => route.valid(),
            Self::Favorite { key, .. } | Self::Collapse { key, .. } | Self::Visit { key } => {
                text(key, 1024)
            }
            Self::ForgetRoute { route_id: id } => route_id(id),
        };
        if valid {
            Ok(())
        } else {
            Err(Error::ActionInput)
        }
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Resource {
    daemon: Identity,
    state: FleetClientState,
}
impl LocalDaemon {
    fn fleet_resource(&self, bytes: &[u8]) -> Result<FleetClientState, Error> {
        if bytes.len() as u64 > RESPONSE_LIMIT {
            return Err(Error::ResourceFormat);
        }
        let resource: Resource =
            serde_json::from_slice(bytes).map_err(|_| Error::ResourceFormat)?;
        self.machine_identity(&resource.daemon)?;
        resource.state.validated()
    }
    pub fn fleet_preferences(&self) -> Result<FleetClientState, Error> {
        self.fleet_preference_request(None, None)
    }
    /// One write; a lost receipt is uncertain even if the daemon committed it.
    pub fn change_fleet_preference(
        &self,
        change: &FleetPreferenceChange,
        cancelled: &AtomicBool,
    ) -> Result<FleetClientState, Error> {
        change.validate()?;
        self.fleet_preference_request(Some(change), Some(cancelled))
    }
    fn fleet_preference_request(
        &self,
        change: Option<&FleetPreferenceChange>,
        cancelled: Option<&AtomicBool>,
    ) -> Result<FleetClientState, Error> {
        if cancelled.is_some_and(|c| c.load(Ordering::Acquire)) {
            return Err(Error::Retired);
        }
        self.verify_current()?;
        let endpoint = self
            .base_url
            .join("api/resources/fleet-client-state")
            .map_err(|_| Error::Endpoint)?;
        let body = change
            .map(|change| {
                serde_json::to_vec(
                    &serde_json::json!({"expectedInstanceId":self.instance_id(),"change":change}),
                )
            })
            .transpose()
            .map_err(|_| Error::ActionInput)?;
        if body.as_ref().is_some_and(|b| b.len() > 256 * 1024) {
            return Err(Error::ActionInput);
        }
        self.check_record()?;
        if cancelled.is_some_and(|c| c.load(Ordering::Acquire)) {
            return Err(Error::Retired);
        }
        let result = (|| {
            let mut response = if let Some(body) = &body {
                self.agent
                    .post(endpoint.as_str())
                    .header("Authorization", self.record.authorization()?)
                    .header("Content-Type", "application/json")
                    .header("Cache-Control", "no-store")
                    .config()
                    .timeout_global(Some(Duration::from_secs(3)))
                    .build()
                    .send(body)
            } else {
                self.agent
                    .get(endpoint.as_str())
                    .header("Authorization", self.record.authorization()?)
                    .header("Cache-Control", "no-store")
                    .config()
                    .timeout_global(Some(Duration::from_secs(3)))
                    .build()
                    .call()
            }
            .map_err(Error::Network)?;
            if response.status().as_u16() != 200 {
                return Err(Error::RequestStatus(response.status().as_u16()));
            }
            let bytes = response
                .body_mut()
                .with_config()
                .limit(RESPONSE_LIMIT)
                .read_to_vec()
                .map_err(Error::Network)?;
            self.verify_current()?;
            self.fleet_resource(&bytes)
        })();
        if change.is_some() {
            result.map_err(|e| Error::FleetMutationUncertain(Box::new(e)))
        } else {
            result
        }
    }
}
#[cfg(test)]
#[path = "fleet_preferences_tests.rs"]
mod tests;
