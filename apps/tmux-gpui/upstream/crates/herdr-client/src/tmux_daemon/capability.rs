use super::{Error, LocalDaemon, ServerClient};
use crate::{
    tmux_graphics::LocalImages,
    tmux_handoff::Handoff,
    tmux_stream::{IssuedDescriptor, ViewerMode},
};
use serde::Deserialize;
use uuid::Uuid;

/// A catalog-selected session/pane set, not authority by itself.
pub struct TerminalSelection {
    pub workspace_name: String,
    pub live_session_id: String,
    pub selected_pane: String,
    pub visible_panes: Vec<String>,
    pub mode: ViewerMode,
}
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum IssueCode {
    PreviewOnly,
    RendererOriginUnavailable,
    DaemonUnavailable,
    DaemonDegraded,
    InvalidRequest,
    WorkspaceNotFound,
    PaneNotFound,
    PaneNotAttachable,
    InteractiveViewerConflict,
    RequestTimeout,
    ResponseTooLarge,
    InvalidResponse,
    DaemonIdentityMismatch,
    #[serde(alias = "stream-unavailable")]
    AttachmentUnavailable,
    RequestFailed,
    Disposed,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Refusal {
    code: IssueCode,
    reason: String,
    retryable: bool,
}
#[derive(Deserialize)]
#[serde(tag = "status", rename_all = "lowercase", deny_unknown_fields)]
enum Response {
    Issued { descriptor: IssuedDescriptor },
    Error { error: Refusal },
}
const ORIGIN: &str = "tmux-ide://app";
impl LocalDaemon {
    fn image_access(&self) -> Result<LocalImages, Error> {
        self.verify_current()?;
        let parent = self.path.parent().ok_or(Error::RecordSecurity)?;
        let directory = parent.canonicalize().map_err(Error::RecordIo)?;
        let root = directory.join(format!("local-images-{}", self.record.instance_id));
        let root = root.to_str().ok_or(Error::RecordFormat)?.to_owned();
        self.check_record()?;
        let access = LocalImages {
            root,
            generation: self.record.instance_id.clone(),
        };
        if !access.validate() {
            return Err(Error::RecordSecurity);
        }
        Ok(access)
    }
}
impl ServerClient {
    /// Issue a one-use terminal capability; no owner credential enters the handoff.
    /// Read-only and interactive modes stay distinct through request and response.
    pub fn issue_terminal(&self, selection: &TerminalSelection) -> Result<Handoff, Error> {
        self.issue_selected(selection, true)
    }
    /// Local pixel producers observe exactly one pane without acquiring input
    /// authority or subscribing to their own graphics payloads.
    pub fn issue_surface_source(&self, selection: &TerminalSelection) -> Result<Handoff, Error> {
        self.assert_current()?;
        let local = self.daemon.local()?;
        if self.scope().generation != local.instance_id() {
            return Err(Error::ServerChanged);
        }
        if selection.mode != ViewerMode::ReadOnly || selection.visible_panes.len() != 1 {
            return Err(Error::TerminalSelection);
        }
        self.issue_selected(selection, false)
    }
    fn issue_selected(
        &self,
        selection: &TerminalSelection,
        graphics: bool,
    ) -> Result<Handoff, Error> {
        self.assert_current()?;
        selection.validate()?;
        let (origin, local_images, remote): (_, _, Option<(u16, crate::tmux_ssh::PeerIdentity)>) =
            match &self.daemon {
                super::owner::Owner::Local(local) => (
                    local.base_url.clone(),
                    if graphics {
                        Some(local.image_access()?)
                    } else {
                        None
                    },
                    None,
                ),
                #[cfg(unix)]
                super::owner::Owner::Remote(remote) => {
                    let (origin, port, peer) = remote
                        .capability_route()
                        .map_err(super::owner::remote_error)?;
                    (origin, None, Some((port, peer)))
                }
            };
        self.assert_current()?;
        let native_surfaces = graphics && self.native_surface_capability()?;
        let request_id = Uuid::new_v4().to_string();
        let host_client_id = format!("gpui:{}", Uuid::new_v4());
        let scope = self.scope();
        // A verified SSH loopback forward is still remote. Never offer local
        // file leases unless this handoff carries actual local image access.
        // 117 bundles favicon metadata with zlib support (102), retaining the
        // nine-slot offer bound. Older daemons fall back to inflated image bytes.
        let graphics_bundle = if local_images.is_some() { 114 } else { 113 };
        let mut versions = if graphics {
            vec![1, 101, graphics_bundle, 117, 103, 104]
        } else {
            vec![1, 109]
        };
        if native_surfaces {
            versions.push(116);
        }
        if selection.mode == ViewerMode::Interactive {
            versions.extend([105, 106]);
        }
        let body=serde_json::json!({"requestId":request_id,"expectedDaemonInstanceId":scope.generation,
            "stream":{"protocolVersion":2,"workspaceName":selection.workspace_name,"panes":selection.visible_panes,"viewerMode":selection.mode,
            "terminalDelivery":{"protocolVersions":versions,"encodings":["semantic-compact-v1"],"richPlacements":true}}}).to_string();
        let path = format!(
            "api/v1/tmux-servers/{}/{}/pane-streams/issue?liveSessionId={}",
            scope.server_id, scope.generation, selection.live_session_id
        );
        let result = self.daemon.post_resource_with_headers(
            &path,
            body.as_bytes(),
            &[
                ("Origin", ORIGIN),
                ("X-Tmux-Ide-Request-Id", &request_id),
                ("X-Tmux-Ide-Expected-Daemon-Instance-Id", &scope.generation),
                ("X-Tmux-Ide-Host-Client-Id", &host_client_id),
            ],
        );
        self.assert_current()?;
        let mut descriptor = parse(&result?, selection, scope, &request_id, &origin)?;
        let remote_peer = if let Some((port, peer)) = remote {
            // Validate the remote daemon's canonical origin before translating
            // only its authority to our owned SSH forward. Path/ticket stay exact.
            let mut endpoint = descriptor.validate().map_err(Error::Capability)?;
            endpoint
                .set_host(Some("127.0.0.1"))
                .map_err(|_| Error::Endpoint)?;
            endpoint
                .set_port(Some(port))
                .map_err(|()| Error::Endpoint)?;
            descriptor.web_socket_url = endpoint.to_string();
            descriptor.validate().map_err(Error::Capability)?;
            Some(peer)
        } else {
            None
        };
        self.assert_current()?;
        Ok(Handoff {
            native_surfaces,
            remote_peer,
            descriptor,
            origin: ORIGIN.into(),
            host_client_id,
            workspace_name: selection.workspace_name.clone(),
            selected_pane: selection.selected_pane.clone(),
            catalog_only: false,
            graphics,
            binary_cells: true,
            alternate_screen_projection: graphics,
            local_images,
            server_scope: Some(scope.clone()),
        })
    }
}
impl TerminalSelection {
    fn validate(&self) -> Result<(), Error> {
        let valid_pane = crate::tmux_stream::valid_pane;
        let live = self.live_session_id.strip_prefix("live-session.");
        if !crate::tmux_stream::valid_identity(&self.workspace_name)
            || !self.visible_panes.contains(&self.selected_pane)
            || self.visible_panes.is_empty()
            || self.visible_panes.len() > 24
            || self
                .visible_panes
                .iter()
                .enumerate()
                .any(|(i, v)| !valid_pane(v) || self.visible_panes[..i].contains(v))
            || live.is_none_or(|v| {
                v.len() != 20
                    || !v
                        .bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            })
        {
            return Err(Error::TerminalSelection);
        }
        Ok(())
    }
}
fn parse(
    bytes: &[u8],
    selection: &TerminalSelection,
    scope: &crate::tmux_handoff::ServerScope,
    request_id: &str,
    origin: &url::Url,
) -> Result<IssuedDescriptor, Error> {
    let response: Response = serde_json::from_slice(bytes).map_err(|_| Error::ResourceFormat)?;
    let descriptor = match response {
        Response::Issued { descriptor } => descriptor,
        Response::Error { error } => {
            // Never carry peer-provided reason text into diagnostics.
            if error.reason.is_empty() || error.reason.encode_utf16().count() > 240 {
                return Err(Error::ResourceFormat);
            }
            return Err(Error::StreamRefused {
                code: error.code,
                retryable: error.retryable,
            });
        }
    };
    let endpoint = descriptor.validate().map_err(Error::Capability)?;
    let path = format!(
        "/v2/tmux-servers/{}/{}/pane-streams/redeem",
        scope.server_id, scope.generation
    );
    let mut expected = origin.clone();
    expected.set_scheme("ws").map_err(|()| Error::Endpoint)?;
    let mut actual_panes = descriptor.panes.clone();
    actual_panes.sort();
    let mut wanted_panes = selection.visible_panes.clone();
    wanted_panes.sort();
    if endpoint.origin() != expected.origin()
        || (endpoint.path() != path && endpoint.path() != "/v2/terminal/pane-streams/redeem")
        || descriptor.daemon_instance_id != scope.generation
        || descriptor.request_id != request_id
        || actual_panes != wanted_panes
        || descriptor.effective_viewer_mode != selection.mode
    {
        return Err(Error::ServerChanged);
    }
    Ok(descriptor)
}
#[cfg(test)]
#[path = "capability_tests.rs"]
mod tests;
