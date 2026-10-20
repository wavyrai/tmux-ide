//! Deliberate web opening from the exact selected, painted canonical pane.
use super::{SnapshotView, browser, copy, hit_regions};
use gpui::{MouseButton, MouseDownEvent, Pixels, Point};
use herdr_client::protocol::{FrameData, PaneSurfaceFrame, PaneSurfacePane, SurfaceRect};

pub(super) fn gesture(event: &MouseDownEvent) -> bool {
    event.button == MouseButton::Left
        && (event.modifiers.platform || event.modifiers.control)
        && !event.modifiers.shift
        && !event.modifiers.alt
}

impl SnapshotView {
    pub(super) fn terminal_web_link(&self, position: Point<Pixels>) -> Option<String> {
        if self.browser_state.retained_preview
            || self.picker.is_some()
            || self.pane_actions.is_some()
            || self.new_session.is_some()
            || self.divider.is_some()
            || !self.marked.is_empty()
            || !self.presence.ready()
            || self.browser_commands.is_none()
            || self.browser_state.request != self.browser_request
            || self.browser_state.surface != browser::Surface::Workspace
            || !(self.terminal_input_ready() || self.historical_selection_ready())
            || !hit_regions::is_painted(self.frame.as_ref(), self.painted_frame.as_ref())
            || !hit_regions::is_painted(self.frame.as_ref(), self.browser_state.frame.as_ref())
        {
            return None;
        }
        let (bounds, _) = self.input_geometry?;
        let width = self.input_cell_width?;
        let height = self.terminal_height();
        if !bounds.contains(&position) {
            return None;
        }
        let point = position - bounds.origin;
        let id = hit_regions::hit(
            &self.browser_state.regions,
            f32::from(point.x),
            f32::from(point.y),
            width,
            height,
        )?;
        if self.browser_state.selected_pane.as_deref() != Some(id) {
            return None;
        }
        let frame = self.frame.as_ref()?;
        let region = self.browser_state.copy_region.as_ref()?;
        if !region.valid(frame, Some(id)) {
            return None;
        }
        resolve(
            frame,
            region,
            (f32::from(point.x) / width).floor() as u16,
            (f32::from(point.y) / height).floor() as u16,
        )
    }
}

fn resolve(frame: &FrameData, region: &copy::Region, column: u16, row: u16) -> Option<String> {
    if !region.valid(frame, Some(&region.id))
        || column < region.left
        || row < region.top
        || column >= region.left + region.width
        || row >= region.top + region.height
    {
        return None;
    }
    let row = row - region.top;
    let mut first = row;
    let mut last = row;
    while first > 0 && region.wrapped[usize::from(first)] {
        first -= 1;
    }
    // The start of a retained logical line may be outside the displayed viewport.
    if region.wrapped[usize::from(first)] {
        return None;
    }
    while last + 1 < region.height && region.wrapped[usize::from(last + 1)] {
        last += 1;
    }
    let count = usize::from(last - first + 1) * usize::from(region.width);
    if count > 8192 {
        return None;
    }
    let mut cells = Vec::with_capacity(count);
    for y in first..=last {
        let start =
            usize::from(region.top + y) * usize::from(frame.width) + usize::from(region.left);
        cells.extend_from_slice(frame.cells.get(start..start + usize::from(region.width))?);
    }
    // Preserve parser's fail-closed right-edge rule; no fabricated terminator.
    let width = u16::try_from(cells.len()).ok()?;
    let rect = SurfaceRect {
        x: 0,
        y: 0,
        width,
        height: 1,
    };
    let surface = PaneSurfaceFrame {
        boot_id: String::new(),
        projection_revision: 0,
        surface_revision: 0,
        frame: FrameData {
            width,
            height: 1,
            cells,
            cursor: None,
            hyperlinks: frame.hyperlinks.clone(),
            graphics: vec![],
        },
        splits: vec![],
        popup: None,
        graphics: Default::default(),
        panes: vec![PaneSurfacePane {
            pane_id: region.id.clone(),
            content_revision: 0,
            rect,
            inner_rect: rect,
            scrollbar_rect: None,
            scroll: None,
            focused: true,
            mouse_reporting: false,
            sgr_pixel_mouse: false,
            alternate_screen_active: false,
            pixel_width: u32::from(width),
            pixel_height: 1,
        }],
    };
    let hit =
        usize::from(row - first) * usize::from(region.width) + usize::from(column - region.left);
    crate::terminal::link_at(&surface, hit as f32 + 0.5, 0.5, 1., 1.)
}

#[cfg(test)]
mod tests;
