//! Actual macOS 26 AppKit glass, confined to preview chrome. No blur substitute.
//! The platform view remains owned by GPUI; this owner adds only a sibling below it.
use gpui::{Bounds, Pixels, Window};
#[cfg(target_os = "macos")]
mod macos;

#[derive(Default)]
pub(super) struct Glass {
    #[cfg(target_os = "macos")]
    native: Option<macos::Native>,
    #[cfg(target_os = "macos")]
    watcher: Option<macos::Watcher>,
    #[cfg(target_os = "macos")]
    active: bool,
}
impl Glass {
    /// Bounds are GPUI logical points from the content view's top-left, excluding
    /// the header. False means the caller must render opaque chrome.
    pub(super) fn sync(&mut self, window: &Window, bounds: Bounds<Pixels>, surface: u32) -> bool {
        #[cfg(target_os = "macos")]
        {
            if macos::has_native_handle(window) && self.watcher.is_none() {
                self.watcher = macos::Watcher::new();
            }
            let active = macos::sync(&mut self.native, window, bounds, surface);
            if active != self.active {
                window.set_background_appearance(if active {
                    gpui::WindowBackgroundAppearance::Transparent
                } else {
                    gpui::WindowBackgroundAppearance::Opaque
                });
                self.active = active;
                eprintln!("tmux-preview: native sidebar glass {active}");
            }
            active
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = (window, bounds, surface);
            false
        }
    }
    pub(super) fn take_policy_change(&self) -> bool {
        #[cfg(target_os = "macos")]
        {
            self.watcher.as_ref().is_some_and(macos::Watcher::take)
        }
        #[cfg(not(target_os = "macos"))]
        {
            false
        }
    }
}
// This API intentionally cannot cover a terminal: callers provide sidebar bounds,
// and width is capped at the preview's fixed 224-point navigation column.
#[cfg(any(target_os = "macos", test))]
fn rect(
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    view_width: f64,
    view_height: f64,
    flipped: bool,
) -> Option<[f64; 4]> {
    if ![x, y, width, height, view_width, view_height]
        .iter()
        .all(|v| v.is_finite())
        || x != 0.
        || y < 0.
        || width <= 0.
        || width > 224.
        || height <= 0.
        || x + width > view_width
        || y + height > view_height
    {
        return None;
    }
    Some([
        x,
        if flipped { y } else { view_height - y - height },
        width,
        height,
    ])
}
#[cfg(test)]
mod tests {
    use super::*;
    use core::prelude::v1::test;
    #[test]
    fn sidebar_rect_is_bounded_and_handles_native_coordinates() {
        assert_eq!(
            rect(0., 32., 224., 368., 640., 400., false),
            Some([0., 0., 224., 368.])
        );
        assert_eq!(
            rect(0., 32., 224., 368., 640., 400., true),
            Some([0., 32., 224., 368.])
        );
        for values in [
            [0., 32., 225., 368.],
            [0., 32., 224., 369.],
            [1., 32., 224., 368.],
            [0., -1., 224., 368.],
            [0., 0., 224., f64::NAN],
        ] {
            assert!(rect(values[0], values[1], values[2], values[3], 640., 400., true).is_none());
        }
    }
}
