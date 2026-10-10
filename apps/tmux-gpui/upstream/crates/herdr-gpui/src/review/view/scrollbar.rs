//! The diff's scrollbar: a thumb along the list's right edge that shows where
//! the view sits and how much of the diff it holds, and drags it. Its size
//! and travel are the tab strip's thumb math, turned on its side. Side by
//! side, the line between the halves drags here too, over every row.
//!
//! Wrapped rows are only measured once they lay out, so the rest count as
//! one line each: the thumb is an estimate that settles as the diff scrolls.
use super::Layout;
use crate::browser::TabId;
use crate::{
    HerdrWindow,
    browser::Thumb,
    panel_resize::{PanelDrag, divider},
};
use gpui::{prelude::*, *};
use std::{cell::Cell, rc::Rc};

/// How wide the thumb draws, and its margin from the list's edge.
const WIDTH: f32 = 8.;
const INSET: f32 = 2.;

/// How opaque the thumb draws over the muted color, then hovered or held.
const ALPHA: u32 = 0x60;
const HOVER_ALPHA: u32 = 0x90;
const HELD_ALPHA: u32 = 0xc0;

/// What the diff's thumb drags.
#[derive(Clone, Copy, Debug)]
struct DiffThumb;

/// Gives the rows the list has not measured a one-line height whenever
/// its width changes, which makes it forget them, so the thumb's size and
/// travel stay close; laid out after the list, then draws again.
fn keep_hints(
    state: ListState,
    hinted: Rc<Cell<Option<Pixels>>>,
    line: Pixels,
) -> impl IntoElement {
    canvas(
        move |_, window, _| {
            let width = state.viewport_bounds().size.width;
            if width <= px(0.) || hinted.get() == Some(width) {
                return;
            }
            hinted.set(Some(width));
            state.clone().with_uniform_item_height(line);
            window.refresh();
        },
        |_, _, _, _| {},
    )
    .absolute()
    .size_0()
}

impl HerdrWindow {
    /// The thumb as the list last laid out; none while it all fits.
    fn review_thumb(&self, id: TabId) -> Option<(Thumb, Bounds<Pixels>, f32)> {
        let review = self.reviews.get(&id)?;
        let bounds = review.scroll.viewport_bounds();
        let max = f32::from(review.scroll.max_offset_for_scrollbar().y);
        let thumb = Thumb::of(
            f32::from(bounds.size.height),
            max,
            -f32::from(review.scroll.scroll_px_offset_for_scrollbar().y),
        )?;
        Some((thumb, bounds, max))
    }

    pub(super) fn grab_review_thumb(&mut self, id: TabId, y: Pixels) {
        let Some((thumb, bounds, _)) = self.review_thumb(id) else {
            return;
        };
        if let Some(review) = self.reviews.get_mut(&id) {
            review.grab = f32::from(y - bounds.top()) - thumb.left;
        }
    }

    /// Moves the thumb with the pointer at `y`; whether the list scrolled.
    pub(super) fn drag_review_thumb(&mut self, id: TabId, y: Pixels) -> bool {
        let Some((thumb, bounds, max)) = self.review_thumb(id) else {
            return false;
        };
        let Some(review) = self.reviews.get(&id) else {
            return false;
        };
        let top = f32::from(y - bounds.top()) - review.grab;
        let scrolled = thumb.scrolled_at(f32::from(bounds.size.height), max, top);
        let offset = review.scroll.scroll_px_offset_for_scrollbar();
        if (f32::from(offset.y) + scrolled).abs() < 0.5 {
            return false;
        }
        review
            .scroll
            .set_offset_from_scrollbar(point(offset.x, px(-scrolled)));
        true
    }

    /// `list` with the scrollbar over its right edge.
    pub(super) fn review_scroll_area(
        &self,
        id: TabId,
        list: impl IntoElement,
        cx: &mut Context<Self>,
    ) -> Stateful<Div> {
        let muted = self.theme.muted;
        let color = move |alpha: u32| rgba((muted << 8) | alpha);
        let thumb = self.review_thumb(id).map(|(thumb, _, _)| {
            div()
                .id("review-scroll-thumb")
                .debug_selector(|| "review-scroll-thumb".into())
                .absolute()
                .right(px(INSET))
                .top(px(thumb.left))
                .w(px(WIDTH))
                .h(px(thumb.width))
                .rounded_full()
                .bg(color(ALPHA))
                // The wheel still scrolls the diff over the thumb.
                .block_mouse_except_scroll()
                .hover(|s| s.bg(color(HOVER_ALPHA)))
                .active(|s| s.bg(color(HELD_ALPHA)))
                .on_mouse_down(
                    MouseButton::Left,
                    cx.listener(move |this, event: &MouseDownEvent, _, cx| {
                        cx.stop_propagation();
                        this.grab_review_thumb(id, event.position.y);
                    }),
                )
                .on_drag(DiffThumb, |_, _, _, cx| cx.new(|_| EmptyView))
        });
        // The halves split the list's width, as it last laid out.
        let split = self.reviews.get(&id).and_then(|review| {
            let width = review.scroll.viewport_bounds().size.width;
            (review.layout == Layout::Split && width > px(0.)).then(|| width * review.split_ratio)
        });
        let split = split.map(|x| {
            divider(
                "review-split-divider",
                x,
                PanelDrag::DiffSides,
                cx.listener(move |this, _, _, cx| {
                    this.reset_review_split(id);
                    cx.notify();
                }),
            )
        });
        let hints = self.reviews.get(&id).map(|review| {
            keep_hints(
                review.scroll.clone(),
                review.hinted.clone(),
                px(self.review_line_height()),
            )
        });
        div()
            .id("review-scroll-area")
            .relative()
            .flex_1()
            .min_h_0()
            .flex()
            .flex_col()
            .on_drag_move(
                cx.listener(move |this, event: &DragMoveEvent<DiffThumb>, _, cx| {
                    if this.drag_review_thumb(id, event.event.position.y) {
                        cx.notify();
                    }
                }),
            )
            .on_drag_move(
                cx.listener(move |this, event: &DragMoveEvent<PanelDrag>, _, cx| {
                    if *event.drag(cx) == PanelDrag::DiffSides
                        && this.drag_review_split(id, event.bounds, event.event.position.x)
                    {
                        cx.notify();
                    }
                }),
            )
            .child(list)
            .children(hints)
            .children(split)
            .children(thumb)
    }
}
