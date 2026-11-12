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
//! window before the rows come into view. A run that hasn't been measured
//! yet, or a page with no height yet, builds every row.
use gpui::{prelude::*, *};
use std::{cell::RefCell, collections::HashMap, ops::Range, rc::Rc};

/// A run of rows: (machine index, server index), or `usize::MAX` for the
/// sessions not on a listed server.
pub(in crate::tmux_snapshot) type Run = (usize, usize);

/// Where each run's first row starts, in the page's own coordinates (as if
/// it weren't scrolled), as of the last frame.
#[derive(Clone, Default)]
pub(in crate::tmux_snapshot) struct RowWindow(Rc<RefCell<HashMap<Run, Pixels>>>);

impl RowWindow {
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
        let top = self.0.borrow().get(&run).copied();
        let view = page.bounds();
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
        let tops = self.0.clone();
        let page = page.clone();
        canvas(
            move |bounds, _, cx| {
                let top = bounds.origin.y - page.offset().y;
                let before = tops.borrow_mut().insert(run, top);
                if before.is_none_or(|before| (before - top).abs() > px(0.5)) {
                    cx.notify(view);
                }
            },
            |_, _, _, _| {},
        )
        .w_full()
        .h(px(0.))
        .into_any_element()
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

use super::{SnapshotView, browser, fleet::ROW_HEIGHT};
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
        let Some(controls) = self.home_filter.as_ref().filter(|_| !rows.is_empty()) else {
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
        motion::enter_any(
            self.fleet_session_row(index, row, session, is_cursor(index, row), now, cx),
            entered,
        )
    }
}

#[cfg(test)]
#[path = "rows_window_tests.rs"]
mod tests;
