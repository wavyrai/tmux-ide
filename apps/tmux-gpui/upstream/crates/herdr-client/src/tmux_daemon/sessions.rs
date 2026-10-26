use super::{Error, LocalDaemon, ServerRegistration};
use crate::tmux_handoff::ServerScope;
use serde::Deserialize;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

/// One selected server incarnation. Retirement never waits for network IO.
/// A delayed response cannot be accepted after this selection is retired.
pub struct ServerClient {
    pub(super) daemon: super::owner::Owner,
    scope: ServerScope,
    retired: AtomicBool,
    request_cancelled: Option<Arc<AtomicBool>>,
}
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Session {
    pub live_session_id: String,
    pub session_name: String,
    #[serde(deserialize_with = "nullable_workspace")]
    pub workspace_name: Option<String>,
    pub pane_count: u32,
}
fn nullable_workspace<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<String>, D::Error> {
    Option::<String>::deserialize(deserializer)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Resource {
    version: u8,
    server: ServerScope,
    sessions: Vec<Session>,
}

impl LocalDaemon {
    /// Bind only a currently advertised online registration. Never substitute a
    /// different server, including when the same registration has a new generation.
    pub fn select_server(self: &Arc<Self>, scope: &ServerScope) -> Result<ServerClient, Error> {
        super::owner::Owner::Local(Arc::clone(self)).select_server(scope)
    }
}
impl super::owner::Owner {
    pub(super) fn select_server(&self, scope: &ServerScope) -> Result<ServerClient, Error> {
        if !self.list_servers()?.iter().any(|entry| matches!(entry, ServerRegistration::Online {scope:current,..} if current==scope)) {
            return Err(Error::ServerChanged);
        }
        Ok(ServerClient {
            daemon: self.clone(),
            scope: scope.clone(),
            retired: AtomicBool::new(false),
            request_cancelled: None,
        })
    }
}
impl ServerClient {
    pub fn scope(&self) -> &ServerScope {
        &self.scope
    }
    pub fn retire(&self) {
        self.retired.store(true, Ordering::Release);
    }
    pub(super) fn bind_request(&mut self, cancelled: Arc<AtomicBool>) {
        self.request_cancelled = Some(cancelled);
    }
    pub(super) fn assert_current(&self) -> Result<(), Error> {
        if self.retired.load(Ordering::Acquire)
            || self
                .request_cancelled
                .as_ref()
                .is_some_and(|cancelled| cancelled.load(Ordering::Acquire))
        {
            Err(Error::Retired)
        } else {
            Ok(())
        }
    }
    pub fn sessions(&self) -> Result<Vec<Session>, Error> {
        self.assert_current()?;
        let path = format!(
            "api/v1/tmux-servers/{}/{}/sessions",
            self.scope.server_id, self.scope.generation
        );
        let result = self.daemon.get_resource(&path);
        // Retirement takes precedence over a result or error from the old route.
        self.assert_current()?;
        let parsed = parse(&result?, &self.scope);
        self.assert_current()?;
        parsed
    }
}
fn parse(bytes: &[u8], scope: &ServerScope) -> Result<Vec<Session>, Error> {
    let resource: Resource = serde_json::from_slice(bytes).map_err(|_| Error::ResourceFormat)?;
    if resource.version != 1 || resource.sessions.len() > 4096 {
        return Err(Error::ResourceFormat);
    }
    if &resource.server != scope {
        return Err(Error::ServerChanged);
    }
    for entry in &resource.sessions {
        let Some(suffix) = entry.live_session_id.strip_prefix("live-session.") else {
            return Err(Error::ResourceFormat);
        };
        if suffix.len() != 20
            || !suffix
                .bytes()
                .all(|v| v.is_ascii_digit() || (b'a'..=b'f').contains(&v))
            || !valid_name(&entry.session_name)
            || entry
                .workspace_name
                .as_ref()
                .is_some_and(|v| !valid_name(v))
        {
            return Err(Error::ResourceFormat);
        }
    }
    Ok(resource.sessions)
}
fn valid_name(value: &str) -> bool {
    !value.is_empty() && value.encode_utf16().count() <= 160
}

#[cfg(test)]
#[path = "sessions_tests.rs"]
mod tests;
