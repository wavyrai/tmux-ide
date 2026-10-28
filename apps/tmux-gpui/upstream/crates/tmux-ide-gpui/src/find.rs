//! Searching a pane's scrollback through the daemon's `pane.copy_search`.
//!
//! The daemon owns the terminal and its history, so every match comes from it;
//! this module only decides what to ask next and maps the answers onto the
//! painted grid. At most one search is in flight: a step asked for meanwhile
//! waits in a single slot and is sent, against the newest content revision,
//! once the answer arrives. Nothing here touches the window or the socket.

pub(crate) mod memory;

use crate::{
    scrollback::{push_range, viewport_top},
    terminal_painter::{Highlight, Tint},
};
use herdr_client::{
    protocol::PaneSurfacePane,
    scrollback::{
        CopySearchParams, CopySearchResult, EndpointErrorCode, SearchDirection, TextPoint,
        TextRange,
    },
};
use std::time::{Duration, Instant};

/// How often a pane whose output keeps changing is searched again. A search
/// scans the whole retained scrollback, so a busy pane must not turn the find
/// bar into a continuous daemon workload.
pub(crate) const REFRESH_INTERVAL: Duration = Duration::from_millis(500);

/// What the next search is for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Step {
    /// The query changed: the nearest match above where the bar opened.
    Query,
    /// The match before the current one, toward older output.
    Older,
    /// The match after the current one, toward newer output.
    Newer,
    /// The pane's content changed: find the current match again, leaving the
    /// view where the user has it.
    Refresh,
}

impl Step {
    /// Whether the answer moves the view to its match.
    fn reveals(self) -> bool {
        self != Self::Refresh
    }
}

/// The last answer, kept while a newer one is on its way so a busy pane's
/// highlights do not flicker.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Results {
    query: String,
    matches: Vec<TextRange>,
    current: Option<usize>,
    current_global: Option<u64>,
    total: u64,
    content_revision: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct InFlight {
    request: String,
    step: Step,
    query: String,
    content_revision: u64,
}

/// One pane's search.
#[derive(Debug)]
pub(crate) struct Search {
    pane_id: String,
    /// The bottom row of the viewport when the bar opened. A new query looks
    /// upward from here, as a terminal's own find does.
    origin: TextPoint,
    query: String,
    results: Option<Results>,
    in_flight: Option<InFlight>,
    queued: Option<Step>,
    /// The revision a `stale_content` answer refused. The queued step waits
    /// for a surface showing newer content instead of retrying at once.
    refused_revision: Option<u64>,
    last_sent: Option<Instant>,
    error: Option<String>,
}

impl Search {
    /// A search of `pane`, anchored at the bottom of what it shows now.
    pub(crate) fn new(pane: &PaneSurfacePane) -> Self {
        Self {
            pane_id: pane.pane_id.clone(),
            origin: TextPoint {
                row: viewport_top(pane).saturating_add(u32::from(pane.inner_rect.height)),
                col: 0,
            },
            query: String::new(),
            results: None,
            in_flight: None,
            queued: None,
            refused_revision: None,
            last_sent: None,
            error: None,
        }
    }

    pub(crate) fn pane_id(&self) -> &str {
        &self.pane_id
    }

    pub(crate) fn error(&self) -> Option<&str> {
        self.error.as_deref()
    }

    pub(crate) fn set_query(&mut self, query: &str) {
        if query == self.query {
            return;
        }
        query.clone_into(&mut self.query);
        self.error = None;
        self.refused_revision = None;
        if query.is_empty() {
            self.results = None;
            self.queued = None;
        } else {
            self.queued = Some(Step::Query);
        }
    }

    /// Asks for the match before or after the current one. A pending new
    /// query is answered first; its answer is the match this step would move
    /// from, so the step adds nothing.
    pub(crate) fn step(&mut self, step: Step) {
        if self.query.is_empty() || self.queued == Some(Step::Query) {
            return;
        }
        self.error = None;
        self.queued = Some(step);
    }

    /// Notices a pane whose content moved on since the shown answer, and
    /// queues a refresh no more often than [`REFRESH_INTERVAL`].
    pub(crate) fn content_changed(&mut self, pane: &PaneSurfacePane, now: Instant) {
        let Some(results) = &self.results else {
            return;
        };
        if results.content_revision == pane.content_revision
            || self.queued.is_some()
            || self.in_flight.is_some()
            || self
                .last_sent
                .is_some_and(|sent| now.saturating_duration_since(sent) < REFRESH_INTERVAL)
        {
            return;
        }
        self.queued = Some(Step::Refresh);
    }

    /// The search to send now, if one is wanted and may go: nothing is in
    /// flight and the pane's content is settled (an odd revision is a write in
    /// progress, which the daemon refuses).
    pub(crate) fn next_request(&self, pane: &PaneSurfacePane) -> Option<(Step, CopySearchParams)> {
        let step = self.queued?;
        if self.in_flight.is_some()
            || pane.pane_id != self.pane_id
            || !pane.content_revision.is_multiple_of(2)
            || self.refused_revision == Some(pane.content_revision)
            || self.query.is_empty()
        {
            return None;
        }
        let current = self
            .results
            .as_ref()
            .filter(|results| results.query == self.query)
            .and_then(|results| results.matches.get(results.current?))
            .copied();
        let (direction, cursor, previous) = match (step, current) {
            (Step::Older, Some(current)) => (SearchDirection::Backward, self.origin, Some(current)),
            (Step::Newer, Some(current)) => (SearchDirection::Forward, self.origin, Some(current)),
            // A refresh looks from just before the current match, so the same
            // match stays current if the pane still has it.
            (Step::Refresh, Some(current)) => {
                (SearchDirection::Forward, before(current.start), None)
            }
            (Step::Newer, None) => (SearchDirection::Forward, self.origin, None),
            (Step::Query | Step::Older | Step::Refresh, _) => {
                (SearchDirection::Backward, self.origin, None)
            }
        };
        Some((
            step,
            CopySearchParams {
                pane_id: self.pane_id.clone(),
                query: self.query.clone(),
                direction,
                cursor,
                content_revision: pane.content_revision,
                previous,
            },
        ))
    }

    /// Records the request `next_request` produced as sent.
    pub(crate) fn sent(
        &mut self,
        request: String,
        params: &CopySearchParams,
        step: Step,
        now: Instant,
    ) {
        self.queued = None;
        self.last_sent = Some(now);
        self.in_flight = Some(InFlight {
            request,
            step,
            query: params.query.clone(),
            content_revision: params.content_revision,
        });
    }

    /// The search could not be queued; the step is dropped and said so.
    pub(crate) fn send_failed(&mut self, error: &herdr_client::Error) {
        self.queued = None;
        self.error = Some(error.to_string());
    }

    /// Applies the answer to `request`, returning the match to scroll into
    /// view when the step that asked moves the view. Answers to anything but
    /// the request in flight, or to a query since edited, are dropped.
    pub(crate) fn answer(
        &mut self,
        request: &str,
        answer: herdr_client::Result<CopySearchResult>,
    ) -> Option<TextRange> {
        if self
            .in_flight
            .as_ref()
            .is_none_or(|sent| sent.request != request)
        {
            return None;
        }
        let sent = self.in_flight.take()?;
        let result = match answer {
            Ok(result) => result,
            Err(herdr_client::Error::Endpoint {
                code: EndpointErrorCode::StaleContent,
                ..
            }) => {
                // Ask again once the surface shows what the daemon has now.
                self.refused_revision = Some(sent.content_revision);
                self.queued = self.queued.or(Some(sent.step));
                return None;
            }
            Err(error) => {
                if sent.query == self.query {
                    self.error = Some(error.to_string());
                }
                return None;
            }
        };
        if sent.query != self.query || result.pane_id != self.pane_id {
            return None;
        }
        self.refused_revision = None;
        self.error = None;
        let current = result
            .current
            .and_then(|index| usize::try_from(index).ok())
            .filter(|index| *index < result.matches.len());
        let reveal = current
            .and_then(|index| result.matches.get(index))
            .copied()
            .filter(|_| sent.step.reveals());
        self.results = Some(Results {
            query: sent.query,
            matches: result.matches,
            current,
            current_global: result.current_global.filter(|_| current.is_some()),
            total: result.total,
            content_revision: result.content_revision,
        });
        reveal
    }

    /// The search waiting for its answer, if any.
    pub(crate) fn in_flight(&self) -> Option<&str> {
        self.in_flight.as_ref().map(|sent| sent.request.as_str())
    }

    /// The count shown beside the query: "3 of 17", or "No results". Empty
    /// until the first answer for the query arrives.
    pub(crate) fn label(&self) -> String {
        let Some(results) = self.results.as_ref().filter(|r| r.query == self.query) else {
            return String::new();
        };
        match (results.total, results.current_global) {
            (0, _) => "No results".into(),
            (total, Some(index)) => format!("{} of {total}", index.saturating_add(1)),
            (total, None) => format!("{total} found"),
        }
    }

    /// Whether the shown answer has any match to move between.
    pub(crate) fn has_matches(&self) -> bool {
        self.results
            .as_ref()
            .is_some_and(|results| results.query == self.query && results.total > 0)
    }

    /// The tinted cells of every match `pane` shows, in the surface frame's
    /// grid. Rows are mapped through the pane's current scroll position, so a
    /// match keeps its place as the user scrolls.
    pub(crate) fn highlights(&self, pane: &PaneSurfacePane) -> Vec<Highlight> {
        let Some(results) = self
            .results
            .as_ref()
            .filter(|results| results.query == self.query && pane.pane_id == self.pane_id)
        else {
            return Vec::new();
        };
        let mut highlights = Vec::new();
        for (index, range) in results.matches.iter().enumerate() {
            let tint = if results.current == Some(index) {
                Tint::CurrentMatch
            } else {
                Tint::Match
            };
            push_range(pane, *range, tint, &mut highlights);
        }
        highlights
    }
}

/// The cell just before `point` in reading order. The daemon only compares
/// points, so a column past the row's end is a valid stand-in for "the end of
/// the previous row".
fn before(point: TextPoint) -> TextPoint {
    match point.col.checked_sub(1) {
        Some(col) => TextPoint { col, ..point },
        None => TextPoint {
            row: point.row.saturating_sub(1),
            col: u16::MAX,
        },
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests;
