//! Adapted from herdr src/protocol/surface_reuse.rs (Apache-2.0, see NOTICE.md).
//! Modified: receiver only, with typed errors.
//!
//! A recomputed surface whose cells are all unchanged is sent as JSON metadata
//! with an empty cell grid, and the receiver keeps its retained cells.

use crate::{Error, MAX_FRAME_SIZE, PaneSurfaceFrame, Result};
use serde::{Deserialize, Serialize};

pub const CAPABILITY: &str = "surface_reuse";
pub const MESSAGE_KIND: &str = "endpoint.surface-reuse.v1";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SurfaceReuse {
    pub base_surface_revision: u64,
    pub surface: PaneSurfaceFrame,
}

pub fn decode(data: &str) -> Result<SurfaceReuse> {
    // The sender falls back to a full surface above the ordinary frame cap.
    if data.len() > MAX_FRAME_SIZE {
        return Err(Error::EncodingLimit);
    }
    Ok(serde_json::from_str(data)?)
}

impl SurfaceReuse {
    /// The `EndpointControl` data a sender would emit; used by mock peers.
    pub fn encode(&self) -> Result<String> {
        Ok(serde_json::to_string(self)?)
    }

    /// Rebuilds the complete next surface from the retained `base`. The result
    /// still needs the ordinary [`crate::FrameData::validate`] before it is accepted.
    pub fn reconstruct(self, base: &PaneSurfaceFrame) -> Result<PaneSurfaceFrame> {
        let mut surface = self.surface;
        if surface.boot_id != base.boot_id
            || self.base_surface_revision != base.surface_revision
            || base.surface_revision.checked_add(1) != Some(surface.surface_revision)
            || surface.projection_revision < base.projection_revision
            || surface.frame.width != base.frame.width
            || surface.frame.height != base.frame.height
            || !surface.frame.cells.is_empty()
        {
            return Err(Error::SurfaceBaseline);
        }
        surface.frame.cells.clone_from(&base.frame.cells);
        Ok(surface)
    }
}
