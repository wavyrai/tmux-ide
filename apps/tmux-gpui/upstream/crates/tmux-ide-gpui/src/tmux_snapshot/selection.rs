//! A selection owns its painted frame; streaming updates cannot change its text.
use super::display_frame::DisplayFrame;
use super::{Error, browser, copy, hit_regions};
use crate::terminal_painter::{Highlight, Tint};

/// What a double-click (a word) or triple-click (a line) selects.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Unit {
    Word,
    Line,
}

pub(super) struct Capture {
    identity: Option<String>,
    pub frame: DisplayFrame,
    region: copy::Region,
    regions: Vec<hit_regions::Region>,
    anchor: (u16, u16),
    head: (u16, u16),
    pub dragging: bool,
    pub highlights: Vec<Highlight>,
    /// The unit a double- or triple-click selected, with its boundaries;
    /// dragging then grows the selection by whole units.
    unit: Option<(Unit, units::Boundary, units::Boundary)>,
}
impl Capture {
    pub fn begin(state: &browser::State, x: f32, y: f32) -> Option<Self> {
        if state.retained_preview {
            return None;
        }
        let frame = state.frame.clone()?;
        let region = state.copy_region.clone()?;
        if !region.valid_view(frame.view(), state.selected_pane.as_deref())
            || !x.is_finite()
            || !y.is_finite()
            || x < f32::from(region.left)
            || y < f32::from(region.top)
            || x >= f32::from(region.left + region.width)
            || y >= f32::from(region.top + region.height)
        {
            return None;
        }
        let anchor = boundary(&region, x, y)?;
        Some(Self {
            identity: state.selection_identity.clone(),
            frame,
            region,
            regions: state.regions.clone(),
            anchor,
            head: anchor,
            dragging: true,
            highlights: Vec::new(),
            unit: None,
        })
    }
    /// Selects the word or line under (`x`, `y`) in place of the empty start.
    pub fn select(&mut self, unit: Unit, x: f32, y: f32) -> Result<(), Error> {
        let cell = self
            .cell(x, y)
            .ok_or(Error::Invalid("selection outside the pane"))?;
        let (start, end) = units::bounds(&self.region, self.frame.view(), unit, cell)?;
        self.unit = Some((unit, start, end));
        self.anchor = start;
        self.head = end;
        self.paint()
    }
    pub fn update(&mut self, x: f32, y: f32) -> Result<(), Error> {
        if let Some((unit, start, end)) = self.unit {
            if let Some(cell) = self.cell(x, y)
                && let Ok((from, to)) = units::bounds(&self.region, self.frame.view(), unit, cell)
            {
                (self.anchor, self.head) = if from < start {
                    (end, from)
                } else {
                    (start, to.max(end))
                };
            }
            return self.paint();
        }
        let Some(head) = boundary(&self.region, x, y) else {
            return Ok(());
        };
        self.head = head;
        self.paint()
    }
    /// The pane cell under (`x`, `y`), clamped into the pane.
    fn cell(&self, x: f32, y: f32) -> Option<(u16, u16)> {
        if !x.is_finite() || !y.is_finite() {
            return None;
        }
        let row = (y - f32::from(self.region.top))
            .floor()
            .clamp(0., f32::from(self.region.height - 1));
        let column = (x - f32::from(self.region.left))
            .floor()
            .clamp(0., f32::from(self.region.width - 1));
        Some((row as u16, column as u16))
    }
    fn paint(&mut self) -> Result<(), Error> {
        self.highlights = self
            .region
            .spans_view(self.frame.view(), self.anchor, self.head)?
            .into_iter()
            .filter(|(_, columns)| !columns.is_empty())
            .map(|(row, columns)| Highlight {
                row: self.region.top + row,
                columns: (self.region.left + columns.start as u16)
                    ..(self.region.left + columns.end as u16),
                tint: Tint::Selection,
            })
            .collect();
        Ok(())
    }
    pub fn empty(&self) -> bool {
        self.anchor == self.head
    }
    pub fn text(&self) -> Result<String, Error> {
        self.region
            .text_between_view(self.frame.view(), self.anchor, self.head)
    }
    pub fn compatible(&self, state: &browser::State) -> bool {
        if state.retained_preview {
            return false;
        }
        let (Some(frame), Some(region)) = (&state.frame, &state.copy_region) else {
            return false;
        };
        state.selected_pane.as_deref() == Some(self.region.id.as_str())
            && self.regions == state.regions
            && frame.view().width() == self.frame.view().width()
            && frame.view().height() == self.frame.view().height()
            && region.id == self.region.id
            && region.left == self.region.left
            && region.top == self.region.top
            && region.width == self.region.width
            && region.height == self.region.height
    }
}
fn boundary(region: &copy::Region, x: f32, y: f32) -> Option<(u16, u16)> {
    if !x.is_finite() || !y.is_finite() {
        return None;
    }
    let y = y - f32::from(region.top);
    if y < 0. {
        return Some((0, 0));
    }
    if y >= f32::from(region.height) {
        return Some((region.height - 1, region.width));
    }
    Some((
        y.floor() as u16,
        (x - f32::from(region.left))
            .round()
            .clamp(0., f32::from(region.width)) as u16,
    ))
}
#[path = "selection_units.rs"]
mod units;

#[cfg(test)]
#[path = "selection_tests.rs"]
mod tests;

mod retained;
pub(super) use retained::Saved;
