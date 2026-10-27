//! Retained native images projected onto the exact displayed terminal frame.
use super::{browser::State, display_frame::DisplayFrame};
use crate::tmux_native_surface::{
    Image,
    driver::{Error, Inbox},
};
use herdr_client::tmux_topology::{PresentedWindow, WindowPaint};
use std::sync::Arc;

struct Projection {
    frame: DisplayFrame,
    window: Arc<WindowPaint>,
    coherent: bool,
    history: usize,
}
#[derive(Default)]
pub(super) struct Scene {
    pub inbox: Option<Inbox>,
    images: Vec<Image>,
    last: Option<Projection>,
}
impl Scene {
    pub fn new(inbox: Option<Inbox>) -> Self {
        Self {
            inbox,
            ..Self::default()
        }
    }
    pub fn apply(
        &mut self,
        state: &mut State,
        window: &PresentedWindow,
        history: usize,
    ) -> Result<bool, Error> {
        let received = self
            .inbox
            .as_ref()
            .map(Inbox::drain)
            .transpose()?
            .flatten()
            .unwrap_or_default();
        Ok(self.apply_images(state, window, history, received))
    }
    fn apply_images(
        &mut self,
        state: &mut State,
        window: &PresentedWindow,
        history: usize,
        received: Vec<Image>,
    ) -> bool {
        let prior = self.images.len();
        self.images.retain(|image| image.current(window));
        let mut changed = self.images.len() != prior;
        for image in received {
            if !image.current(window) {
                continue;
            }
            if let Some(index) = self.images.iter().position(|old| old.same_surface(&image)) {
                self.images[index] = image;
                changed = true;
            } else if self.images.len() < 8 {
                self.images.push(image);
                changed = true;
            }
        }
        let Some(frame) = &state.frame else {
            return self.clear(state) || changed;
        };
        if self.images.is_empty() {
            return self.clear(state) || changed;
        }
        if !changed
            && self.last.as_ref().is_some_and(|last| {
                last.frame.same(frame)
                    && Arc::ptr_eq(&last.window, &window.paint)
                    && last.coherent == window.coherent
                    && last.history == history
            })
            && state.native_surfaces.is_some()
        {
            return false;
        }
        let paints = self
            .images
            .iter()
            .filter_map(|image| image.project(window, history))
            .collect();
        self.last = Some(Projection {
            frame: frame.clone(),
            window: Arc::clone(&window.paint),
            coherent: window.coherent,
            history,
        });
        state.native_surfaces = Some((frame.clone(), paints));
        true
    }
    pub fn clear(&mut self, state: &mut State) -> bool {
        let changed = !self.images.is_empty() || state.native_surfaces.is_some();
        self.images.clear();
        self.last = None;
        state.native_surfaces = None;
        changed
    }
}
#[cfg(test)]
#[path = "browser_native_surfaces_tests.rs"]
mod tests;
