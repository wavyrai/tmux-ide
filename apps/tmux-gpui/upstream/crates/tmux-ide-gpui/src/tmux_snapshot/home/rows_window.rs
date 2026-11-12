//! Home's session table builds only the rows near the visible part of the
//! page (perf plan, finding 2). The rest of each run of rows becomes one
//! spacer of the same height, so the page lays out exactly as before and its
//! scroll position doesn't move.
//!
//! Home scrolls as one page: its header, filters, table and agent line move
//! together. A `uniform_list` needs a scroll area of its own, which would pin
//! the header and change the page. So the window is worked out against the
//! page's scroll instead: rows are a fixed height (`fleet::ROW_HEIGHT`), and a
//! zero-height marker at the top of each run records where the run sat on
//! the last frame. Scrolling notifies the view, so the next render widens the
//! window before the rows come into view. A page that is a new size (a zoom,
//! full screen) renders again once it is laid out, as a moved run does. A run
//! that hasn't been measured yet, or a page with no height yet, builds every
//! row. So does a window that assistive technology is reading: VoiceOver
//! must reach every row, and a spacer has nothing for it to read.
use gpui::{prelude::*, *};
use std::{
    cell::{Cell, RefCell},
    collections::HashMap,
    ops::Range,
    rc::Rc,
};

/// A run of rows: (machine index, server index), or `usize::MAX` for the
/// sessions not on a listed server.
pub(in crate::tmux_snapshot) type Run = (usize, usize);

/// Where each run's first row starts, in the page's own coordinates (as if
/// it weren't scrolled), as of the last frame; and the page's visible top
/// and bottom the last render planned for.
#[derive(Clone, Default)]
pub(in crate::tmux_snapshot) struct RowWindow {
    tops: Rc<RefCell<HashMap<Run, Pixels>>>,
    planned: Rc<Cell<Option<(Pixels, Pixels)>>>,
    /// Assistive technology is reading the window: every row is built.
    assistive: Rc<Cell<bool>>,
    /// How many renders the markers have asked for.
    #[cfg(test)]
    asked: Rc<Cell<usize>>,
}

impl RowWindow {
    /// Notes, at each render, whether assistive technology is reading
    /// `window`. gpui draws the window afresh when that starts or stops, so
    /// the rows are all there before the first accessibility tree is sent.
    pub(in crate::tmux_snapshot) fn observe(&self, window: &Window) {
        self.assistive.set(window.is_a11y_active());
    }

    /// Where each run sat on the last frame.
    pub(super) fn tops(&self) -> Vec<(Run, Pixels)> {
        self.tops
            .borrow()
            .iter()
            .map(|(run, top)| (*run, *top))
            .collect()
    }

    /// Whether every row is built, for assistive technology.
    pub(in crate::tmux_snapshot) fn every_row(&self) -> bool {
        self.assistive.get()
    }

    /// What to lay out for the `count` rows of `run`, `height` tall each,
    /// for the page scrolled as `page` says; `keep` is a row that must stay
    /// built wherever it is (the keyboard's).
    pub(in crate::tmux_snapshot) fn plan(
        &self,
        run: Run,
        count: usize,
        height: Pixels,
        page: &ScrollHandle,
        keep: Option<usize>,
    ) -> Vec<Span> {
        plan(count, self.rows(run, count, height, page), keep)
    }

    fn rows(&self, run: Run, count: usize, height: Pixels, page: &ScrollHandle) -> Range<usize> {
        let top = self.tops.borrow().get(&run).copied();
        let view = page.bounds();
        self.planned.set(Some((view.top(), view.bottom())));
        visible(
            top,
            count,
            height,
            (view.top(), view.bottom()),
            page.offset().y,
        )
    }

    /// A zero-height element at the top of `run` that records where the run
    /// starts when it is laid out. When that isn't where the render assumed
    /// (a new table shape, or the first frame), `view` renders again, so the
    /// window is never built against a stale place.
    pub(in crate::tmux_snapshot) fn marker(
        &self,
        run: Run,
        page: &ScrollHandle,
        view: EntityId,
    ) -> AnyElement {
        let tops = self.tops.clone();
        #[cfg(test)]
        let asked = self.asked.clone();
        let page = page.clone();
        canvas(
            move |bounds, window, _| {
                let top = bounds.origin.y - page.offset().y;
                let before = tops.borrow_mut().insert(run, top);
                let moved = before.is_none_or(|before| (before - top).abs() > px(0.5));
                if moved {
                    #[cfg(test)]
                    asked.set(asked.get() + 1);
                    // Not during this draw: the next frame renders again.
                    window.on_next_frame(move |_, cx| cx.notify(view));
                }
            },
            |_, _, _, _| {},
        )
        .w_full()
        .h(px(0.))
        .into_any_element()
    }
}

impl RowWindow {
    /// An element with no size, laid out with the table on every frame the
    /// page draws, replayed table or not. When the page's visible part isn't
    /// the one the rows were last planned for (a zoom, full screen), `view`
    /// renders again, so the rows that came into view are built on the next
    /// frame.
    pub(in crate::tmux_snapshot) fn watch(
        &self,
        page: &ScrollHandle,
        view: EntityId,
    ) -> AnyElement {
        let planned = self.planned.clone();
        #[cfg(test)]
        let asked = self.asked.clone();
        let page = page.clone();
        canvas(
            move |_, window, _| {
                // The page is laid out by now: its bounds are this frame's.
                let shown = page.bounds();
                let resized = planned.get().is_some_and(|(from, to)| {
                    (from - shown.top()).abs() > px(0.5) || (to - shown.bottom()).abs() > px(0.5)
                });
                if resized {
                    #[cfg(test)]
                    asked.set(asked.get() + 1);
                    // Not during this draw: the next frame renders again.
                    window.on_next_frame(move |_, cx| cx.notify(view));
                }
            },
            |_, _, _, _| {},
        )
        .absolute()
        .size_0()
        .into_any_element()
    }
}

#[cfg(test)]
impl RowWindow {
    /// Forgets where every run was, as a new table shape would move them.
    pub(in crate::tmux_snapshot) fn forget(&self) {
        self.tops.borrow_mut().clear();
    }

    /// How many renders the markers have asked for so far.
    pub(in crate::tmux_snapshot) fn asked(&self) -> usize {
        self.asked.get()
    }
}

/// One piece of a run: a row to build, or a spacer for rows that aren't.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(in crate::tmux_snapshot) enum Span {
    Row(usize),
    Gap(usize),
}

/// The rows in `built`, plus `keep`, in order; every stretch between them
/// becomes one spacer.
pub(in crate::tmux_snapshot) fn plan(
    count: usize,
    built: Range<usize>,
    keep: Option<usize>,
) -> Vec<Span> {
    let mut out = Vec::new();
    let mut gap = 0;
    for row in 0..count {
        if built.contains(&row) || keep == Some(row) {
            if gap > 0 {
                out.push(Span::Gap(gap));
                gap = 0;
            }
            out.push(Span::Row(row));
        } else {
            gap += 1;
        }
    }
    if gap > 0 {
        out.push(Span::Gap(gap));
    }
    out
}

/// One spacer for `rows` rows that aren't built.
pub(in crate::tmux_snapshot) fn spacer(rows: usize, height: Pixels) -> AnyElement {
    div()
        .flex_none()
        .w_full()
        .h(height * rows as f32)
        .into_any_element()
}

/// The rows of a run to build: those within a quarter of a page above or
/// below the visible part. Scrolling notifies the view before the frame that
/// shows the new rows, so the margin only covers a frame that lags (a
/// scrollbar drag). `top` is where the run starts in page coordinates,
/// `view` the page's visible top and bottom in window coordinates, `offset`
/// the page's scroll offset (zero or less).
pub(in crate::tmux_snapshot) fn visible(
    top: Option<Pixels>,
    count: usize,
    height: Pixels,
    view: (Pixels, Pixels),
    offset: Pixels,
) -> Range<usize> {
    let (Some(top), true) = (top, view.1 > view.0 && height > px(0.)) else {
        return 0..count;
    };
    let span = (view.1 - view.0) / 4.;
    // The run's first row, where it is on screen now.
    let start = top + offset;
    let from = view.0 - span;
    let to = view.1 + span;
    let first = ((from - start) / height).floor().max(0.) as usize;
    let last = ((to - start) / height).ceil().max(0.) as usize;
    first.min(count)..last.min(count).max(first.min(count))
}

use super::{SnapshotView, browser, fleet::ROW_HEIGHT, row_root::row_root};

const ROW_HEIGHT_PX: Pixels = px(ROW_HEIGHT);
use crate::tmux_snapshot::motion;

impl SnapshotView {
    /// One run of session rows: those near the visible part of the page,
    /// and spacers of the same height for the rest (perf plan, finding 2).
    /// `time` is the clock for "last active", the motion clock, and whether
    /// motion is reduced.
    pub(super) fn fleet_run(
        &self,
        run: Run,
        rows: &[(usize, &browser::fleet::Session)],
        group: &browser::fleet::Group,
        is_cursor: &dyn Fn(usize, usize) -> bool,
        time: (i64, std::time::Instant, bool),
        cx: &mut Context<Self>,
    ) -> Vec<AnyElement> {
        let (now, clock, reduced) = time;
        let (index, _) = run;
        let height = px(ROW_HEIGHT);
        let mut out = Vec::new();
        let Some(controls) = self
            .home_filter
            .as_ref()
            .filter(|controls| !rows.is_empty() && !controls.rows.every_row())
        else {
            for &(row, session) in rows {
                out.push(self.fleet_run_row(group, index, row, session, is_cursor, time, cx));
            }
            return out;
        };
        let keep = rows.iter().position(|(row, _)| is_cursor(index, *row));
        let plan = controls
            .rows
            .plan(run, rows.len(), height, &controls.page_scroll, keep);
        out.reserve(plan.len() + 1);
        out.push(
            controls
                .rows
                .marker(run, &controls.page_scroll, cx.entity_id()),
        );
        for span in plan {
            out.push(match span {
                Span::Gap(count) => spacer(count, height),
                Span::Row(at) => {
                    let (row, session) = rows[at];
                    self.fleet_run_row(
                        group,
                        index,
                        row,
                        session,
                        is_cursor,
                        (now, clock, reduced),
                        cx,
                    )
                }
            });
        }
        out
    }

    #[allow(clippy::too_many_arguments)]
    fn fleet_run_row(
        &self,
        group: &browser::fleet::Group,
        index: usize,
        row: usize,
        session: &browser::fleet::Session,
        is_cursor: &dyn Fn(usize, usize) -> bool,
        (now, clock, reduced): (i64, std::time::Instant, bool),
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let key = motion::fleet_row_key(&group.id, &session.id, session.server_id.as_deref());
        let entered = self.home_entered(&key, clock, reduced);
        // Laid out on its own: the page's measure passes stop at its box.
        let row = self.fleet_session_row(index, row, session, is_cursor(index, row), now, cx);
        motion::enter_any(row_root(ROW_HEIGHT_PX, row).into_any_element(), entered)
    }
}

#[cfg(test)]
#[path = "rows_window_tests.rs"]
mod tests;
