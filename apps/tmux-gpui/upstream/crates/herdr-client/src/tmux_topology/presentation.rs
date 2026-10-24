use super::{Error, ModeKeys, Topology};
use crate::{
    tmux_delivery::{Cursor, Modes},
    tmux_native_session::CommittedPane,
};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
};

#[derive(Debug)]
pub struct Region {
    pub pane: String,
    pub left: usize,
    pub top: usize,
    pub width: usize,
    pub height: usize,
    pub content_top: usize,
    pub content_rows: usize,
    pub source: Arc<CommittedPane>,
}
#[derive(Debug)]
pub struct CopyRegion {
    pub pane: String,
    pub left: usize,
    pub top: usize,
    pub width: usize,
    pub height: usize,
    pub wrapped: Vec<bool>,
}
#[derive(Debug)]
pub struct WindowPaint {
    pub window: String,
    pub selected_pane: String,
    pub cols: usize,
    pub rows: usize,
    pub regions: Vec<Region>,
    pub copy_region: CopyRegion,
    pub cursor: Cursor,
    pub modes: Modes,
    pub mode_keys: Option<ModeKeys>,
    pub zoomed: bool,
}
pub struct PresentedWindow {
    pub paint: Arc<WindowPaint>,
    /// Geometry/content agree. This is not an input lease or a topology mutation grant.
    pub coherent: bool,
}
struct Cached {
    generation: String,
    window: String,
    membership: BTreeMap<String, String>,
    paint: Arc<WindowPaint>,
}
pub struct Presentation {
    selected: String,
    cached: Option<Cached>,
}
impl Presentation {
    pub fn new(selected_pane: String) -> Result<Self, Error> {
        if !super::wire::identity(&selected_pane) {
            return Err(Error::Identity);
        }
        Ok(Self {
            selected: selected_pane,
            cached: None,
        })
    }
    pub fn reset(&mut self) {
        self.cached = None;
    }

    /// Call on each topology/commit/status change. The map must contain only current session proofs.
    pub fn update(
        &mut self,
        topology: &Topology,
        current: &BTreeMap<String, Arc<CommittedPane>>,
        allow_retention: bool,
    ) -> Result<Option<PresentedWindow>, Error> {
        if !allow_retention {
            self.reset();
        }
        let result = self.present(topology, current, allow_retention);
        if result.is_err() || matches!(result, Ok(None)) {
            self.reset();
        }
        result
    }
    fn present(
        &mut self,
        topology: &Topology,
        current: &BTreeMap<String, Arc<CommittedPane>>,
        allow_retention: bool,
    ) -> Result<Option<PresentedWindow>, Error> {
        if topology.retired {
            return Err(Error::Retired);
        }
        let mut candidates = topology.layouts.values().filter(|layout| {
            layout
                .panes
                .iter()
                .any(|pane| pane.pane.as_deref() == Some(&self.selected))
        });
        let Some(layout) = candidates.next() else {
            return Ok(None);
        };
        if candidates.next().is_some() {
            return Err(Error::Identity);
        }
        let window = layout.semantic_window_id.as_ref().ok_or(Error::Identity)?;
        if layout.cols > 1000
            || layout.rows > 500
            || layout.panes.is_empty()
            || layout.panes.len() > 24
        {
            return Err(Error::Bounds);
        }
        let mut seen = BTreeSet::new();
        let mut membership = BTreeMap::new();
        let mut skew = false;
        let mut regions = Vec::new();
        for (index, pane) in layout.panes.iter().enumerate() {
            let id = pane.pane.as_ref().ok_or(Error::Identity)?;
            if !seen.insert(id) || !topology.issued.contains(id) {
                return Err(Error::Identity);
            }
            if pane.left + pane.width > layout.cols || pane.top + pane.height > layout.rows {
                return Err(Error::Bounds);
            }
            for prior in &layout.panes[..index] {
                if pane.left < prior.left + prior.width
                    && prior.left < pane.left + pane.width
                    && pane.top < prior.top + prior.height
                    && prior.top < pane.top + pane.height
                {
                    return Err(Error::Bounds);
                }
            }
            let (content_top, content_rows) = layout.content_rect(pane);
            if content_rows == 0 {
                return Err(Error::Bounds);
            }
            let Some(source) = current.get(id) else {
                return Ok(None);
            };
            if source.identity.generation != topology.generation {
                return Err(Error::Identity);
            }
            let Some(snapshot) = &source.snapshot else {
                return Ok(None);
            };
            if snapshot.grid.len() != snapshot.rows
                || snapshot
                    .grid
                    .iter()
                    .any(|row| row.cells().len() != snapshot.cols)
            {
                return Err(Error::Bounds);
            }
            skew |= snapshot.cols != pane.width || snapshot.rows != content_rows;
            membership.insert(id.clone(), source.identity.incarnation.clone());
            regions.push(Region {
                pane: id.clone(),
                left: pane.left,
                top: pane.top,
                width: pane.width,
                height: pane.height,
                content_top,
                content_rows,
                source: Arc::clone(source),
            });
        }
        let same_scope = self.cached.as_ref().is_some_and(|cache| {
            cache.generation == topology.generation
                && cache.window == *window
                && cache.membership == membership
        });
        if !same_scope {
            self.reset();
        }
        if skew {
            return Ok(if allow_retention {
                self.cached.as_ref().map(|cache| PresentedWindow {
                    paint: Arc::clone(&cache.paint),
                    coherent: false,
                })
            } else {
                None
            });
        }
        let focus = regions
            .iter()
            .find(|region| region.pane == self.selected)
            .ok_or(Error::Identity)?;
        let snapshot = focus.source.snapshot.as_ref().ok_or(Error::Identity)?;
        let copy_region = CopyRegion {
            pane: self.selected.clone(),
            left: focus.left,
            top: focus.content_top,
            width: snapshot.cols,
            height: snapshot.rows,
            wrapped: snapshot.grid.iter().map(|row| row.wrapped()).collect(),
        };
        let mut cursor = snapshot.cursor.clone();
        cursor.x += focus.left;
        cursor.y += focus.content_top;
        let modes = snapshot.modes.clone();
        let paint = Arc::new(WindowPaint {
            window: window.clone(),
            selected_pane: self.selected.clone(),
            cols: layout.cols,
            rows: layout.rows,
            regions,
            copy_region,
            cursor,
            modes,
            mode_keys: layout.mode_keys,
            zoomed: layout.zoomed,
        });
        if allow_retention {
            self.cached = Some(Cached {
                generation: topology.generation.clone(),
                window: window.clone(),
                membership,
                paint: Arc::clone(&paint),
            });
        }
        Ok(Some(PresentedWindow {
            paint,
            coherent: !topology.awaiting_authority,
        }))
    }
}
