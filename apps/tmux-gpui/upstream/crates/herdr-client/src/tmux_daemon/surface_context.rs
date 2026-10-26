use super::{Error, LocalDaemon, ServerClient, ServerRegistration, TerminalSelection};
use crate::{
    tmux_handoff::ServerScope,
    tmux_stream::{ViewerMode, valid_identity, valid_pane},
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeSurfaceLocation {
    socket_path: String,
    server_pid: String,
    session_id: String,
    runtime_pane_id: String,
}
impl NativeSurfaceLocation {
    pub fn from_tmux(tmux: &str, pane: &str) -> Result<Self, Error> {
        let mut parts = tmux.rsplitn(3, ',');
        let session = parts.next().ok_or(Error::ActionInput)?;
        let pid = parts.next().ok_or(Error::ActionInput)?;
        let socket = parts.next().ok_or(Error::ActionInput)?;
        let number = |s: &str, max: usize, zero: bool| {
            !s.is_empty()
                && s.len() <= max
                && s.bytes().all(|b| b.is_ascii_digit())
                && (s == "0" && zero || !s.starts_with('0'))
        };
        if !socket.starts_with('/')
            || socket.len() > 4096
            || socket.contains(['\0', '\n', '\r', '\t'])
            || !number(pid, 16, false)
            || !number(session, 31, true)
            || !pane.strip_prefix('%').is_some_and(|p| number(p, 31, true))
        {
            return Err(Error::ActionInput);
        }
        Ok(Self {
            socket_path: socket.into(),
            server_pid: pid.into(),
            session_id: format!("${session}"),
            runtime_pane_id: pane.into(),
        })
    }
}
pub struct NativeSurfaceContext {
    pub scope: ServerScope,
    pub selection: TerminalSelection,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Response {
    version: u8,
    server: ServerScope,
    context: Context,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Context {
    generation: String,
    workspace_name: String,
    live_session_id: String,
    pane: String,
}
impl LocalDaemon {
    pub fn native_surface_context(
        self: &Arc<Self>,
        target: &NativeSurfaceLocation,
    ) -> Result<NativeSurfaceContext, Error> {
        let mut scopes = self
            .list_servers()?
            .into_iter()
            .filter_map(|server| match server {
                ServerRegistration::Online { scope, .. }
                    if scope.generation == self.instance_id() =>
                {
                    Some(scope)
                }
                _ => None,
            });
        let scope = scopes.next().ok_or(Error::ServerChanged)?;
        if scopes.next().is_some() {
            return Err(Error::ServerChanged);
        }
        self.select_server(&scope)?.surface_context(target)
    }
}
impl ServerClient {
    fn surface_context(
        &self,
        target: &NativeSurfaceLocation,
    ) -> Result<NativeSurfaceContext, Error> {
        self.assert_current()?;
        let local = self.daemon.local()?;
        if self.scope().generation != local.instance_id() {
            return Err(Error::ServerChanged);
        }
        self.daemon.verify_current()?;
        let scope = self.scope();
        let path = format!(
            "api/v1/tmux-servers/{}/{}/native-surface-context",
            scope.server_id, scope.generation
        );
        let body = serde_json::to_vec(target).map_err(|_| Error::ActionInput)?;
        let result = self.daemon.post_resource(&path, &body);
        self.assert_current()?;
        let context = parse(&result?, scope)?;
        self.daemon.verify_current()?;
        self.assert_current()?;
        Ok(context)
    }
}
fn parse(bytes: &[u8], scope: &ServerScope) -> Result<NativeSurfaceContext, Error> {
    if bytes.len() > 16384 {
        return Err(Error::ResourceFormat);
    }
    let response: Response = serde_json::from_slice(bytes).map_err(|_| Error::ResourceFormat)?;
    let context = response.context;
    if response.version != 1 {
        return Err(Error::ResourceFormat);
    }
    if response.server != *scope || context.generation != scope.generation {
        return Err(Error::ServerChanged);
    }
    if !valid_identity(&context.workspace_name)
        || !valid_pane(&context.pane)
        || !context
            .live_session_id
            .strip_prefix("live-session.")
            .is_some_and(|s| {
                s.len() == 20
                    && s.bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            })
    {
        return Err(Error::ResourceFormat);
    }
    Ok(NativeSurfaceContext {
        scope: scope.clone(),
        selection: TerminalSelection {
            workspace_name: context.workspace_name,
            live_session_id: context.live_session_id,
            selected_pane: context.pane.clone(),
            visible_panes: vec![context.pane],
            mode: ViewerMode::ReadOnly,
        },
    })
}
#[cfg(test)]
#[path = "surface_context_tests.rs"]
mod tests;
