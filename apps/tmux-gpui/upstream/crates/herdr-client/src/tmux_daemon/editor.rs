//! Fresh owner-authenticated editor observations. A directory is not a reusable
//! launch capability; the caller must still fence the explicit user action.
use super::{Error, ServerClient};
use crate::{
    tmux_handoff::ServerScope,
    tmux_stream::{valid_identity, valid_pane},
};
use serde::{Deserialize, Serialize};
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EditorTarget {
    pub generation: String,
    pub workspace_name: String,
    pub live_session_id: String,
    pub semantic_pane_id: String,
}
impl EditorTarget {
    pub(super) fn valid(&self) -> bool {
        self.generation.len() == 36
            && uuid::Uuid::parse_str(&self.generation).is_ok()
            && valid_identity(&self.workspace_name)
            && valid_pane(&self.semantic_pane_id)
            && self
                .live_session_id
                .strip_prefix("live-session.")
                .is_some_and(|s| {
                    s.len() == 20
                        && s.bytes()
                            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                })
    }
}
/// Intentionally neither Debug nor Serialize: the host directory must not enter
/// diagnostic output or a terminal presentation publication.
pub struct EditorContext {
    directory: String,
}
impl EditorContext {
    pub fn directory(&self) -> &str {
        &self.directory
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Response {
    version: u8,
    server: ServerScope,
    context: Observation,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Observation {
    generation: String,
    workspace_name: String,
    live_session_id: String,
    semantic_pane_id: String,
    cwd: Cwd,
    directory: String,
}
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
enum Cwd {
    Absolute { path: String },
    ProjectRelative { path: String },
}
impl ServerClient {
    pub fn editor_context(&self, target: &EditorTarget) -> Result<EditorContext, Error> {
        self.assert_current()?;
        if !target.valid() {
            return Err(Error::ActionInput);
        }
        if target.generation != self.scope().generation {
            return Err(Error::ServerChanged);
        }
        // A private record plus a fresh identity check proves local-host ownership;
        // a forwarded loopback URL without that record cannot construct this client.
        self.daemon.verify_current()?;
        self.assert_current()?;
        let scope = self.scope();
        let path = format!(
            "api/v1/tmux-servers/{}/{}/pane-editor-context",
            scope.server_id, scope.generation
        );
        let body = serde_json::to_vec(target).map_err(|_| Error::ActionInput)?;
        let result = self.daemon.post_resource(&path, &body);
        self.assert_current()?;
        let context = parse(&result?, scope, target)?;
        self.daemon.verify_current()?;
        self.assert_current()?;
        Ok(context)
    }
}
fn parse(bytes: &[u8], scope: &ServerScope, target: &EditorTarget) -> Result<EditorContext, Error> {
    if bytes.len() > 32 * 1024 {
        return Err(Error::ResourceFormat);
    }
    let response: Response = serde_json::from_slice(bytes).map_err(|_| Error::ResourceFormat)?;
    let o = response.context;
    if response.version != 1 {
        return Err(Error::ResourceFormat);
    }
    if response.server != *scope
        || o.generation != target.generation
        || o.workspace_name != target.workspace_name
        || o.live_session_id != target.live_session_id
        || o.semantic_pane_id != target.semantic_pane_id
    {
        return Err(Error::ServerChanged);
    }
    if !safe_path(&o.directory) || !absolute(&o.directory) {
        return Err(Error::ResourceFormat);
    }
    let valid_cwd = match o.cwd {
        Cwd::Absolute { path } => path == o.directory,
        Cwd::ProjectRelative { path } => safe_path(&path) && contained(&path),
    };
    if !valid_cwd {
        return Err(Error::ResourceFormat);
    }
    Ok(EditorContext {
        directory: o.directory,
    })
}
fn safe_path(path: &str) -> bool {
    !path.is_empty() && path.encode_utf16().count() <= 4096 && !path.contains('\0')
}
fn absolute(path: &str) -> bool {
    let bytes = path.as_bytes();
    path.starts_with('/')
        || (bytes.len() >= 3
            && bytes[0].is_ascii_alphabetic()
            && bytes[1] == b':'
            && matches!(bytes[2], b'/' | b'\\'))
        || path.strip_prefix("\\\\").is_some_and(|p| {
            p.split_once('\\').is_some_and(|(host, rest)| {
                !host.is_empty() && !rest.is_empty() && !rest.starts_with('\\')
            })
        })
}
fn contained(path: &str) -> bool {
    if path.starts_with(['/', '\\'])
        || (path.as_bytes().get(1) == Some(&b':') && path.as_bytes()[0].is_ascii_alphabetic())
    {
        return false;
    }
    let mut depth = 0;
    for part in path.split(['/', '\\']) {
        match part {
            "" | "." => {}
            ".." if depth == 0 => return false,
            ".." => depth -= 1,
            _ => depth += 1,
        }
    }
    true
}
#[cfg(test)]
#[path = "editor_tests.rs"]
mod tests;
