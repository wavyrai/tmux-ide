//! Completed selection coordinates only; reconstruction uses a freshly proven viewport.
use super::*;

pub(in crate::tmux_snapshot) struct Saved {
    identity: String,
    geometry: (u16, u16, u16, u16, u16, u16),
    anchor: (u16, u16),
    head: (u16, u16),
}
impl Capture {
    pub(in crate::tmux_snapshot) fn save(&self) -> Option<Saved> {
        if self.dragging || self.empty() {
            return None;
        }
        Some(Saved {
            identity: self.identity.clone()?,
            geometry: (
                self.frame.width,
                self.frame.height,
                self.region.left,
                self.region.top,
                self.region.width,
                self.region.height,
            ),
            anchor: self.anchor,
            head: self.head,
        })
    }
}
impl Saved {
    pub(in crate::tmux_snapshot) fn restore(self, state: &browser::State) -> Option<Capture> {
        if state.retained_preview || state.selection_identity.as_ref() != Some(&self.identity) {
            return None;
        }
        let frame = state.frame.as_ref()?;
        let region = state.copy_region.as_ref()?;
        if self.geometry
            != (
                frame.width,
                frame.height,
                region.left,
                region.top,
                region.width,
                region.height,
            )
        {
            return None;
        }
        let mut capture = Capture::begin(state, f32::from(region.left), f32::from(region.top))?;
        capture.anchor = self.anchor;
        capture
            .update(
                f32::from(region.left + self.head.1),
                f32::from(region.top + self.head.0),
            )
            .ok()?;
        capture.dragging = false;
        Some(capture)
    }
}
