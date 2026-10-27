//! Pure live-grid projection. No transport, history, or input authority is inferred here.
//!
//! Canonical rows and composed canvas rows retain Arc identity. Only dirty canvas
//! rows are merged; metadata-only updates never copy cells. This module prepares a
//! row-backed native frame consumed directly by the painter.
use super::{Error, hit_regions::Region};
use crate::terminal_painter::NativeFrame;
use herdr_client::protocol::{CellData, CursorState};
use herdr_client::tmux_delivery::{Cell, Color, CursorStyle, Row, Snapshot};
use std::{collections::HashMap, sync::Arc};

pub(super) struct PaneSurface<'a> {
    pub region: &'a Region,
    pub snapshot: &'a Snapshot,
}
#[derive(Default)]
pub(super) struct DirectProjection {
    rows: RowProjection,
}
impl DirectProjection {
    #[cfg(test)]
    pub fn cached_row(&self, pane: &str, row: usize) -> Option<&Arc<[CellData]>> {
        self.rows.cached_row(pane, row)
    }
    pub fn project(
        &mut self,
        width: u16,
        height: u16,
        panes: &[PaneSurface<'_>],
        selected: &str,
    ) -> Result<ProjectedFrame, Error> {
        let mut surfaces = Vec::with_capacity(panes.len());
        for pane in panes {
            let snapshot = pane.snapshot;
            if snapshot.cols != usize::from(pane.region.width)
                || snapshot.rows != usize::from(pane.region.height)
            {
                return Err(Error::Invalid(
                    "direct canonical dimensions do not match layout",
                ));
            }
            let cursor = &snapshot.cursor;
            let cursor = if cursor.hidden {
                None
            } else {
                Some(CursorState {
                    x: u16::try_from(cursor.x)
                        .map_err(|_| Error::Invalid("direct cursor out of bounds"))?,
                    y: u16::try_from(cursor.y)
                        .map_err(|_| Error::Invalid("direct cursor out of bounds"))?,
                    visible: true,
                    shape: match (&cursor.style, cursor.blink) {
                        (CursorStyle::Block, true) => 1,
                        (CursorStyle::Block, false) => 2,
                        (CursorStyle::Underline, true) => 3,
                        (CursorStyle::Underline, false) => 4,
                        (CursorStyle::Bar, true) => 5,
                        (CursorStyle::Bar, false) => 6,
                    },
                })
            };
            surfaces.push(RowSurface {
                region: pane.region,
                rows: &snapshot.grid,
                cursor,
            });
        }
        self.rows
            .project(width, height, &surfaces, selected, |row| {
                row.cells().iter().map(painter_cell).collect()
            })
    }
}
fn painter_cell(cell: &Cell) -> Result<CellData, Error> {
    let color = |color: &Color| -> Result<u32, Error> {
        Ok(match color {
            Color::Default => 0,
            Color::Indexed { index } => 0x0100_0000 | u32::from(*index),
            Color::Rgb { value } if *value <= 0xffffff => 0x0200_0000 | *value,
            Color::Rgb { .. } => return Err(Error::Invalid("direct RGB color out of bounds")),
        })
    };
    let a = cell.attributes;
    Ok(CellData {
        symbol: if cell.grapheme.starts_with('\u{10eeee}') {
            " ".into()
        } else {
            cell.grapheme.to_string()
        },
        fg: color(&cell.foreground)?,
        bg: color(&cell.background)?,
        modifier: u16::from(a & 0x0f)
            | (u16::from(a & 0x20) << 1)
            | (u16::from(a & 0x40) << 1)
            | (u16::from(a & 0x80) << 1),
        skip: cell.width == 0,
        hyperlink: None,
    })
}

struct RowSurface<'a> {
    pub region: &'a Region,
    pub rows: &'a [Arc<Row>],
    /// Coordinates relative to this pane, already validated against its snapshot.
    pub cursor: Option<CursorState>,
}

#[cfg(test)]
#[derive(Default, Debug, PartialEq, Eq)]
pub(super) struct ProjectionWork {
    pub converted_rows: usize,
    pub converted_cells: usize,
    pub copied_cells: usize,
}

pub(super) struct ProjectedFrame {
    pub frame: Arc<NativeFrame>,
    #[cfg(test)]
    pub regions: Vec<Region>,
    /// Canvas rows whose canonical source, position or geometry changed.
    #[cfg(test)]
    pub changed_rows: Vec<usize>,
    #[cfg(test)]
    pub work: ProjectionWork,
}

struct CachedRow {
    source: Arc<Row>,
    cells: Arc<[CellData]>,
}

#[derive(Default)]
struct RowProjection {
    panes: HashMap<String, Vec<CachedRow>>,
    regions: Vec<Region>,
    frame: Option<Arc<NativeFrame>>,
}
impl RowProjection {
    #[cfg(test)]
    pub fn cached_row(&self, pane: &str, row: usize) -> Option<&Arc<[CellData]>> {
        self.panes.get(pane)?.get(row).map(|row| &row.cells)
    }

    /// `convert` is called only for new immutable canonical rows. Failure is atomic:
    /// the previous coherent projection and cache remain available to the caller.
    pub fn project(
        &mut self,
        width: u16,
        height: u16,
        panes: &[RowSurface<'_>],
        selected: &str,
        mut convert: impl FnMut(&Row) -> Result<Vec<CellData>, Error>,
    ) -> Result<ProjectedFrame, Error> {
        let count = usize::from(width) * usize::from(height);
        if width == 0 || height == 0 || count > 262_144 || panes.is_empty() || panes.len() > 24 {
            return Err(Error::Invalid("direct projection dimensions out of bounds"));
        }
        for (index, pane) in panes.iter().enumerate() {
            let r = pane.region;
            if r.id.is_empty()
                || r.width == 0
                || r.height == 0
                || u32::from(r.left) + u32::from(r.width) > u32::from(width)
                || u32::from(r.top) + u32::from(r.height) > u32::from(height)
                || pane.rows.len() != usize::from(r.height)
                || panes[..index]
                    .iter()
                    .any(|prior| prior.region.id == r.id || overlap(prior.region, r))
                || pane
                    .cursor
                    .as_ref()
                    .is_some_and(|c| c.visible && (c.x >= r.width || c.y >= r.height))
            {
                return Err(Error::Invalid("incoherent direct pane geometry"));
            }
        }
        let selected = panes
            .iter()
            .find(|p| p.region.id == selected)
            .ok_or(Error::Invalid("selected pane outside direct layout"))?;
        let cursor = selected
            .cursor
            .as_ref()
            .filter(|c| c.visible)
            .map(|c| CursorState {
                x: selected.region.left + c.x,
                y: selected.region.top + c.y,
                visible: true,
                shape: c.shape,
            });
        let regions: Vec<_> = panes.iter().map(|p| p.region.clone()).collect();
        let resized = self
            .frame
            .as_ref()
            .is_none_or(|f| f.width != width || f.height != height);
        let mut dirty = vec![resized; usize::from(height)];
        if !resized {
            // Reordering equivalent regions is metadata, not changed terminal cells.
            for region in self
                .regions
                .iter()
                .filter(|old| !regions.contains(old))
                .chain(regions.iter().filter(|new| !self.regions.contains(new)))
            {
                let end = (usize::from(region.top) + usize::from(region.height)).min(dirty.len());
                for row in dirty.iter_mut().take(end).skip(usize::from(region.top)) {
                    *row = true;
                }
            }
        }
        #[cfg(test)]
        let mut work = ProjectionWork::default();
        let mut next = HashMap::new();
        for pane in panes {
            let mut rows = Vec::with_capacity(pane.rows.len());
            let prior = self.panes.get(&pane.region.id);
            for (index, source) in pane.rows.iter().enumerate() {
                let cached = prior
                    .and_then(|rows| rows.get(index))
                    .filter(|row| Arc::ptr_eq(&row.source, source));
                let cells = if let Some(cached) = cached {
                    Arc::clone(&cached.cells)
                } else {
                    let cells = convert(source)?;
                    if cells.len() != usize::from(pane.region.width) {
                        return Err(Error::Invalid("direct row width mismatch"));
                    }
                    #[cfg(test)]
                    {
                        work.converted_rows += 1;
                        work.converted_cells += cells.len();
                    }
                    dirty[usize::from(pane.region.top) + index] = true;
                    Arc::from(cells)
                };
                if cells.len() != usize::from(pane.region.width) {
                    return Err(Error::Invalid("retained direct row width mismatch"));
                }
                rows.push(CachedRow {
                    source: Arc::clone(source),
                    cells,
                });
            }
            next.insert(pane.region.id.clone(), rows);
        }
        #[cfg(test)]
        let changed_rows: Vec<_> = dirty
            .iter()
            .enumerate()
            .filter_map(|(i, dirty)| dirty.then_some(i))
            .collect();
        let reusable = self
            .frame
            .as_ref()
            .filter(|frame| !dirty.iter().any(|changed| *changed) && frame.cursor == cursor);
        let frame = if let Some(frame) = reusable {
            Arc::clone(frame)
        } else {
            let mut canvas = Vec::with_capacity(usize::from(height));
            for (y, changed) in dirty.iter().enumerate() {
                if !changed {
                    let row = self
                        .frame
                        .as_ref()
                        .and_then(|f| f.rows.get(y))
                        .ok_or(Error::Invalid("retained direct canvas row absent"))?;
                    canvas.push(Arc::clone(row));
                    continue;
                }
                let covering: Vec<_> = panes
                    .iter()
                    .filter(|p| {
                        y >= usize::from(p.region.top)
                            && y < usize::from(p.region.top) + usize::from(p.region.height)
                    })
                    .collect();
                let pane_row = |pane: &RowSurface<'_>| -> Result<&Arc<[CellData]>, Error> {
                    next.get(&pane.region.id)
                        .and_then(|rows| rows.get(y - usize::from(pane.region.top)))
                        .map(|row| &row.cells)
                        .ok_or(Error::Invalid("direct projection pane row absent"))
                };
                // No composition is needed when a pane occupies the entire row.
                if covering.len() == 1
                    && covering[0].region.left == 0
                    && covering[0].region.width == width
                {
                    canvas.push(Arc::clone(pane_row(covering[0])?));
                    continue;
                }
                let blank = CellData {
                    symbol: " ".into(),
                    fg: 0,
                    bg: 0,
                    modifier: 0,
                    skip: false,
                    hyperlink: None,
                };
                let mut cells = vec![blank; usize::from(width)];
                for pane in covering {
                    let row = pane_row(pane)?;
                    let start = usize::from(pane.region.left);
                    cells[start..start + row.len()].clone_from_slice(row);
                    #[cfg(test)]
                    {
                        work.copied_cells += row.len();
                    }
                }
                canvas.push(Arc::from(cells));
            }
            Arc::new(NativeFrame {
                rows: canvas,
                width,
                height,
                cursor,
            })
        };
        self.panes = next;
        #[cfg(test)]
        let published_regions = regions.clone();
        self.regions = regions;
        self.frame = Some(Arc::clone(&frame));
        Ok(ProjectedFrame {
            frame,
            #[cfg(test)]
            regions: published_regions,
            #[cfg(test)]
            changed_rows,
            #[cfg(test)]
            work,
        })
    }
}
fn overlap(a: &Region, b: &Region) -> bool {
    u32::from(a.left) < u32::from(b.left) + u32::from(b.width)
        && u32::from(b.left) < u32::from(a.left) + u32::from(a.width)
        && u32::from(a.top) < u32::from(b.top) + u32::from(b.height)
        && u32::from(b.top) < u32::from(a.top) + u32::from(a.height)
}

#[cfg(test)]
#[path = "direct_projection_tests.rs"]
mod tests;
