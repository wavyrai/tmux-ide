//! Deliberate web opening from the exact selected, painted canonical pane.
use super::{SnapshotView, browser, copy, hit_regions};
use crate::terminal_painter::FrameView;
use gpui::{MouseButton, MouseDownEvent, Pixels, Point};

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
        if !region.valid_view(frame.view(), Some(id)) {
            return None;
        }
        resolve(
            frame.view(),
            region,
            (f32::from(point.x) / width).floor() as u16,
            (f32::from(point.y) / height).floor() as u16,
        )
    }
}

fn resolve<'a>(
    frame: impl Into<FrameView<'a>>,
    region: &copy::Region,
    column: u16,
    row: u16,
) -> Option<String> {
    let frame = frame.into();
    if !region.valid_view(frame, Some(&region.id))
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
        let start = usize::from(region.left);
        cells.extend(
            frame
                .row(usize::from(region.top + y))?
                .get(start..start + usize::from(region.width))?
                .iter(),
        );
    }
    let hit =
        usize::from(row - first) * usize::from(region.width) + usize::from(column - region.left);
    crate::terminal::logical_web_link(&cells, hit, frame.hyperlinks())
}

#[cfg(test)]
mod tests;
