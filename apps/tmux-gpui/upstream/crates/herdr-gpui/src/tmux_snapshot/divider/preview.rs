//! Presentation-only pane rectangles. Never published as input or daemon geometry.
use super::*;
use crate::terminal_painter::{FrameView, Layer, Part, PlacedImages, Span, TerminalPainter};

pub(in crate::tmux_snapshot) struct Preview {
    pub regions: Vec<hit_regions::Region>,
    pub(super) edge: u16,
    sources: Vec<hit_regions::Region>,
}
impl Preview {
    pub(super) fn new(drag: &Drag) -> Option<Self> {
        let split = &drag.split;
        let delta = i32::from(drag.cells) - i32::from(split.cells);
        if delta == 0 {
            return None;
        }
        let mut low = i32::MIN;
        let mut high = i32::MAX;
        let mut before = false;
        let mut after = false;
        // The actual daemon retains ancestry and decides the final layout. For
        // this approximation only rectangles sharing this exact edge can move.
        for r in &drag.regions {
            let (start, length, cross, span) = dimensions(r, split.axis);
            if cross < split.start || cross + span > split.start + split.span {
                continue;
            }
            let minimum = if split.axis == Axis::Rows { 3 } else { 2 };
            if start + length == split.edge {
                before = true;
                low = low.max(minimum - i32::from(length));
            }
            if start == split.edge + 1 {
                after = true;
                high = high.min(i32::from(length) - minimum);
            }
        }
        if !before || !after || low > high {
            return None;
        }
        let delta = delta.clamp(low, high);
        let mut regions = drag.regions.clone();
        for r in &mut regions {
            let (start, length, cross, span) = dimensions(r, split.axis);
            if cross < split.start || cross + span > split.start + split.span {
                continue;
            }
            let (start, length) = if start + length == split.edge {
                (i32::from(start), i32::from(length) + delta)
            } else if start == split.edge + 1 {
                (i32::from(start) + delta, i32::from(length) - delta)
            } else {
                continue;
            };
            if split.axis == Axis::Cols {
                r.left = u16::try_from(start).ok()?;
                r.width = u16::try_from(length).ok()?;
            } else {
                r.top = u16::try_from(start).ok()?;
                r.height = u16::try_from(length).ok()?;
            }
        }
        Some(Self {
            edge: u16::try_from(i32::from(split.edge) + delta).ok()?,
            sources: drag.regions.clone(),
            regions,
        })
    }

    /// Clip and translate borrowed cells and images; no terminal-row copies or
    /// reflow occur. Growing panes expose the normal empty canvas background.
    #[allow(clippy::too_many_arguments)]
    pub fn paint(
        &self,
        painter: &mut TerminalPainter,
        frame: FrameView<'_>,
        bounds: Bounds<Pixels>,
        width: f32,
        height: f32,
        font: &Font,
        separator: Rgba,
        images: Option<PlacedImages<'_>>,
        window: &mut Window,
        cx: &mut App,
    ) {
        for (source, target) in self.sources.iter().zip(&self.regions) {
            let area: Vec<_> = (source.top..source.top + source.height)
                .map(|row| Span {
                    row,
                    columns: source.left..source.left + source.width,
                })
                .collect();
            let target_bounds = Bounds::new(
                bounds.origin
                    + point(
                        px(f32::from(target.left) * width),
                        px(f32::from(target.top) * height),
                    ),
                size(
                    px(f32::from(target.width.min(source.width)) * width),
                    px(f32::from(target.height.min(source.height)) * height),
                ),
            );
            let origin = bounds.origin
                + point(
                    px((f32::from(target.left) - f32::from(source.left)) * width),
                    px((f32::from(target.top) - f32::from(source.top)) * height),
                );
            window.with_content_mask(
                Some(ContentMask {
                    bounds: target_bounds.intersect(&bounds),
                    ..Default::default()
                }),
                |window| {
                    for layer in Layer::ALL {
                        painter.paint_view(
                            frame,
                            origin,
                            None,
                            width,
                            font,
                            &[],
                            &[],
                            Some(Part { area: &area, layer }),
                            images,
                            window,
                            cx,
                        );
                    }
                },
            );
        }
        window.with_content_mask(
            Some(ContentMask {
                bounds,
                ..Default::default()
            }),
            |window| {
                for r in &self.regions {
                    if r.left + r.width < frame.width() {
                        window.paint_quad(fill(
                            Bounds::new(
                                bounds.origin
                                    + point(
                                        px((f32::from(r.left + r.width) + 0.5) * width),
                                        px(f32::from(r.top) * height),
                                    ),
                                size(px(width.min(1.)), px(f32::from(r.height) * height)),
                            ),
                            separator,
                        ));
                    }
                    if r.top + r.height < frame.height() {
                        window.paint_quad(fill(
                            Bounds::new(
                                bounds.origin
                                    + point(
                                        px(f32::from(r.left) * width),
                                        px((f32::from(r.top + r.height) + 0.5) * height),
                                    ),
                                size(px(f32::from(r.width) * width), px(height.min(1.))),
                            ),
                            separator,
                        ));
                    }
                }
            },
        );
    }
}
fn dimensions(r: &hit_regions::Region, axis: Axis) -> (u16, u16, u16, u16) {
    if axis == Axis::Cols {
        (r.left, r.width, r.top, r.height)
    } else {
        (r.top, r.height, r.left, r.width)
    }
}
impl SnapshotView {
    pub(in crate::tmux_snapshot) fn divider_content_preview(&self) -> Option<Preview> {
        let drag = self
            .divider
            .as_ref()
            .or_else(|| self.resize_gesture.released_preview())?;
        if !self.presence.ready()
            || !drag.compatible(&self.browser_state)
            || self.browser_state.regions != drag.regions
            || self.input_geometry.map(|g| g.0) != Some(drag.bounds)
            || self.input_cell_width != Some(drag.cell_width)
            || !hit_regions::is_painted(self.frame.as_ref(), self.browser_state.frame.as_ref())
        {
            return None;
        }
        Preview::new(drag)
    }
}
