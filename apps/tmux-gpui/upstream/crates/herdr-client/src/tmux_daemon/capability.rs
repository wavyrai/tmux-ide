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
    /// #806: the one tmux window this stream is for (`visible_panes` are
    /// exactly its panes); `None` for the whole session, as before. Sent only
    /// to a daemon that knows window-scoped streams (`window_streams`).
    pub window: Option<String>,
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
/// What an issue request offers as `terminalDelivery.protocolVersions`.
fn offered_versions(
    graphics: bool,
    local_images: bool,
    native_surfaces: bool,
    interactive: bool,
    bundle: bool,
) -> Vec<u32> {
    let graphics_bundle = if local_images { 114 } else { 113 };
    let mut versions = if graphics {
        vec![1, 101, graphics_bundle, 118, 103, 104]
    } else {
        vec![1, 109]
    };
    if native_surfaces {
        versions.push(116);
    }
    if interactive {
        versions.extend([105, 106]);
    }
    // 119, "topology in place" (#723): the stream stays open when another
    // tmux client splits or closes a pane. A daemon that predates it ignores
    // the number and closes with 1012 as before. Every daemon refuses an
    // offer of more than nine numbers, and an interactive stream with native
    // surfaces already offers nine. There 120, which is 118 and 119 as one
    // number, takes the place of 118, but only for a daemon that knows 120:
    // any other would give neither. For those a pane change re-leases as
    // before.
    if versions.len() < MAX_OFFERED_VERSIONS {
        versions.push(TOPOLOGY_IN_PLACE);
    } else if bundle {
        for version in &mut versions {
            if *version == 118 {
                *version = READER_TOPOLOGY_BUNDLE;
            }
        }
    }
    versions
}
/// Capability 123 (#718: each layout pane's browser kind) added to a
/// header stream's offer, for a daemon that knows it. Such a daemon also
/// takes up to 16 numbers; a released one refuses a tenth, so it never gets
/// 123. A surface source has no header and never asks for it.
fn with_browser_kind(
    mut versions: Vec<u32>,
    graphics: bool,
    product_version: Option<&str>,
) -> Vec<u32> {
    if graphics
        && release_at_least(product_version, BROWSER_KIND_SINCE)
        && versions.len() < MAX_OFFERED_VERSIONS_2_9_26
    {
        versions.push(BROWSER_KIND);
    }
    versions
}
/// Whether a daemon of this product version knows capability 120. Only a
/// plain release number counts: for anything else 118 stays in the offer.
fn knows_topology_bundle(product_version: Option<&str>) -> bool {
    release_at_least(product_version, TOPOLOGY_BUNDLE_SINCE)
}
/// Whether a daemon of this product version knows window-scoped streams
/// (#806): the issue request's `semanticWindowId`, inventory version 2 and
/// sessions version 3. A released daemon refuses the unknown issue field.
pub(super) fn knows_window_streams(product_version: Option<&str>) -> bool {
    release_at_least(product_version, WINDOW_STREAMS_SINCE)
}
/// The issue request. A window-scoped selection (#806) names its window, and
/// only to a daemon that knows the field: a released daemon refuses unknown
/// stream fields, so an older one gets no window selection at all.
pub(super) fn issue_body(
    request_id: &str,
    generation: &str,
    selection: &TerminalSelection,
    versions: &[u32],
    daemon_version: Option<&str>,
) -> Result<String, Error> {
    let mut body = serde_json::json!({"requestId":request_id,"expectedDaemonInstanceId":generation,
        "stream":{"protocolVersion":2,"workspaceName":selection.workspace_name,"panes":selection.visible_panes,"viewerMode":selection.mode,
        "terminalDelivery":{"protocolVersions":versions,"encodings":["semantic-compact-v1"],"richPlacements":true}}});
    if let Some(window) = &selection.window {
        if !knows_window_streams(daemon_version) {
            return Err(Error::TerminalSelection);
        }
        body["stream"]["semanticWindowId"] = window.as_str().into();
    }
    Ok(body.to_string())
}
/// Capability 122, history on demand: a seed carries the screen and the
/// newest 200 history rows, and the app asks for older rows as it needs
/// them. Only a daemon that knows it (2.9.27) gets it; its offer has more
/// than nine numbers, which a daemon takes from 2.9.26 (#433). Every other
/// daemon gets the offer unchanged.
fn with_partial_history(mut versions: Vec<u32>, product_version: Option<&str>) -> Vec<u32> {
    if release_at_least(product_version, PARTIAL_HISTORY_SINCE)
        && versions.len() < MAX_OFFERED_VERSIONS_2_9_26
    {
        versions.push(PARTIAL_HISTORY);
    }
    versions
}
/// Capability 124, pipelined delivery (#454): the daemon may send patches
/// behind unacknowledged ones. The receiver applies each in order against its
/// last applied revision and ACKs each, so it already takes them; only a
/// daemon release that knows 124 (2.9.27) is offered it.
fn with_pipelining(mut versions: Vec<u32>, product_version: Option<&str>) -> Vec<u32> {
    if release_at_least(product_version, PIPELINING_SINCE)
        && versions.len() < MAX_OFFERED_VERSIONS_2_9_26
    {
        versions.push(PIPELINING);
    }
    versions
}
/// The protocol versions an issue request offers a daemon of this product
/// version: the base offer, then 123 (#446), then 122, then 124, each only
/// for a daemon that knows it.
fn issue_versions(
    graphics: bool,
    local_images: bool,
    native_surfaces: bool,
    interactive: bool,
    daemon_version: Option<&str>,
) -> Vec<u32> {
    let versions = offered_versions(
        graphics,
        local_images,
        native_surfaces,
        interactive,
        knows_topology_bundle(daemon_version),
    );
    let versions = with_browser_kind(versions, graphics, daemon_version);
    with_pipelining(
        with_partial_history(versions, daemon_version),
        daemon_version,
    )
}
/// Whether `product_version` is a plain release number at least `since`.
fn release_at_least(product_version: Option<&str>, since: [u64; 3]) -> bool {
    let Some(version) = product_version else {
        return false;
    };
    let mut parts = version.split('.').map(|part| {
        (!part.is_empty() && part.len() <= 9 && part.bytes().all(|b| b.is_ascii_digit()))
            .then(|| part.parse::<u64>().ok())
            .flatten()
    });
    let (Some(Some(major)), Some(Some(minor)), Some(Some(patch)), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return false;
    };
    [major, minor, patch] >= since
}
/// The daemon's bound on `terminalDelivery.protocolVersions` (contracts
/// terminal-delivery.ts): one number more and the issue request is refused.
const MAX_OFFERED_VERSIONS: usize = 9;
/// Capability 119: the stream follows pane changes in place.
const TOPOLOGY_IN_PLACE: u32 = 119;
/// Capability 120: 118 and 119 as one number, for an offer that is full.
const READER_TOPOLOGY_BUNDLE: u32 = 120;
/// The first daemon release that knows capability 120. An earlier daemon
/// that is offered 120 gives neither 118 nor 119, so this must not be lower
/// than the release the daemon side of #723 ships in.
const TOPOLOGY_BUNDLE_SINCE: [u64; 3] = [2, 9, 25];
/// Capability 123: each layout pane carries its `browserKind` (#718).
const BROWSER_KIND: u32 = 123;
/// The first daemon release that knows 123 and takes a 16-number offer
/// (#433). Not yet set by a release: the PM confirms it when 2.9.26 ships.
const BROWSER_KIND_SINCE: [u64; 3] = [2, 9, 26];
/// The bound a daemon of 2.9.26 or later puts on an offer (#433). The same
/// constant as on the partial-history branch (#122); keep one at merge.
const MAX_OFFERED_VERSIONS_2_9_26: usize = 16;
/// The first daemon release with window-scoped streams (#806). Not yet set
/// by a release: the PM confirms it when the daemon side ships.
const WINDOW_STREAMS_SINCE: [u64; 3] = [2, 9, 26];
/// Capability 122, history on demand (#435). 2.9.26 shipped without it, so a
/// released 2.9.26 daemon must not be offered it (lead, 17 Nov).
const PARTIAL_HISTORY_SINCE: [u64; 3] = [2, 9, 27];
const PARTIAL_HISTORY: u32 = 122;
/// Capability 124, pipelined delivery (#454), from the 2.9.27 daemon.
const PIPELINING_SINCE: [u64; 3] = [2, 9, 27];
const PIPELINING: u32 = 124;
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
        let prelude = self.issue_prelude(graphics, selection.mode == ViewerMode::Interactive)?;
        let request_id = Uuid::new_v4().to_string();
        let host_client_id = format!("gpui:{}", Uuid::new_v4());
        let scope = self.scope();
        let body = issue_body(
            &request_id,
            &scope.generation,
            selection,
            &prelude.versions,
            prelude.daemon_version.as_deref(),
        )?;
        let path = format!(
            "api/v1/tmux-servers/{}/{}/pane-streams/issue?liveSessionId={}",
            scope.server_id, scope.generation, selection.live_session_id
        );
        let result = self.daemon.post_resource_with_headers(
            &path,
            body.as_bytes(),
            &issue_headers(&request_id, &scope.generation, &host_client_id),
        );
        self.assert_current()?;
        self.issue_finish(prelude, selection, &request_id, host_client_id, &result?)
    }
    /// Everything an issue request needs before it is sent: the origin the
    /// descriptor must name, local image access, the SSH forward and peer,
    /// the offered protocol versions, and (attach-rtt) the stream's socket
    /// being dialed and proven while the request is in flight.
    pub(super) fn issue_prelude(
        &self,
        graphics: bool,
        interactive: bool,
    ) -> Result<IssuePrelude, Error> {
        let daemon_version = self.product_version();
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
        let prepared = remote
            .as_ref()
            .map(|(port, peer)| self.take_prepared().unwrap_or_else(|| prepare(*port, peer)));
        let native_surfaces = graphics && self.native_surface_capability()?;
        // A verified SSH loopback forward is still remote. Never offer local
        // file leases unless this handoff carries actual local image access.
        // 117 bundles favicon metadata with zlib support (102), retaining the
        // nine-slot offer bound. Older daemons fall back to inflated image bytes.
        // 118 is 117 plus the reader pane badge (#756); a daemon that predates it
        // sends neither icons nor badges and serves inflated image bytes.
        let versions = issue_versions(
            graphics,
            local_images.is_some(),
            native_surfaces,
            interactive,
            daemon_version.as_deref(),
        );
        Ok(IssuePrelude {
            origin,
            local_images,
            remote,
            prepared,
            native_surfaces,
            versions,
            daemon_version,
            graphics,
        })
    }
    /// Check an issue answer against the selection and build the handoff.
    pub(super) fn issue_finish(
        &self,
        prelude: IssuePrelude,
        selection: &TerminalSelection,
        request_id: &str,
        host_client_id: String,
        bytes: &[u8],
    ) -> Result<Handoff, Error> {
        let scope = self.scope();
        let mut descriptor = parse(bytes, selection, scope, request_id, &prelude.origin)?;
        let remote_peer = if let Some((port, peer)) = prelude.remote {
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
        let redeem_in_upgrade = attaches(prelude.daemon_version.as_deref());
        Ok(Handoff {
            native_surfaces: prelude.native_surfaces,
            remote_peer,
            descriptor,
            origin: ORIGIN.into(),
            host_client_id,
            workspace_name: selection.workspace_name.clone(),
            selected_pane: selection.selected_pane.clone(),
            catalog_only: false,
            graphics: prelude.graphics,
            binary_cells: true,
            alternate_screen_projection: prelude.graphics,
            local_images: prelude.local_images,
            server_scope: Some(scope.clone()),
            daemon_version: prelude.daemon_version,
            upgrade: crate::tmux_stream::UpgradeHints {
                prepared: prelude.prepared,
                redeem_in_upgrade,
            },
        })
    }
    /// attach-rtt: start dialing and proving the stream's socket now, before
    /// the requests that lead to the issue, when the daemon is over SSH.
    pub(super) fn prepare_stream(&self) {
        #[cfg(unix)]
        if let super::owner::Owner::Remote(remote) = &self.daemon
            && let Ok((_, port, peer)) = remote.capability_route()
            && let Ok(mut slot) = self.prepared.lock()
        {
            *slot = Some(prepare(port, &peer));
        }
    }
    /// Put back the socket an unused prelude was proving, for the next issue.
    pub(super) fn keep_prepared(&self, prelude: IssuePrelude) {
        if let (Some(prepared), Ok(mut slot)) = (prelude.prepared, self.prepared.lock()) {
            *slot = Some(prepared);
        }
    }
    fn take_prepared(&self) -> Option<crate::tmux_stream::PreparedSocket> {
        self.prepared.lock().ok()?.take()
    }
}
fn prepare(port: u16, peer: &crate::tmux_ssh::PeerIdentity) -> crate::tmux_stream::PreparedSocket {
    crate::tmux_stream::PreparedSocket::spawn(port, peer.clone(), std::time::Duration::from_secs(2))
}
pub(super) fn issue_headers<'a>(
    request_id: &'a str,
    generation: &'a str,
    host_client_id: &'a str,
) -> [(&'static str, &'a str); 4] {
    [
        ("Origin", ORIGIN),
        ("X-Tmux-Ide-Request-Id", request_id),
        ("X-Tmux-Ide-Expected-Daemon-Instance-Id", generation),
        ("X-Tmux-Ide-Host-Client-Id", host_client_id),
    ]
}
/// What `issue_prelude` gathers for one issue or attach request.
pub(super) struct IssuePrelude {
    origin: url::Url,
    local_images: Option<LocalImages>,
    remote: Option<(u16, crate::tmux_ssh::PeerIdentity)>,
    prepared: Option<crate::tmux_stream::PreparedSocket>,
    native_surfaces: bool,
    pub(super) versions: Vec<u32>,
    pub(super) daemon_version: Option<String>,
    graphics: bool,
}
/// attach-rtt: whether a daemon of this product version knows the attach
/// request and a redeem carried by the upgrade, and keeps an owner
/// connection 65 s. Not yet set by a release: the PM confirms it when the
/// daemon side ships.
pub(super) fn attaches(product_version: Option<&str>) -> bool {
    release_at_least(product_version, ATTACH_SINCE)
}
const ATTACH_SINCE: [u64; 3] = [2, 9, 27];
impl TerminalSelection {
    pub(super) fn validate(&self) -> Result<(), Error> {
        let valid_pane = crate::tmux_stream::valid_pane;
        let live = self.live_session_id.strip_prefix("live-session.");
        if !crate::tmux_stream::valid_identity(&self.workspace_name)
            || !self.visible_panes.contains(&self.selected_pane)
            || self.visible_panes.is_empty()
            || self.visible_panes.len() > crate::tmux_stream::MAX_PANES
            || self
                .visible_panes
                .iter()
                .enumerate()
                .any(|(i, v)| !valid_pane(v) || self.visible_panes[..i].contains(v))
            || self
                .window
                .as_ref()
                .is_some_and(|window| !crate::tmux_topology::valid_identity(window))
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
#[cfg(all(test, unix))]
#[path = "capability_remote_version_tests.rs"]
mod remote_version_tests;
#[cfg(test)]
#[path = "capability_tests.rs"]
mod tests;
