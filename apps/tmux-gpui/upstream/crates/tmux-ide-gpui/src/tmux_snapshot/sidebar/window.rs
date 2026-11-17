//! The sidebar builds only the rows near its visible part. A full refresh
//! of Home at 100 sessions spent about three quarters of its frame on
//! sidebar rows, most of them off screen, and so did every frame on which
//! an agent's state changed the sidebar.
//!
//! A row more than a quarter of the list's height above or below what shows
//! is drawn as an empty box of the size it had when it was last laid out.
//! So the list keeps its length, and every row keeps its child index:
//! keyboard reveal reads rows by index (`scroll_to_item`, `bounds_for_item`),
//! and a placeholder's bounds are its row's.
//!
//! Sizes are remembered per row shape: a digest of everything the row draws.
//! A row whose content changes (a summary added, a new kind, a new label)
//! has a new shape, so it is built and measured again. A row never measured
//! is built, and so is every row after it on that frame, since where they
//! sit is not known. Every size is forgotten when the rem size changes:
//! the rows' horizontal padding is in rems, so an activity summary can wrap
//! onto another line. Nothing else that sets a row's height can change
//! without its shape changing: the list's width is the fixed `SIDEBAR_WIDTH`
//! (its scrollbar overlays the rows), the rows' text sizes and leading are
//! points from the type ladder, the theme sets only colors, and layout is in
//! points at any scale factor.
//!
//! A render plans against where the list will be when it is laid out. A
//! reveal (`scroll_to_item`) moves the list in prepaint, after the render,
//! so the render plans around the row revealed. A window grown since the
//! last layout grows the list with it, so the render plans for the taller
//! list.
//!
//! The selected row and the keyboard's row stay built wherever they are.
//! While assistive technology reads the window every row is built: VoiceOver
//! must reach every row, and a placeholder has nothing for it to read.
use gpui::*;
use std::{cell::RefCell, collections::HashMap, rc::Rc};

/// The room a row takes in the list: the space above it (the list's gap and
/// the row's own margin) and its height.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(in crate::tmux_snapshot) struct Space {
    pub lead: Pixels,
    pub height: Pixels,
}

/// The list's gap between rows. A placeholder takes the rest of its row's
/// lead as its own margin.
const GAP: Pixels = px(2.);

/// The remembered sizes, shared with the measuring element.
#[derive(Clone, Default)]
pub(in crate::tmux_snapshot) struct RowWindow(Rc<RefCell<Inner>>);

#[derive(Default)]
struct Inner {
    sizes: HashMap<u64, Space>,
    /// The rem size the sizes were measured at.
    rem: Option<Pixels>,
    /// The window's viewport height when the list was last laid out.
    viewport: Option<Pixels>,
    /// What the last render planned against.
    planned: Option<Planned>,
}

/// What a render planned against: the list's visible height and offset.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Planned {
    height: Pixels,
    offset: Pixels,
}

/// What the sidebar's render knows of its frame.
#[derive(Clone, Copy)]
pub(in crate::tmux_snapshot) struct Frame {
    /// The window's rem size.
    pub rem: Pixels,
    /// The window's viewport height.
    pub viewport: Pixels,
    /// Assistive technology reads the window: every row is built.
    pub every: bool,
    /// The list child a reveal scrolls to on this frame's layout.
    pub reveal: Option<usize>,
}

/// The list as last laid out, in its unscrolled coordinates from its top:
/// where the first row's lead begins (the Home row's bottom), its visible
/// height and its scroll offset (zero or less).
#[derive(Clone, Copy)]
pub(in crate::tmux_snapshot) struct View {
    pub start: Option<Pixels>,
    pub height: Pixels,
    pub offset: Pixels,
}

impl View {
    fn of(list: &ScrollHandle) -> Self {
        let view = list.bounds();
        Self {
            start: list
                .bounds_for_item(0)
                .map(|home| home.bottom() - view.top()),
            height: view.size.height,
            offset: list.offset().y,
        }
    }
}

impl RowWindow {
    /// For each row (in list order, after the Home row), `None` to build it
    /// or the space of the placeholder that stands for it. `keep` says which
    /// rows stay built.
    pub(in crate::tmux_snapshot) fn plan(
        &self,
        shapes: &[u64],
        frame: Frame,
        list: &ScrollHandle,
        keep: impl Fn(usize) -> bool,
    ) -> Vec<Option<Space>> {
        self.plan_at(shapes, frame, View::of(list), keep)
    }

    pub(in crate::tmux_snapshot) fn plan_at(
        &self,
        shapes: &[u64],
        frame: Frame,
        view: View,
        keep: impl Fn(usize) -> bool,
    ) -> Vec<Option<Space>> {
        let mut inner = self.0.borrow_mut();
        if inner.rem.replace(frame.rem) != Some(frame.rem) {
            inner.sizes.clear();
        }
        inner.planned = None;
        if frame.every {
            return vec![None; shapes.len()];
        }
        // The list fills the window's height: it grows as the window does.
        let grown = inner
            .viewport
            .map_or(px(0.), |then| (frame.viewport - then).max(px(0.)));
        let height = view.height + grown;
        let spaces: Vec<_> = shapes
            .iter()
            .map(|shape| inner.sizes.get(shape).copied())
            .collect();
        let Some(offset) = revealed(&spaces, view.start, height, view.offset, frame.reveal) else {
            return vec![None; shapes.len()];
        };
        let rows = plan(&spaces, view.start, height, offset, keep);
        // With every row built, no part of the list can come into view
        // unbuilt.
        inner.planned = rows
            .iter()
            .any(Option::is_some)
            .then_some(Planned { height, offset });
        rows
    }

    /// An element with no size, laid out after the list, that measures each
    /// row as laid out on this frame. When the list's visible part is not
    /// the one the render planned for, `owner` renders again on the next
    /// frame, so rows that came into view are built.
    pub(in crate::tmux_snapshot) fn measure(
        &self,
        shapes: Vec<u64>,
        list: &ScrollHandle,
        owner: EntityId,
    ) -> AnyElement {
        let window_rows = self.clone();
        let list = list.clone();
        canvas(
            move |_, window, _| {
                let bounds: Vec<_> = (0..=shapes.len())
                    .map_while(|index| list.bounds_for_item(index))
                    .collect();
                let mut inner = window_rows.0.borrow_mut();
                learn(&mut inner.sizes, &shapes, &bounds);
                inner.viewport = Some(window.viewport_size().height);
                let now = Planned {
                    height: list.bounds().size.height,
                    offset: list.offset().y,
                };
                if inner.planned.is_some_and(|planned| moved(planned, now)) {
                    window.on_next_frame(move |_, cx| cx.notify(owner));
                }
            },
            |_, _, _, _| {},
        )
        .absolute()
        .size_0()
        .into_any_element()
    }
}

fn moved(planned: Planned, now: Planned) -> bool {
    (planned.height - now.height).abs() > px(0.5) || (planned.offset - now.offset).abs() > px(0.5)
}

/// Where each row sits in the list's unscrolled coordinates (its top and
/// its space), from `start`, while every row before it has been measured.
fn places(spaces: &[Option<Space>], start: Pixels) -> Vec<Option<(Pixels, Space)>> {
    let mut at = Some(start);
    spaces
        .iter()
        .map(|space| {
            let place = at.zip(*space).map(|(at, space)| (at + space.lead, space));
            at = place.map(|(top, space)| top + space.height);
            place
        })
        .collect()
}

/// The offset the list has once `reveal` (a list child: 0 is the Home row)
/// is applied, as gpui's `scroll_to_item` moves it: the least distance that
/// shows the whole child, or its top if it is taller than the list. `None`
/// when where the child sits is not known, as after a row never measured.
pub(in crate::tmux_snapshot) fn revealed(
    spaces: &[Option<Space>],
    start: Option<Pixels>,
    height: Pixels,
    offset: Pixels,
    reveal: Option<usize>,
) -> Option<Pixels> {
    let (Some(child), Some(start)) = (reveal, start) else {
        return Some(offset);
    };
    let (top, bottom) = match child.checked_sub(1) {
        None => (px(0.), start),
        Some(row) if row >= spaces.len() => return Some(offset),
        Some(row) => {
            let (top, space) = places(spaces, start)[row]?;
            (top, top + space.height)
        }
    };
    Some(if bottom - top > height || top + offset < px(0.) {
        -top
    } else if bottom + offset > height {
        height - bottom
    } else {
        offset
    })
}

/// The rows to build. `spaces` are the remembered sizes (`None`: never
/// measured), `start` where the first row's lead begins in the list's
/// unscrolled coordinates (the Home row's bottom), `height` the list's
/// visible height and `offset` its scroll offset (zero or less).
pub(in crate::tmux_snapshot) fn plan(
    spaces: &[Option<Space>],
    start: Option<Pixels>,
    height: Pixels,
    offset: Pixels,
    keep: impl Fn(usize) -> bool,
) -> Vec<Option<Space>> {
    let (Some(start), true) = (start, height > px(0.)) else {
        return vec![None; spaces.len()];
    };
    let margin = height / 4.;
    let from = px(0.) - offset - margin;
    let to = px(0.) - offset + height + margin;
    places(spaces, start)
        .into_iter()
        .enumerate()
        .map(|(index, place)| {
            let (top, space) = place?;
            let far = top + space.height < from || top > to;
            (far && !keep(index)).then_some(space)
        })
        .collect()
}

/// The sizes of the rows as laid out: `bounds[0]` is the Home row and
/// `bounds[i + 1]` row `i`. Only the rows shown now are remembered.
pub(in crate::tmux_snapshot) fn learn(
    sizes: &mut HashMap<u64, Space>,
    shapes: &[u64],
    bounds: &[Bounds<Pixels>],
) {
    if bounds.len() != shapes.len() + 1 {
        return;
    }
    *sizes = shapes
        .iter()
        .zip(bounds.windows(2))
        .map(|(shape, pair)| {
            let space = Space {
                lead: pair[1].top() - pair[0].bottom(),
                height: pair[1].size.height,
            };
            (*shape, space)
        })
        .collect();
}

/// The box that stands for a far row: its height, and its margin above.
pub(in crate::tmux_snapshot) fn placeholder(space: Space) -> Div {
    div()
        .w_full()
        .flex_shrink_0()
        .mt(space.lead - GAP)
        .h(space.height)
}

#[cfg(test)]
#[path = "window_plan_tests.rs"]
mod tests;
