//! Pixel-only chrome around unchanged terminal cells. All consumers share this map.
use super::{SnapshotView, hit_regions::Region};
use gpui::{Bounds, Pixels, Point, Size, point, px, size};
pub(super) const PAD: f32 = 10.;
pub(super) const HEADER: f32 = 34.;
pub(super) const GAP: f32 = 10.;
pub(super) const RADIUS: f32 = 10.;
#[derive(Clone)]
pub(super) struct Layout {
    pub regions: Vec<Region>,
    x: Vec<u16>,
    y: Vec<u16>,
    removed_rows: Vec<u16>,
    pub width: f32,
    pub height: f32,
}
impl Layout {
    pub fn new(regions: &[Region], width: f32, height: f32) -> Self {
        let cuts = |horizontal: bool| {
            let mut cuts: Vec<_> = regions
                .iter()
                .map(|r| if horizontal { r.left } else { r.top })
                .filter(|&n| n > 0)
                .collect();
            cuts.sort_unstable();
            cuts.dedup();
            cuts
        };
        Self {
            regions: regions.to_vec(),
            removed_rows: Vec::new(),
            x: cuts(true),
            y: cuts(false),
            width,
            height,
        }
    }
    fn with_content(mut self, content: &[Region]) -> Self {
        if content.len() != self.regions.len() || content.is_empty() {
            return self;
        }
        let top = self.regions.iter().map(|r| r.top).min().unwrap_or(0);
        let bottom = self
            .regions
            .iter()
            .map(|r| r.top + r.height)
            .max()
            .unwrap_or(0);
        let content_top = content.iter().map(|r| r.top).min().unwrap_or(top);
        let content_bottom = content
            .iter()
            .map(|r| r.top + r.height)
            .max()
            .unwrap_or(bottom);
        self.removed_rows.extend(top..content_top);
        self.removed_rows.extend(content_bottom..bottom);
        self.regions = content.to_vec();
        self
    }
    pub fn reflow(&self, regions: &[Region]) -> Self {
        let content: Vec<_> = regions
            .iter()
            .map(|r| {
                let mut r = r.clone();
                while r.height > 0 && self.removed_rows.contains(&r.top) {
                    r.top += 1;
                    r.height -= 1;
                }
                while r.height > 0 && self.removed_rows.contains(&(r.top + r.height - 1)) {
                    r.height -= 1;
                }
                r
            })
            .collect();
        Self::new(regions, self.width, self.height).with_content(&content)
    }
    fn extra(&self, axis: bool) -> f32 {
        if axis {
            2. * PAD + GAP - self.width
        } else {
            HEADER + 2. * PAD + GAP - self.height
        }
    }
    fn shift(&self, value: u16, axis: bool) -> f32 {
        let cuts = if axis { &self.x } else { &self.y };
        cuts.iter().filter(|&&n| n <= value).count() as f32 * self.extra(axis)
            - if axis {
                0.
            } else {
                self.removed_rows.iter().filter(|&&row| row < value).count() as f32 * self.height
            }
    }
    pub fn origin(&self, r: &Region) -> Point<Pixels> {
        point(
            px(f32::from(r.left) * self.width + self.shift(r.left, true) + PAD),
            px(f32::from(r.top) * self.height + self.shift(r.top, false) + HEADER + PAD),
        )
    }
    pub fn card(&self, r: &Region) -> Bounds<Pixels> {
        let origin = self.origin(r) - point(px(PAD), px(HEADER + PAD));
        let right = f32::from(r.left + r.width) * self.width
            + self.shift(r.left + r.width, true)
            + 2. * PAD;
        let bottom = f32::from(r.top + r.height) * self.height
            + self.shift(r.top + r.height, false)
            + HEADER
            + 2. * PAD;
        Bounds::new(origin, size(px(right) - origin.x, px(bottom) - origin.y))
    }
    pub fn content(&self, r: &Region) -> Bounds<Pixels> {
        Bounds::new(
            self.origin(r),
            size(
                px(f32::from(r.width) * self.width),
                px(f32::from(r.height) * self.height),
            ),
        )
    }
    pub fn translation(&self, r: &Region) -> Point<Pixels> {
        self.origin(r)
            - point(
                px(f32::from(r.left) * self.width),
                px(f32::from(r.top) * self.height),
            )
    }
    pub fn gutter(
        &self,
        axis: super::divider::Axis,
        edge: u16,
        start: u16,
        span: u16,
    ) -> Bounds<Pixels> {
        if axis == super::divider::Axis::Cols {
            let x = f32::from(edge) * self.width + self.shift(edge, true) + 2. * PAD;
            let y = f32::from(start) * self.height + self.shift(start, false);
            let end = f32::from(start + span) * self.height
                + self.shift(start + span, false)
                + HEADER
                + 2. * PAD;
            Bounds::new(point(px(x), px(y)), size(px(GAP), px(end - y)))
        } else {
            let x = f32::from(start) * self.width + self.shift(start, true);
            let y = f32::from(edge) * self.height + self.shift(edge, false) + HEADER + 2. * PAD;
            let end =
                f32::from(start + span) * self.width + self.shift(start + span, true) + 2. * PAD;
            Bounds::new(point(px(x), px(y)), size(px(end - x), px(GAP)))
        }
    }
    pub fn overhead(&self) -> Size<Pixels> {
        size(
            px(2. * PAD + self.x.len() as f32 * self.extra(true)),
            px(HEADER + 2. * PAD + self.y.len() as f32 * self.extra(false)
                - self.removed_rows.len() as f32 * self.height),
        )
    }
    pub fn logical(&self, point: Point<Pixels>) -> Option<Point<Pixels>> {
        self.regions
            .iter()
            .find(|r| self.content(r).contains(&point))
            .map(|r| point - self.translation(r))
    }
    pub fn cursor(&self, col: u16, row: u16) -> Point<Pixels> {
        let point = point(
            px(f32::from(col) * self.width),
            px(f32::from(row) * self.height),
        );
        self.regions
            .iter()
            .find(|r| {
                col >= r.left && col < r.left + r.width && row >= r.top && row < r.top + r.height
            })
            .map_or(point, |r| point + self.translation(r))
    }
}
impl SnapshotView {
    pub(super) fn card_layout(&self, width: f32) -> Option<Layout> {
        let frame = self.browser_state.frame.as_ref()?;
        (self.browsing
            && self.browser_state.surface == super::browser::Surface::Workspace
            && width.is_finite()
            && width > 0.
            && super::hit_regions::valid_view(
                &self.browser_state.regions,
                Some(frame.view()),
                &self.browser_state.panes,
            ))
        .then(|| {
            Layout::new(&self.browser_state.regions, width, self.terminal_height())
                .with_content(&self.browser_state.native_content_regions)
        })
    }
    pub(super) fn selection_point(&self, position: Point<Pixels>) -> Option<Point<Pixels>> {
        let local = position - self.input_geometry?.0.origin;
        let Some(layout) = self.card_layout(self.input_cell_width?) else {
            return Some(local);
        };
        let selected = self.browser_state.selected_pane.as_ref()?;
        let region = layout.regions.iter().find(|r| &r.id == selected)?;
        // A captured selection may extend beyond its card; its own boundary code clamps it.
        Some(local - layout.translation(region))
    }
    pub(super) fn terminal_point(&self, position: Point<Pixels>) -> Option<Point<Pixels>> {
        let bounds = self.input_geometry?.0;
        let local = position - bounds.origin;
        match self.card_layout(self.input_cell_width?) {
            Some(layout) => layout.logical(local),
            None => Some(local),
        }
    }
}
mod render;
#[cfg(test)]
mod tests;

#[cfg(test)]
mod test_support;
