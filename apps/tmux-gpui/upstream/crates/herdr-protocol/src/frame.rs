//! Surface frame invariants: cell/cursor/hyperlink validation and the atomic
//! patch application that keeps a projection consistent or rejects it whole.

use crate::{Error, FrameData, PaneSurfaceFrame, PaneSurfacePatch, Result};

impl FrameData {
    pub fn validate(&self) -> Result<()> {
        if self.cells.len() != usize::from(self.width) * usize::from(self.height) {
            return Err(Error::CellCount);
        }
        if self.cells.iter().any(|c| {
            c.hyperlink
                .is_some_and(|i| i as usize >= self.hyperlinks.len())
        }) {
            return Err(Error::HyperlinkIndex);
        }
        if self
            .cursor
            .as_ref()
            .is_some_and(|c| c.visible && (c.x >= self.width || c.y >= self.height))
        {
            return Err(Error::CursorBounds);
        }
        Ok(())
    }
}

impl PaneSurfaceFrame {
    /// Apply baseline cell patches atomically. Optional codecs expand into this
    /// same validation and commit, so every encoding shares one set of bounds.
    pub fn apply_patch(&mut self, patch: PaneSurfacePatch) -> Result<()> {
        self.validate_patch(&patch)?;
        self.commit_patch(patch);
        Ok(())
    }

    /// Every check that can reject `patch`, without touching the frame.
    pub(crate) fn validate_patch(&self, patch: &PaneSurfacePatch) -> Result<()> {
        if patch.boot_id != self.boot_id
            || patch.projection_revision != self.projection_revision
            || patch.base_surface_revision != self.surface_revision
            || self.surface_revision.checked_add(1) != Some(patch.surface_revision)
            || self.popup.is_some()
        {
            return Err(Error::PatchIdentity);
        }
        self.frame.validate()?;
        for row in &patch.rows {
            if row.y >= self.frame.height
                || usize::from(row.x) + row.cells.len() > usize::from(self.frame.width)
                || row.cells.iter().any(|c| {
                    c.hyperlink
                        .is_some_and(|i| i as usize >= self.frame.hyperlinks.len())
                })
            {
                return Err(Error::PatchRowBounds);
            }
        }
        for pane in &patch.panes {
            if !self.panes.iter().any(|p| {
                p.pane_id == pane.pane_id && p.rect == pane.rect && p.inner_rect == pane.inner_rect
            }) {
                return Err(Error::PatchGeometry);
            }
        }
        if patch
            .cursor
            .as_ref()
            .is_some_and(|c| c.visible && (c.x >= self.frame.width || c.y >= self.frame.height))
        {
            return Err(Error::PatchCursorBounds);
        }
        Ok(())
    }

    /// Commits a patch that [`Self::validate_patch`] accepted.
    pub(crate) fn commit_patch(&mut self, patch: PaneSurfacePatch) {
        for row in patch.rows {
            let start = usize::from(row.y) * usize::from(self.frame.width) + usize::from(row.x);
            self.frame.cells[start..start + row.cells.len()].clone_from_slice(&row.cells);
        }
        for pane in patch.panes {
            if let Some(existing) = self.panes.iter_mut().find(|p| p.pane_id == pane.pane_id) {
                *existing = pane;
            }
        }
        self.frame.cursor = patch.cursor;
        self.surface_revision = patch.surface_revision;
    }
}
