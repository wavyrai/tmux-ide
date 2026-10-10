//! A selection owns its painted frame; streaming updates cannot change its text.
use super::{Error, browser, copy, hit_regions};
use crate::terminal_painter::{Highlight, Tint};
use herdr_client::protocol::FrameData;
use std::sync::Arc;

pub(super) struct Capture {
    pub frame: Arc<FrameData>,
    region: copy::Region,
    regions: Vec<hit_regions::Region>,
    anchor: (u16, u16),
    head: (u16, u16),
    pub dragging: bool,
    pub highlights: Vec<Highlight>,
}
impl Capture {
    pub fn begin(state: &browser::State, x: f32, y: f32) -> Option<Self> {
        let frame = state.frame.clone()?;
        let region = state.copy_region.clone()?;
        if !region.valid(&frame, state.selected_pane.as_deref())
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
            frame,
            region,
            regions: state.regions.clone(),
            anchor,
            head: anchor,
            dragging: true,
            highlights: Vec::new(),
        })
    }
    pub fn update(&mut self, x: f32, y: f32) -> Result<(), Error> {
        let Some(head) = boundary(&self.region, x, y) else {
            return Ok(());
        };
        self.head = head;
        self.highlights = self
            .region
            .spans(&self.frame, self.anchor, self.head)?
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
            .text_between(&self.frame, self.anchor, self.head)
    }
    pub fn compatible(&self, state: &browser::State) -> bool {
        let (Some(frame), Some(region)) = (&state.frame, &state.copy_region) else {
            return false;
        };
        state.selected_pane.as_deref() == Some(self.region.id.as_str())
            && self.regions == state.regions
            && frame.width == self.frame.width
            && frame.height == self.frame.height
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
#[cfg(test)]
#[path = "selection_tests.rs"]
mod tests;
