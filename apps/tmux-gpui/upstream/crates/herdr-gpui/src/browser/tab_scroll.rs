//! A group's tab strip scrolls sideways once its tabs outgrow it, as an
//! editor's does: the wheel scrolls it, the chosen tab is brought into view,
//! and a thin thumb along its foot shows where the view sits and drags it.
use super::{GroupId, Pick};
use gpui::{Pixels, ScrollHandle, point, px};
use std::collections::HashMap;

/// The narrowest the thumb draws, so a strip of many tabs keeps one to grab.
const MIN_THUMB: f32 = 24.;

/// The frames a strip spends bringing a newly chosen tab into view.
const MAX_TRIES: u8 = 4;

/// What a thumb drags: the strip it scrolls.
#[derive(Clone, Copy, Debug)]
pub(crate) struct ThumbDrag(pub(crate) GroupId);

/// Where a strip's thumb sits, from the strip's left edge. The math is the
/// same along either axis, so the review's vertical scrollbar uses it too.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Thumb {
    pub(crate) left: f32,
    pub(crate) width: f32,
}

impl Thumb {
    /// The thumb for a strip `viewport` wide that scrolls `max` further,
    /// scrolled `scrolled` of the way; none when its tabs fit.
    pub(crate) fn of(viewport: f32, max: f32, scrolled: f32) -> Option<Self> {
        if viewport <= 0. || max < 0.5 {
            return None;
        }
        let width =
            (viewport * viewport / (viewport + max)).clamp(MIN_THUMB.min(viewport), viewport);
        let left = (scrolled / max).clamp(0., 1.) * (viewport - width);
        Some(Self { left, width })
    }

    /// How far a strip scrolls with this thumb moved to `left`.
    pub(crate) fn scrolled_at(self, viewport: f32, max: f32, left: f32) -> f32 {
        let travel = viewport - self.width;
        if travel <= 0. {
            return 0.;
        }
        (left / travel).clamp(0., 1.) * max
    }
}

#[derive(Default)]
struct Strip {
    handle: ScrollHandle,
    /// The tab last brought into view, so a strip the user scrolled away
    /// stays put until the choice changes.
    revealed: Option<Pick>,
    /// Where on the thumb the pointer took hold of it.
    grab: f32,
    /// The frames spent bringing `revealed` into view; at `MAX_TRIES` it is
    /// done, so a strip the user scrolls away stays put.
    tries: u8,
}

impl Strip {
    /// Whether the strip's last layout shows the tab at `index` whole, or
    /// from its left edge when it is wider than the strip.
    fn shows(&self, index: usize) -> bool {
        let Some(tab) = self.handle.bounds_for_item(index) else {
            return false;
        };
        let view = self.handle.bounds();
        if view.size.width <= Pixels::ZERO {
            return false;
        }
        let offset = self.handle.offset().x;
        let slack = px(0.5);
        tab.left() + offset >= view.left() - slack
            && (tab.right() + offset <= view.right() + slack || tab.size.width > view.size.width)
    }
}

#[derive(Default)]
pub(crate) struct TabScroll {
    strips: HashMap<GroupId, Strip>,
}

impl TabScroll {
    /// What tracks `group`'s strip.
    pub(crate) fn handle(&mut self, group: GroupId) -> ScrollHandle {
        self.strips.entry(group).or_default().handle.clone()
    }

    /// Brings the tab at `index`, `pick`, into view when it is newly chosen,
    /// or every frame while `growing`, so a tab opening at the far end is
    /// followed until it has its full width. Whether the strip needs another
    /// frame to do it.
    pub(crate) fn reveal(
        &mut self,
        group: GroupId,
        pick: &Pick,
        index: usize,
        growing: bool,
    ) -> bool {
        let strip = self.strips.entry(group).or_default();
        if strip.revealed.as_ref() != Some(pick) {
            strip.revealed = Some(pick.clone());
            strip.tries = 0;
        } else if !growing && strip.tries >= MAX_TRIES {
            return false;
        }
        // GPUI scrolls to an item by the strip's last layout, before this
        // frame's; a strip not yet laid out, or since resized, can miss, so
        // it tries again until the last layout shows the tab.
        if strip.shows(index) && !growing {
            strip.tries = MAX_TRIES;
            return false;
        }
        strip.handle.scroll_to_item(index);
        strip.tries += 1;
        strip.tries < MAX_TRIES || growing
    }

    /// The thumb `group`'s strip draws, as the strip last laid out.
    pub(crate) fn thumb(&self, group: GroupId) -> Option<Thumb> {
        let handle = &self.strips.get(&group)?.handle;
        Thumb::of(
            f32::from(handle.bounds().size.width),
            f32::from(handle.max_offset().x),
            -f32::from(handle.offset().x),
        )
    }

    /// Takes hold of `group`'s thumb with the pointer at `x`.
    pub(crate) fn grab(&mut self, group: GroupId, x: Pixels) {
        let Some(thumb) = self.thumb(group) else {
            return;
        };
        let Some(strip) = self.strips.get_mut(&group) else {
            return;
        };
        strip.grab = f32::from(x - strip.handle.bounds().left()) - thumb.left;
    }

    /// Moves `group`'s thumb with the pointer at `x`; whether it scrolled.
    pub(crate) fn drag(&mut self, group: GroupId, x: Pixels) -> bool {
        let Some(thumb) = self.thumb(group) else {
            return false;
        };
        let Some(strip) = self.strips.get(&group) else {
            return false;
        };
        let bounds = strip.handle.bounds();
        let left = f32::from(x - bounds.left()) - strip.grab;
        let scrolled = thumb.scrolled_at(
            f32::from(bounds.size.width),
            f32::from(strip.handle.max_offset().x),
            left,
        );
        let offset = strip.handle.offset();
        if (f32::from(offset.x) + scrolled).abs() < 0.5 {
            return false;
        }
        strip.handle.set_offset(point(px(-scrolled), offset.y));
        true
    }

    /// Forgets the strips of groups that are gone.
    pub(crate) fn retain(&mut self, live: impl Fn(GroupId) -> bool) {
        self.strips.retain(|group, _| live(*group));
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use super::*;
    use core::prelude::v1::test;

    #[test]
    fn a_strip_whose_tabs_fit_draws_no_thumb() {
        assert_eq!(Thumb::of(400., 0., 0.), None);
        assert_eq!(Thumb::of(0., 100., 0.), None);
    }

    #[test]
    fn the_thumb_spans_the_share_shown_and_travels_with_the_scroll() {
        // Half the tabs show, so the thumb is half the strip.
        let start = Thumb::of(400., 400., 0.).unwrap();
        assert_eq!(
            start,
            Thumb {
                left: 0.,
                width: 200.
            }
        );
        let end = Thumb::of(400., 400., 400.).unwrap();
        assert_eq!(
            end,
            Thumb {
                left: 200.,
                width: 200.
            }
        );
        // Scrolled past either end, as a bounce can, it stays in its track.
        let past = Thumb::of(400., 400., 900.).unwrap();
        assert_eq!(past.left, 200.);
    }

    #[test]
    fn many_tabs_keep_a_thumb_wide_enough_to_grab() {
        let thumb = Thumb::of(200., 100_000., 0.).unwrap();
        assert_eq!(thumb.width, MIN_THUMB);
    }

    #[test]
    fn dragging_the_thumb_scrolls_in_proportion_and_stops_at_the_ends() {
        let thumb = Thumb {
            left: 0.,
            width: 200.,
        };
        assert_eq!(thumb.scrolled_at(400., 400., 100.), 200.);
        assert_eq!(thumb.scrolled_at(400., 400., -50.), 0.);
        assert_eq!(thumb.scrolled_at(400., 400., 900.), 400.);
    }
}
