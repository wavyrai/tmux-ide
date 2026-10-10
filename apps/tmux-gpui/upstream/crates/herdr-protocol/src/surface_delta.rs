//! Adapted from herdr src/protocol/surface_delta.rs and surface_delta/decode.rs
//! (Apache-2.0, see NOTICE.md). Modified: serde decoding under the shared
//! bincode byte limit, followed by the same structural limits and baseline
//! checks; no encoder.
//!
//! A recomputed surface (for example after a projection change) is sent as its
//! metadata plus only the cell spans that differ from the previous surface.

use crate::{
    CellData, ClientShellPopupSurface, Error, FrameData, MAX_FRAME_SIZE, MAX_GRAPHICS_FRAME_SIZE,
    PaneSurfaceFrame, PaneSurfacePatchRow, Result, decode_payload, encode_message,
};
use base64::{Engine as _, engine::general_purpose::STANDARD_NO_PAD};
use serde::{Deserialize, Serialize};

pub const CAPABILITY: &str = "surface_delta";
pub const MESSAGE_KIND: &str = "endpoint.surface-delta.v1";
pub const MAX_SPANS: usize = 4096;
// Practical protocol limits; a sender that exceeds one uses the full surface.
const MAX_GRID_DIMENSION: u16 = 4096;
const MAX_GRID_CELLS: usize = 1_000_000;

/// Binary layout frozen with [`MESSAGE_KIND`]; field order is the contract.
/// `surface` carries metadata with empty cell grids.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SurfaceDelta {
    pub base_projection_revision: u64,
    pub base_surface_revision: u64,
    pub surface: PaneSurfaceFrame,
    pub rows: Vec<PaneSurfacePatchRow>,
    pub popup_cells: Option<GridUpdate>,
}

/// Variant order is the contract.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum GridUpdate {
    Patch(Vec<PaneSurfacePatchRow>),
    Replace(Vec<CellData>),
}

fn grid_cells(width: u16, height: u16) -> Result<usize> {
    let cells = usize::from(width) * usize::from(height);
    if width > MAX_GRID_DIMENSION || height > MAX_GRID_DIMENSION || cells > MAX_GRID_CELLS {
        return Err(Error::DeltaGridLimit);
    }
    Ok(cells)
}

/// Spans must be nonempty, inside their row, strictly ordered without overlap,
/// and within the grid's cell budget.
fn check_rows(rows: &[PaneSurfacePatchRow], width: u16, height: u16) -> Result<()> {
    let budget = grid_cells(width, height)?;
    if rows.len() > MAX_SPANS.min(budget) {
        return Err(Error::DeltaSpan);
    }
    let (mut previous_end, mut total) = (0usize, 0usize);
    for row in rows {
        let (x, len) = (usize::from(row.x), row.cells.len());
        if len == 0 || row.y >= height || x >= usize::from(width) || len > usize::from(width) - x {
            return Err(Error::DeltaSpan);
        }
        let start = usize::from(row.y) * usize::from(width) + x;
        total += len;
        if start < previous_end || total > budget {
            return Err(Error::DeltaSpan);
        }
        previous_end = start + len;
    }
    Ok(())
}

fn check_metadata(frame: &FrameData) -> Result<()> {
    grid_cells(frame.width, frame.height)?;
    if !frame.cells.is_empty() {
        return Err(Error::DeltaMetadataCells);
    }
    Ok(())
}

/// Decodes one delta and checks everything that does not need the baseline.
pub fn decode(data: &str) -> Result<SurfaceDelta> {
    // The data string is itself bounded by the outer graphics frame cap.
    if data.len() > MAX_GRAPHICS_FRAME_SIZE {
        return Err(Error::EncodingLimit);
    }
    let delta: SurfaceDelta = decode_payload(&STANDARD_NO_PAD.decode(data)?)?;
    let surface = &delta.surface;
    let graphics = &surface.graphics;
    // Only a delta that carries graphics may use the larger frame cap.
    if data.len() > MAX_FRAME_SIZE
        && graphics.assets.is_empty()
        && graphics.placements.is_empty()
        && graphics.retained_assets.is_empty()
    {
        return Err(Error::EncodingLimit);
    }
    check_metadata(&surface.frame)?;
    check_rows(&delta.rows, surface.frame.width, surface.frame.height)?;
    match (surface.popup.as_deref(), &delta.popup_cells) {
        (None, Some(_)) => return Err(Error::DeltaPopup),
        (Some(popup), update) => {
            check_metadata(&popup.frame)?;
            let (width, height) = (popup.frame.width, popup.frame.height);
            match update {
                Some(GridUpdate::Patch(rows)) => check_rows(rows, width, height)?,
                Some(GridUpdate::Replace(cells)) if cells.len() != grid_cells(width, height)? => {
                    return Err(Error::DeltaPopup);
                }
                Some(GridUpdate::Replace(_)) => {}
                None => return Err(Error::DeltaPopup),
            }
        }
        (None, None) => {}
    }
    Ok(delta)
}

fn apply_rows(cells: &mut [CellData], width: u16, rows: Vec<PaneSurfacePatchRow>) {
    for row in rows {
        let start = usize::from(row.y) * usize::from(width) + usize::from(row.x);
        cells[start..start + row.cells.len()].clone_from_slice(&row.cells);
    }
}

fn same_popup_grid(previous: &ClientShellPopupSurface, next: &ClientShellPopupSurface) -> bool {
    previous.terminal_id == next.terminal_id
        && previous.frame.width == next.frame.width
        && previous.frame.height == next.frame.height
        && previous.frame.cells.len()
            == usize::from(next.frame.width) * usize::from(next.frame.height)
}

impl SurfaceDelta {
    /// The `EndpointControl` data a sender would emit; used by mock peers.
    pub fn encode(&self) -> Result<String> {
        let bytes = encode_message(self, MAX_GRAPHICS_FRAME_SIZE)?;
        Ok(STANDARD_NO_PAD.encode(&bytes[4..]))
    }

    /// Rebuilds the complete next surface from the retained `base`. The result
    /// still needs the ordinary [`FrameData::validate`] before it is accepted.
    pub fn reconstruct(self, base: &PaneSurfaceFrame) -> Result<PaneSurfaceFrame> {
        let mut surface = self.surface;
        let (width, height) = (base.frame.width, base.frame.height);
        if surface.boot_id != base.boot_id
            || self.base_projection_revision != base.projection_revision
            || self.base_surface_revision != base.surface_revision
            || base.surface_revision.checked_add(1) != Some(surface.surface_revision)
            || surface.projection_revision < base.projection_revision
            || (surface.frame.width, surface.frame.height) != (width, height)
            || base.frame.cells.len() != usize::from(width) * usize::from(height)
        {
            return Err(Error::SurfaceBaseline);
        }
        match (surface.popup.as_deref_mut(), self.popup_cells) {
            (None, None) => {}
            (Some(popup), Some(GridUpdate::Replace(cells))) => popup.frame.cells = cells,
            (Some(popup), Some(GridUpdate::Patch(rows))) => {
                let previous = base
                    .popup
                    .as_deref()
                    .filter(|previous| same_popup_grid(previous, popup))
                    .ok_or(Error::DeltaPopup)?;
                popup.frame.cells.clone_from(&previous.frame.cells);
                apply_rows(&mut popup.frame.cells, popup.frame.width, rows);
            }
            _ => return Err(Error::DeltaPopup),
        }
        surface.frame.cells.clone_from(&base.frame.cells);
        apply_rows(&mut surface.frame.cells, width, self.rows);
        Ok(surface)
    }
}
