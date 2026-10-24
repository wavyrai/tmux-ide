//! Connection-scoped Kitty side channel. Decode once in Rust; verify before the final chunk.
mod binary;
pub(crate) mod local;
mod placeholders;
pub use local::LocalImages;
mod wire;
use crate::tmux_native_session::CommittedPane;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::Deserialize;
use serde_json::value::RawValue;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    time::{Duration, Instant},
};
pub use wire::{Blob, Format, Image, ImageMetadata, KeyedPlacement, Placement, State};

pub const MAX_IMAGE_BYTES: usize = 64 * 1024 * 1024;
pub const CHUNK_BYTES: usize = 512 * 1024;
const MAX_HELD: usize = 8192;
const MAX_PARTIALS: usize = 16;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(3);
const PARTIAL_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(thiserror::Error)]
pub enum Error {
    #[error("invalid native graphics JSON")]
    Json(#[source] serde_json::Error),
    #[error("native graphics metadata mismatch")]
    Metadata,
    #[error("native graphics bounds exceeded")]
    Bounds,
    #[error("native graphics identity mismatch")]
    Identity,
    #[error("native graphics lifetime changed; fresh connection required")]
    Lifetime,
    #[error("native graphics ordering mismatch")]
    Ordering,
    #[error("native graphics digest mismatch")]
    Digest,
    #[error("invalid native graphics base64")]
    Base64(#[source] base64::DecodeError),
    #[error("native graphics retired")]
    Retired,
}
impl std::fmt::Debug for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        std::fmt::Display::fmt(self, f)
    }
}

pub struct ImageChunk {
    pub metadata: ImageMetadata,
    pub bytes: Vec<u8>,
    /// Earlier chunks are partial only. Never paint until this verified final chunk arrives.
    pub complete_verified: bool,
}
#[derive(Debug)]
pub struct Request {
    pub pane: String,
    pub digests: Vec<String>,
}
#[derive(Default)]
pub struct GraphicsUpdate {
    pub handled: bool,
    pub state_changed: bool,
    pub requests: Vec<Request>,
    pub chunk: Option<ImageChunk>,
    pub invalidated: Vec<String>,
}
pub struct PanePlacements {
    pub placements: Vec<KeyedPlacement>,
    pub requests: Vec<Request>,
}
struct Pane {
    incarnation: Option<String>,
    tombstone: bool,
    state: Option<State>,
    visible: BTreeSet<u32>,
    resolver: placeholders::Resolver,
}
struct Partial {
    pane: String,
    metadata: Blob,
    received: usize,
    hash: Sha256,
    updated: Instant,
}
struct Held {
    touched: u64,
    started: Instant,
    complete: bool,
}
pub struct Graphics {
    generation: String,
    panes: BTreeMap<String, Pane>,
    partials: BTreeMap<String, Partial>,
    held: BTreeMap<String, Held>,
    tick: u64,
    retired: bool,
    next_expiry: Option<Instant>,
}

impl Graphics {
    pub fn new(generation: String, issued_panes: Vec<String>) -> Result<Self, Error> {
        if uuid::Uuid::parse_str(&generation).is_err()
            || issued_panes.is_empty()
            || issued_panes.len() > 24
        {
            return Err(Error::Identity);
        }
        let mut panes = BTreeMap::new();
        for pane in issued_panes {
            if pane.is_empty() || pane.len() > 128 || panes.contains_key(&pane) {
                return Err(Error::Identity);
            }
            panes.insert(
                pane,
                Pane {
                    incarnation: None,
                    tombstone: false,
                    state: None,
                    visible: BTreeSet::new(),
                    resolver: placeholders::Resolver::default(),
                },
            );
        }
        Ok(Self {
            generation,
            panes,
            partials: BTreeMap::new(),
            held: BTreeMap::new(),
            tick: 0,
            retired: false,
            next_expiry: None,
        })
    }

    /// Bind only from a validated canonical commit. A changed lifetime requires fresh wire scope.
    pub fn bind(&mut self, pane: &str, committed: &CommittedPane) -> Result<Vec<String>, Error> {
        if self.retired {
            return Err(Error::Retired);
        }
        if committed.identity.generation != self.generation {
            self.retire();
            return Err(Error::Identity);
        }
        let state = self.panes.get_mut(pane).ok_or(Error::Identity)?;
        if state
            .incarnation
            .as_ref()
            .is_some_and(|old| old != &committed.identity.incarnation)
        {
            self.retire();
            return Err(Error::Lifetime);
        }
        if state.incarnation.is_none() {
            state.incarnation = Some(committed.identity.incarnation.clone());
        }
        if committed.snapshot.is_some() {
            return Ok(Vec::new());
        }
        state.tombstone = true;
        state.state = None;
        state.visible.clear();
        state.resolver = placeholders::Resolver::default();
        let invalidated = self
            .partials
            .iter()
            .filter(|(_, partial)| partial.pane == pane)
            .map(|(digest, _)| digest.clone())
            .collect::<Vec<_>>();
        self.missing(&invalidated);
        Ok(invalidated)
    }

    pub fn accept_control(
        &mut self,
        raw: &RawValue,
        now: Instant,
    ) -> Result<GraphicsUpdate, Error> {
        if self.retired {
            return Err(Error::Retired);
        }
        if raw.get().len() > 1024 * 1024 {
            return Err(Error::Bounds);
        }
        #[derive(Deserialize)]
        struct Kind<'a> {
            #[serde(rename = "type", borrow)]
            kind: &'a str,
        }
        let kind: Kind<'_> = serde_json::from_str(raw.get()).map_err(Error::Json)?;
        match kind.kind {
            "terminal-graphics" => {
                #[derive(Deserialize)]
                #[serde(deny_unknown_fields)]
                struct Frame {
                    #[serde(rename = "type")]
                    _kind: String,
                    pane: String,
                    state: State,
                }
                let frame: Frame = serde_json::from_str(raw.get()).map_err(Error::Json)?;
                frame.state.validate()?;
                // Content-addressed cache entries must never acquire contradictory dimensions.
                let mut metadata = self
                    .panes
                    .values()
                    .filter_map(|pane| pane.state.as_ref())
                    .flat_map(|state| &state.images)
                    .map(|image| {
                        (
                            image.digest.as_str(),
                            (image.format, image.width, image.height, image.bytes),
                        )
                    })
                    .collect::<BTreeMap<_, _>>();
                for image in &frame.state.images {
                    let new = (image.format, image.width, image.height, image.bytes);
                    if metadata
                        .insert(&image.digest, new)
                        .is_some_and(|old| old != new)
                    {
                        return Err(Error::Metadata);
                    }
                }
                let pane = self.panes.get_mut(&frame.pane).ok_or(Error::Identity)?;
                if pane.tombstone {
                    return Ok(GraphicsUpdate {
                        handled: true,
                        ..Default::default()
                    });
                }
                if let Some(old) = &pane.state {
                    if frame.state.revision < old.revision {
                        return Ok(GraphicsUpdate {
                            handled: true,
                            ..Default::default()
                        });
                    }
                    if frame.state.revision == old.revision {
                        // The daemon revision tracks the image store, not the
                        // viewport. Scrolling can reproject cursor placements
                        // without changing image bytes or negotiated capabilities.
                        if frame.state.images != old.images
                            || frame.state.cell_pixels != old.cell_pixels
                            || frame.state.precise_cell_pixels != old.precise_cell_pixels
                            || frame.state.binary_blobs != old.binary_blobs
                            || frame.state.local_files != old.local_files
                        {
                            return Err(Error::Ordering);
                        }
                        if frame.state.placements == old.placements {
                            return Ok(GraphicsUpdate {
                                handled: true,
                                ..Default::default()
                            });
                        }
                    }
                }
                let visible = frame
                    .state
                    .images
                    .iter()
                    .filter(|image| pane.visible.contains(&image.image_id))
                    .map(|image| image.digest.clone())
                    .collect::<Vec<_>>();
                pane.state = Some(frame.state);
                let requests = self.request(&frame.pane, visible, now);
                Ok(GraphicsUpdate {
                    handled: true,
                    state_changed: true,
                    requests,
                    ..Default::default()
                })
            }
            "terminal-graphics-blob" => {
                #[derive(Deserialize)]
                #[serde(deny_unknown_fields)]
                struct Frame {
                    #[serde(rename = "type")]
                    _kind: String,
                    pane: String,
                    blob: Blob,
                    data: String,
                }
                let frame: Frame = serde_json::from_str(raw.get()).map_err(Error::Json)?;
                if frame.data.len() > CHUNK_BYTES.div_ceil(3) * 4 {
                    return Err(Error::Bounds);
                }
                let bytes = STANDARD.decode(frame.data).map_err(Error::Base64)?;
                self.blob(&frame.pane, frame.blob, bytes, now)
            }
            _ => Ok(GraphicsUpdate::default()),
        }
    }

    fn blob(
        &mut self,
        pane_id: &str,
        blob: Blob,
        bytes: Vec<u8>,
        now: Instant,
    ) -> Result<GraphicsUpdate, Error> {
        if bytes.is_empty() || bytes.len() > CHUNK_BYTES {
            return Err(Error::Bounds);
        }
        let pane = self.panes.get(pane_id).ok_or(Error::Identity)?;
        if pane.tombstone || pane.incarnation.is_none() {
            return Ok(GraphicsUpdate {
                handled: true,
                ..Default::default()
            });
        }
        let Some(image) = pane.state.as_ref().and_then(|state| {
            state
                .images
                .iter()
                .find(|image| image.digest == blob.digest)
        }) else {
            // A transfer superseded by a registry update has no current placement authority.
            self.missing(std::slice::from_ref(&blob.digest));
            return Ok(GraphicsUpdate {
                handled: true,
                invalidated: vec![blob.digest],
                ..Default::default()
            });
        };
        if !blob.matches(image) || blob.offset + bytes.len() > blob.total {
            return Err(Error::Metadata);
        }
        let image_key = stable_key(
            &self.generation,
            pane_id,
            pane.incarnation.as_deref().ok_or(Error::Identity)?,
            image.image_id,
        );
        // A shared content digest may be pushed by two panes concurrently. One
        // ordered transfer owns assembly; the other cannot reset its partial image.
        if self
            .partials
            .get(&blob.digest)
            .is_some_and(|partial| partial.pane != pane_id)
        {
            return Ok(GraphicsUpdate {
                handled: true,
                ..Default::default()
            });
        }
        let mut invalidated = Vec::new();
        if blob.offset == 0 {
            self.partials.remove(&blob.digest);
            while self.partials.len() >= MAX_PARTIALS
                || self
                    .partials
                    .values()
                    .map(|p| p.metadata.total)
                    .sum::<usize>()
                    + blob.total
                    > MAX_IMAGE_BYTES
            {
                let Some(oldest) = self
                    .partials
                    .iter()
                    .min_by_key(|(_, p)| p.updated)
                    .map(|(digest, _)| digest.clone())
                else {
                    return Err(Error::Bounds);
                };
                self.partials.remove(&oldest);
                self.held.remove(&oldest);
                invalidated.push(oldest);
            }
            self.partials.insert(
                blob.digest.clone(),
                Partial {
                    pane: pane_id.into(),
                    metadata: blob.clone(),
                    received: 0,
                    hash: Sha256::new(),
                    updated: now,
                },
            );
        }
        let partial = self.partials.get_mut(&blob.digest).ok_or(Error::Ordering)?;
        if partial.pane != pane_id
            || partial.received != blob.offset
            || partial.metadata.total != blob.total
            || partial.metadata.width != blob.width
            || partial.metadata.height != blob.height
            || partial.metadata.format != blob.format
        {
            self.partials.remove(&blob.digest);
            self.held.remove(&blob.digest);
            return Err(Error::Ordering);
        }
        partial.hash.update(&bytes);
        partial.received += bytes.len();
        partial.updated = now;
        let complete = partial.received == blob.total;
        if complete {
            let partial = self.partials.remove(&blob.digest).ok_or(Error::Ordering)?;
            let digest = digest_hex(&partial.hash.finalize());
            if digest != blob.digest {
                self.held.remove(&blob.digest);
                return Err(Error::Digest);
            }
        }
        self.remember(&blob.digest, complete, now);
        Ok(GraphicsUpdate {
            handled: true,
            chunk: Some(ImageChunk {
                metadata: ImageMetadata {
                    blob,
                    image: image_key,
                },
                bytes,
                complete_verified: complete,
            }),
            invalidated,
            ..Default::default()
        })
    }

    pub fn placements(
        &mut self,
        pane_id: &str,
        committed: &CommittedPane,
        now: Instant,
    ) -> Result<PanePlacements, Error> {
        self.bind(pane_id, committed)?;
        let pane = self.panes.get_mut(pane_id).ok_or(Error::Identity)?;
        let Some(snapshot) = &committed.snapshot else {
            return Ok(PanePlacements {
                placements: Vec::new(),
                requests: Vec::new(),
            });
        };
        let Some(state) = &pane.state else {
            return Ok(PanePlacements {
                placements: Vec::new(),
                requests: Vec::new(),
            });
        };
        let resolved = pane.resolver.resolve(snapshot, state)?;
        pane.visible.clear();
        let placements = resolved
            .into_iter()
            .filter_map(|(placement, image_id)| {
                let placement = placement.clipped(snapshot.rows, snapshot.cols)?;
                pane.visible.insert(image_id);
                Some(KeyedPlacement {
                    placement,
                    image: stable_key(
                        &self.generation,
                        pane_id,
                        &committed.identity.incarnation,
                        image_id,
                    ),
                })
            })
            .collect::<Vec<_>>();
        let requests = self.request(
            pane_id,
            placements
                .iter()
                .map(|p| p.placement.digest.clone())
                .collect(),
            now,
        );
        Ok(PanePlacements {
            placements,
            requests,
        })
    }

    fn request(&mut self, pane: &str, digests: Vec<String>, now: Instant) -> Vec<Request> {
        let missing = digests
            .into_iter()
            .collect::<BTreeSet<_>>()
            .into_iter()
            .filter(|digest| !self.held.contains_key(digest))
            .collect::<Vec<_>>();
        for digest in &missing {
            self.remember(digest, false, now);
        }
        missing
            .chunks(64)
            .map(|digests| Request {
                pane: pane.into(),
                digests: digests.to_vec(),
            })
            .collect()
    }
    fn remember(&mut self, digest: &str, complete: bool, now: Instant) {
        self.tick = self.tick.saturating_add(1);
        self.held.insert(
            digest.into(),
            Held {
                touched: self.tick,
                started: now,
                complete,
            },
        );
        if !complete {
            let deadline = self
                .partials
                .get(digest)
                .map_or(now + REQUEST_TIMEOUT, |partial| {
                    partial.updated + PARTIAL_TIMEOUT
                });
            self.next_expiry = Some(self.next_expiry.map_or(deadline, |old| old.min(deadline)));
        }
        while self.held.len() > MAX_HELD {
            if let Some(oldest) = self
                .held
                .iter()
                .min_by_key(|(_, held)| held.touched)
                .map(|(digest, _)| digest.clone())
            {
                self.held.remove(&oldest);
            } else {
                break;
            }
        }
    }
    pub fn missing(&mut self, digests: &[String]) {
        for digest in digests {
            self.held.remove(digest);
            self.partials.remove(digest);
        }
        if self.held.is_empty() {
            self.next_expiry = None;
        }
    }
    /// Cached conservative alarm: completing a transfer can leave one harmless early wake.
    /// The deadline is recomputed only at maintenance, never for each terminal event.
    pub(crate) fn next_expiry(&self) -> Option<Instant> {
        self.next_expiry
    }
    pub fn expire(&mut self, now: Instant) -> Vec<String> {
        let expired = self
            .held
            .iter()
            .filter(|(digest, held)| {
                !held.complete
                    && self.partials.get(*digest).map_or_else(
                        || now.saturating_duration_since(held.started) >= REQUEST_TIMEOUT,
                        |partial| now.saturating_duration_since(partial.updated) >= PARTIAL_TIMEOUT,
                    )
            })
            .map(|(digest, _)| digest.clone())
            .collect::<Vec<_>>();
        self.missing(&expired);
        self.next_expiry = self
            .held
            .iter()
            .filter(|(_, held)| !held.complete)
            .map(|(digest, held)| {
                self.partials
                    .get(digest)
                    .map_or(held.started + REQUEST_TIMEOUT, |partial| {
                        partial.updated + PARTIAL_TIMEOUT
                    })
            })
            .min();
        expired
    }
    pub fn takes_cell_pixels(&self) -> bool {
        self.panes
            .values()
            .filter_map(|pane| pane.state.as_ref())
            .any(|state| state.cell_pixels == Some(true))
    }
    pub fn takes_precise_cell_pixels(&self) -> bool {
        self.panes
            .values()
            .filter_map(|pane| pane.state.as_ref())
            .any(|state| state.precise_cell_pixels == Some(true))
    }
    pub fn retire(&mut self) {
        self.retired = true;
        self.panes.clear();
        self.held.clear();
        self.partials.clear();
        self.next_expiry = None;
    }
}
fn stable_key(generation: &str, pane: &str, incarnation: &str, image_id: u32) -> String {
    let mut hash = Sha256::new();
    for value in [generation, pane, incarnation] {
        hash.update(value.as_bytes());
        hash.update([0]);
    }
    format!("tmux:{}#{image_id}", digest_hex(&hash.finalize()))
}

fn digest_hex(bytes: &[u8]) -> String {
    const HEX: &[u8] = b"0123456789abcdef";
    let mut output = String::with_capacity(32);
    for byte in bytes.iter().take(16) {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 15) as usize] as char);
    }
    output
}

#[cfg(test)]
mod tests;
