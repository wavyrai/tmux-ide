use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use url::Url;

use super::{Error, MAX_SERVER_BYTES, SUBPROTOCOL};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ViewerMode {
    Interactive,
    ReadOnly,
}

/// Issued by the authenticated broker. Contains no reusable owner credential.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IssuedDescriptor {
    pub protocol_version: u8,
    pub web_socket_url: String,
    pub subprotocol: String,
    pub redemption_ticket: String,
    pub daemon_instance_id: String,
    pub request_id: String,
    pub expires_at: u64,
    pub panes: Vec<String>,
    pub effective_viewer_mode: ViewerMode,
}

impl std::fmt::Debug for IssuedDescriptor {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("IssuedDescriptor").finish_non_exhaustive()
    }
}

pub struct ConnectOptions {
    pub remote_peer: Option<crate::tmux_ssh::PeerIdentity>,
    pub descriptor: IssuedDescriptor,
    pub origin: String,
    pub host_client_id: String,
}

impl IssuedDescriptor {
    pub(crate) fn validate(&self) -> Result<Url, Error> {
        let url = Url::parse(&self.web_socket_url).map_err(|_| Error::Descriptor)?;
        let ticket = self
            .redemption_ticket
            .strip_prefix("ps2_")
            .ok_or(Error::Descriptor)?;
        if self.protocol_version != 2
            || self.subprotocol != SUBPROTOCOL
            || self.web_socket_url.len() > 2048
            || url.scheme() != "ws"
            || !matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"))
            || url.port().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || url.as_str() != self.web_socket_url
            || !valid_path(url.path())
            || ticket.len() != 43
            || !ticket
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c))
            || uuid::Uuid::parse_str(&self.daemon_instance_id).is_err()
            || uuid::Uuid::parse_str(&self.request_id).is_err()
            || self.panes.is_empty()
            || self.panes.len() > 24
            || self.panes.iter().any(|pane| !valid_pane(pane))
            || self
                .panes
                .iter()
                .enumerate()
                .any(|(index, pane)| self.panes[..index].contains(pane))
        {
            return Err(Error::Descriptor);
        }
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| Error::Expired)?
            .as_millis();
        if u128::from(self.expires_at) <= now {
            return Err(Error::Expired);
        }
        Ok(url)
    }
}

fn valid_path(path: &str) -> bool {
    if path == "/v2/terminal/pane-streams/redeem" {
        return true;
    }
    let parts: Vec<_> = path.split('/').collect();
    if parts.len() != 7
        || parts[1] != "v2"
        || parts[2] != "tmux-servers"
        || parts[5] != "pane-streams"
        || parts[6] != "redeem"
    {
        return false;
    }
    parts[3].strip_prefix("tmux-server.").is_some_and(|suffix| {
        suffix.len() == 32
            && suffix
                .bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    }) && uuid::Uuid::parse_str(parts[4]).is_ok()
}

pub(crate) fn valid_pane(pane: &str) -> bool {
    valid_identity(pane) && !pane.starts_with("terminal.discovered.")
}
pub(crate) fn valid_identity(pane: &str) -> bool {
    !pane.is_empty()
        && pane.len() <= 128
        && pane.as_bytes()[0].is_ascii_alphanumeric()
        && pane
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
        && !matches!(pane, "__proto__" | "prototype" | "constructor")
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Ready {
    #[serde(rename = "type")]
    kind: String,
    pub protocol_version: u8,
    pub daemon_instance_id: String,
    pub request_id: String,
    pub connection_client_id: Option<String>,
    pub panes: Vec<String>,
    pub effective_viewer_mode: ViewerMode,
    pub authority: Option<Box<RawValue>>,
    pub input_lifetime: Option<bool>,
    pub input_bytes: Option<bool>,
    /// Capability 119: this stream follows pane changes with `topology`
    /// frames instead of closing. Absent from a daemon without it.
    pub topology_in_place: Option<bool>,
    #[serde(default)]
    pub diagnostic_capabilities: Vec<String>,
}

/// Capability 119, "topology in place": the stream's pane set changed and the
/// stream stays open. `panes` is the whole set from now on. A
/// `layout-snapshot` of the same epoch follows, then each added pane's
/// `terminal-delivery-ready` and seed, as when a stream opens.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Topology {
    #[serde(rename = "type")]
    kind: String,
    pub topology_epoch: u64,
    pub panes: Vec<String>,
    pub removed: Vec<String>,
    pub added: Vec<String>,
}
impl Topology {
    pub fn parse(text: &str) -> Result<Self, Error> {
        let frame: Self = serde_json::from_str(text).map_err(Error::Json)?;
        if frame.kind != "topology" {
            return Err(Error::Frame);
        }
        Ok(frame)
    }
}

/// What the reader knows of the stream after its ready frame: whether the
/// daemon follows pane changes in place, and the pane set as it is now.
pub(super) struct Live {
    in_place: bool,
    panes: Vec<String>,
    epoch: Option<u64>,
}
impl Live {
    pub(super) fn new(options: &ConnectOptions) -> Self {
        Self {
            in_place: false,
            panes: options.descriptor.panes.clone(),
            epoch: None,
        }
    }
    /// Checks a `topology` frame against the set this side holds and takes
    /// the new set. Any disagreement is an identity failure: the stream ends
    /// and the caller leases a new one, as before capability 119.
    fn follow(&mut self, frame: &Topology) -> Result<(), Error> {
        let known = |pane: &String| self.panes.contains(pane);
        let unique = |list: &[String]| {
            (list.iter().enumerate()).all(|(index, pane)| !list[..index].contains(pane))
        };
        let mut expected: Vec<&String> = (self.panes.iter())
            .filter(|pane| !frame.removed.contains(pane))
            .chain(&frame.added)
            .collect();
        let mut named: Vec<&String> = frame.panes.iter().collect();
        expected.sort();
        named.sort();
        if !self.in_place
            || self.epoch.is_some_and(|last| frame.topology_epoch <= last)
            || frame.panes.is_empty()
            || frame.panes.len() > 24
            || !frame.panes.iter().all(|pane| valid_pane(pane))
            || !unique(&frame.panes)
            || !unique(&frame.removed)
            || !unique(&frame.added)
            || !frame.removed.iter().all(known)
            || frame.added.iter().any(known)
            || expected != named
        {
            return Err(Error::Identity);
        }
        self.panes.clone_from(&frame.panes);
        self.epoch = Some(frame.topology_epoch);
        Ok(())
    }
}

#[derive(Debug)]
pub enum Event {
    Ready(Ready),
    DeliveryReady {
        pane: String,
        negotiation: Box<RawValue>,
    },
    ProjectionEnvelope {
        pane: String,
        envelope: Box<RawValue>,
    },
    Envelope {
        pane: String,
        envelope: Box<RawValue>,
    },
    Chunk {
        pane: String,
        transaction_id: String,
        index: u8,
        data: String,
    },
    BinaryChunk {
        pane: String,
        transaction_id: String,
        index: u8,
        data: Vec<u8>,
    },
    /// Existing authority/layout/graphics/fault frames; caller owns their protocol policy.
    Control(Box<RawValue>),
    /// The stream's pane set changed in place (capability 119). Already
    /// checked against the reader's set; `raw` is the frame for the caller's
    /// ordered control queue.
    Topology {
        change: Topology,
        raw: Box<RawValue>,
    },
    /// Negotiated graphics binary envelope; validated by the graphics owner.
    GraphicsBinary(Vec<u8>),
}
impl Event {
    /// The pane a delivery frame belongs to, and its payload size: what a
    /// reconnect costs per pane (card 0 of the reconnect plan).
    pub fn pane_bytes(&self) -> Option<(&str, usize)> {
        match self {
            Self::DeliveryReady { pane, negotiation } => Some((pane, negotiation.get().len())),
            Self::ProjectionEnvelope { pane, envelope } | Self::Envelope { pane, envelope } => {
                Some((pane, envelope.get().len()))
            }
            Self::Chunk { pane, data, .. } => Some((pane, data.len())),
            Self::BinaryChunk { pane, data, .. } => Some((pane, data.len())),
            Self::Ready(_) | Self::Control(_) | Self::Topology { .. } | Self::GraphicsBinary(_) => {
                None
            }
        }
    }
}

#[derive(Deserialize)]
struct Kind<'a> {
    #[serde(rename = "type", borrow)]
    kind: &'a str,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DeliveryReady {
    #[serde(rename = "type")]
    _kind: String,
    pane: String,
    negotiation: Box<RawValue>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Envelope {
    #[serde(rename = "type")]
    _kind: String,
    pane: String,
    envelope: Box<RawValue>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Chunk {
    #[serde(rename = "type")]
    _kind: String,
    pane: String,
    transaction_id: String,
    index: u8,
    data: String,
}

/// One frame of a stream whose pane set never changes (and the tests' entry).
#[cfg(test)]
pub(super) fn parse(text: &str, options: &ConnectOptions, verified: bool) -> Result<Event, Error> {
    parse_live(text, options, &mut Live::new(options), verified)
}
pub(super) fn parse_live(
    text: &str,
    options: &ConnectOptions,
    live: &mut Live,
    verified: bool,
) -> Result<Event, Error> {
    if text.len() > MAX_SERVER_BYTES {
        return Err(Error::FrameBound);
    }
    let kind: Kind<'_> = serde_json::from_str(text).map_err(Error::Json)?;
    if !verified {
        let ready: Ready = serde_json::from_str(text).map_err(Error::Json)?;
        let issued = &options.descriptor;
        if ready.kind != "ready"
            || ready.protocol_version != 2
            || ready.daemon_instance_id != issued.daemon_instance_id
            || ready.request_id != issued.request_id
            || ready.panes != issued.panes
            || ready.effective_viewer_mode != issued.effective_viewer_mode
            || !ready.diagnostic_capabilities.is_empty()
            || ready.input_lifetime == Some(false)
            || ready.input_bytes == Some(false)
            || ready.topology_in_place == Some(false)
            || (issued.effective_viewer_mode == ViewerMode::Interactive
                && ready.connection_client_id.as_deref() != Some(&options.host_client_id))
            || ready
                .connection_client_id
                .as_ref()
                .is_some_and(|id| id != &options.host_client_id)
        {
            return Err(Error::Identity);
        }
        // An otherwise exact peer that omits the field predates capability 105.
        if issued.effective_viewer_mode == ViewerMode::Interactive && ready.input_lifetime.is_none()
        {
            return Err(Error::DaemonTooOld);
        }
        live.in_place = ready.topology_in_place == Some(true);
        return Ok(Event::Ready(ready));
    }
    if kind.kind == "topology" {
        let change = Topology::parse(text)?;
        live.follow(&change)?;
        let raw = serde_json::from_str(text).map_err(Error::Json)?;
        return Ok(Event::Topology { change, raw });
    }
    let delivery = match kind.kind {
        "terminal-delivery-ready" => {
            let frame: DeliveryReady = serde_json::from_str(text).map_err(Error::Json)?;
            Some(Event::DeliveryReady {
                pane: frame.pane,
                negotiation: frame.negotiation,
            })
        }
        "terminal-projection-envelope" => {
            let frame: Envelope = serde_json::from_str(text).map_err(Error::Json)?;
            Some(Event::ProjectionEnvelope {
                pane: frame.pane,
                envelope: frame.envelope,
            })
        }
        "terminal-delivery-envelope" => {
            let frame: Envelope = serde_json::from_str(text).map_err(Error::Json)?;
            Some(Event::Envelope {
                pane: frame.pane,
                envelope: frame.envelope,
            })
        }
        "terminal-delivery-chunk" => {
            let frame: Chunk = serde_json::from_str(text).map_err(Error::Json)?;
            if uuid::Uuid::parse_str(&frame.transaction_id).is_err()
                || frame.data.len() > (256 * 1024_usize).div_ceil(3) * 4
            {
                return Err(Error::FrameBound);
            }
            Some(Event::Chunk {
                pane: frame.pane,
                transaction_id: frame.transaction_id,
                index: frame.index,
                data: frame.data,
            })
        }
        _ => None,
    };
    if let Some(delivery) = delivery {
        let pane = match &delivery {
            Event::DeliveryReady { pane, .. }
            | Event::ProjectionEnvelope { pane, .. }
            | Event::Envelope { pane, .. }
            | Event::Chunk { pane, .. } => pane,
            _ => return Err(Error::Frame),
        };
        if !live.panes.contains(pane) {
            return Err(Error::Identity);
        }
        return Ok(delivery);
    }
    if matches!(
        kind.kind,
        "terminal-surface-available"
            | "terminal-surface-peer"
            | "terminal-surface-offer"
            | "terminal-surface-fallback"
    ) && text.len() > crate::tmux_graphics::surface_control::MAX_CONTROL_BYTES
    {
        return Err(Error::FrameBound);
    }
    if !matches!(
        kind.kind,
        "terminal-delivery-fault"
            | "terminal-graphics"
            | "terminal-graphics-blob"
            | "terminal-graphics-local"
            | "terminal-surface-available"
            | "terminal-surface-peer"
            | "terminal-surface-offer"
            | "terminal-surface-fallback"
            | "layout"
            | "layout-snapshot"
            | "authority-snapshot"
            | "authority-receipt"
            | "input-ack"
            | "viewport-ack"
            | "semantic-intent-ack"
            | "error"
    ) {
        return Err(Error::Frame);
    }
    Ok(Event::Control(
        serde_json::from_str(text).map_err(Error::Json)?,
    ))
}

pub(super) fn redeem(options: &ConnectOptions) -> Result<String, Error> {
    serde_json::to_string(&serde_json::json!({
        "type":"redeem", "protocolVersion":2,
        "ticket":options.descriptor.redemption_ticket,
        "requestId":options.descriptor.request_id,
        "daemonInstanceId":options.descriptor.daemon_instance_id,
    }))
    .map_err(Error::Json)
}

#[cfg(test)]
pub(super) fn parse_binary(bytes: &[u8], options: &ConnectOptions) -> Result<Event, Error> {
    parse_binary_live(bytes, &Live::new(options))
}
pub(super) fn parse_binary_live(bytes: &[u8], live: &Live) -> Result<Event, Error> {
    if bytes.starts_with(b"TGB1") || bytes.starts_with(b"TGB2") {
        if bytes.len() > 8 + 4096 + 512 * 1024 {
            return Err(Error::FrameBound);
        }
        return Ok(Event::GraphicsBinary(bytes.to_vec()));
    }
    if bytes.len() < 8 || !bytes.starts_with(b"TDC1") {
        return Err(Error::Frame);
    }
    let length = u32::from_be_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]) as usize;
    if length == 0
        || length > 4096
        || bytes.len() < 8 + length
        || bytes.len() - 8 - length > 256 * 1024
    {
        return Err(Error::FrameBound);
    }
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields, rename_all = "camelCase")]
    struct Header {
        pane: String,
        transaction_id: String,
        index: u8,
    }
    let header: Header = serde_json::from_slice(&bytes[8..8 + length]).map_err(Error::Json)?;
    if !valid_pane(&header.pane)
        || !live.panes.contains(&header.pane)
        || uuid::Uuid::parse_str(&header.transaction_id).is_err()
        || header.index >= 64
    {
        return Err(Error::Identity);
    }
    Ok(Event::BinaryChunk {
        pane: header.pane,
        transaction_id: header.transaction_id,
        index: header.index,
        data: bytes[8 + length..].to_vec(),
    })
}
