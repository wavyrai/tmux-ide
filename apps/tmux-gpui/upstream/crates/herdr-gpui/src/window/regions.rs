//! The terminal grid painted as one cached view per pane, plus one for the
//! cells around them, so an update repaints only the regions whose cells
//! changed. One busy pane no longer reshapes every other pane on screen.

use super::HerdrWindow;
use crate::{
    config::Theme,
    terminal_painter::{self, Highlight, Layer, Part, Span, TerminalPainter},
};
use gpui::{prelude::*, *};
use herdr_client::protocol::{FrameData, PaneSurfaceFrame, PaneSurfacePane, SurfaceRect};
use std::{cell::RefCell, ops::Range, rc::Rc, sync::Arc};

/// Whose cells a region paints.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Owner {
    Pane(String),
    /// Borders, splits, and any other cell no pane covers.
    Chrome,
}

/// Everything besides the cells that changes how a region paints.
#[derive(Clone, PartialEq)]
pub(super) struct Look {
    pub(super) font: Font,
    pub(super) font_size: f32,
    pub(super) cell_width: f32,
    pub(super) cell_height: f32,
    pub(super) theme: Theme,
}

#[derive(Clone)]
struct Region {
    owner: Owner,
    surface: Arc<PaneSurfaceFrame>,
    area: Vec<Span>,
    highlights: Vec<Highlight>,
    look: Look,
}

impl Region {
    /// Whether `next` paints exactly what this region already painted.
    fn paints_like(&self, next: &Self) -> bool {
        self.area == next.area
            && self.highlights == next.highlights
            && self.look == next.look
            && (Arc::ptr_eq(&self.surface, &next.surface)
                || same_cells(&self.surface, &next.surface, &self.area))
    }
}

/// Whether both surfaces paint the same thing inside `area`: cells, cursor,
/// and the scrollbars that cross it.
fn same_cells(old: &PaneSurfaceFrame, new: &PaneSurfaceFrame, area: &[Span]) -> bool {
    let cursor = |frame: &FrameData| {
        frame
            .cursor
            .as_ref()
            .filter(|c| c.visible && terminal_painter::covers(area, c.x, c.y))
            .cloned()
    };
    let bars = |surface: &PaneSurfaceFrame| {
        surface
            .panes
            .iter()
            .filter_map(|pane| Some((pane.scrollbar_rect?, pane.scroll)))
            .filter(|(rect, _)| crosses(area, *rect))
            .collect::<Vec<_>>()
    };
    let (a, b) = (&old.frame, &new.frame);
    a.width == b.width
        && a.height == b.height
        && terminal_painter::cell_ranges(a, area)
            .all(|range| a.cells[range.clone()] == b.cells[range])
        && cursor(a) == cursor(b)
        && bars(old) == bars(new)
}

/// Whether any cell of `rect` lies in `area`.
fn crosses(area: &[Span], rect: SurfaceRect) -> bool {
    let rows = u32::from(rect.y)..u32::from(rect.y) + u32::from(rect.height);
    let right = u32::from(rect.x) + u32::from(rect.width);
    area.iter().any(|span| {
        rows.contains(&u32::from(span.row))
            && u32::from(span.columns.start) < right
            && rect.x < span.columns.end
    })
}

/// Splits the frame's cells among its panes, each pane owning the cells of
/// its rectangle that no earlier pane claimed, and the chrome the rest. Every
/// cell belongs to exactly one region, so none is painted twice.
fn partition(frame: &FrameData, panes: &[PaneSurfacePane]) -> Vec<(Owner, Vec<Span>)> {
    let mut regions: Vec<(Owner, Vec<Span>)> = panes
        .iter()
        .map(|pane| (Owner::Pane(pane.pane_id.clone()), Vec::new()))
        .chain([(Owner::Chrome, Vec::new())])
        .collect();
    let mut claimed: Vec<Range<u16>> = Vec::new();
    for row in 0..frame.height {
        claimed.clear();
        for (index, pane) in panes.iter().enumerate() {
            let rect = pane.rect;
            if row < rect.y || u32::from(row) >= u32::from(rect.y) + u32::from(rect.height) {
                continue;
            }
            let wanted =
                rect.x.min(frame.width)..rect.x.saturating_add(rect.width).min(frame.width);
            let mut start = wanted.start;
            for taken in &claimed {
                if taken.end <= start || taken.start >= wanted.end {
                    continue;
                }
                if taken.start > start {
                    regions[index].1.push(Span {
                        row,
                        columns: start..taken.start,
                    });
                }
                start = start.max(taken.end);
            }
            if start < wanted.end {
                regions[index].1.push(Span {
                    row,
                    columns: start..wanted.end,
                });
            }
            if wanted.start < wanted.end {
                let at = claimed.partition_point(|taken| taken.start < wanted.start);
                claimed.insert(at, wanted);
            }
        }
        let chrome = &mut regions[panes.len()].1;
        let mut start = 0;
        for taken in &claimed {
            if taken.start > start {
                chrome.push(Span {
                    row,
                    columns: start..taken.start,
                });
            }
            start = start.max(taken.end);
        }
        if start < frame.width {
            chrome.push(Span {
                row,
                columns: start..frame.width,
            });
        }
    }
    regions.retain(|(_, area)| !area.is_empty());
    regions
}

/// One layer of one region of the grid. Its scene is replayed while the
/// region paints the same cells; a change replaces the view instead of
/// notifying it.
pub(crate) struct RegionView {
    painter: Rc<RefCell<TerminalPainter>>,
    region: Rc<Region>,
    layer: Layer,
}

/// A region's views, one per layer in `Layer::ALL` order.
pub(crate) type RegionLayers = [Entity<RegionView>; 3];

impl Render for RegionView {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        let painter = self.painter.clone();
        let region = self.region.clone();
        let layer = self.layer;
        canvas(
            |_, _, _| (),
            move |bounds, _, window, cx| {
                painter.borrow_mut().paint_frame(
                    &region.surface.frame,
                    bounds.origin,
                    Some(bounds.size),
                    region.look.cell_width,
                    &region.look.font,
                    &region.highlights,
                    &region.surface.panes,
                    Some(Part {
                        area: &region.area,
                        layer,
                    }),
                    None,
                    window,
                    cx,
                );
            },
        )
        .size_full()
    }
}

impl HerdrWindow {
    /// The cached views painting `surface`'s cells, bottom first, or none when
    /// the grid must paint as a whole. Each covers the full grid bounds and
    /// paints one layer of only its own cells. Every region's backgrounds
    /// come before any region's text, and all text before any decoration, as
    /// in a whole-grid paint: a glyph overhanging its region into a border or
    /// a neighbouring pane stays visible.
    ///
    /// Images stay whole-frame: a texture no paint looks up is released while
    /// a replayed scene would still sample it.
    pub(super) fn terminal_regions(
        &mut self,
        surface: Option<&Arc<PaneSurfaceFrame>>,
        highlights: &[Highlight],
        look: &Look,
        cx: &mut Context<Self>,
    ) -> Vec<AnyElement> {
        let Some(surface) = surface.filter(|surface| surface.graphics.placements.is_empty()) else {
            self.regions.clear();
            return Vec::new();
        };
        let mut previous = std::mem::take(&mut self.regions);
        for (owner, area) in partition(&surface.frame, &surface.panes) {
            let region = Rc::new(Region {
                owner,
                surface: surface.clone(),
                highlights: terminal_painter::clip(highlights, &area),
                area,
                look: look.clone(),
            });
            let kept = previous
                .iter()
                .position(|views| views[0].read(cx).region.owner == region.owner)
                .map(|index| previous.swap_remove(index))
                .filter(|views| views[0].read(cx).region.paints_like(&region));
            // Notifying a view while the window draws only marks it for the
            // next frame, so a changed region takes a fresh view, which has
            // no scene to replay. An unchanged one adopts the new surface
            // without being invalidated, releasing the old frame.
            let views = match kept {
                Some(views) => {
                    for view in &views {
                        view.update(cx, |view, _| view.region = region.clone());
                    }
                    views
                }
                None => Layer::ALL.map(|layer| {
                    let painter = self.painter.clone();
                    let region = region.clone();
                    cx.new(|_| RegionView {
                        painter,
                        region,
                        layer,
                    })
                }),
            };
            self.regions.push(views);
        }
        (0..Layer::ALL.len())
            .flat_map(|layer| self.regions.iter().map(move |views| &views[layer]))
            .map(|view| {
                view.clone()
                    .cached(
                        StyleRefinement::default()
                            .absolute()
                            .top_0()
                            .left_0()
                            .size_full(),
                    )
                    .into_any_element()
            })
            .collect()
    }
}

#[cfg(test)]
mod tests;
