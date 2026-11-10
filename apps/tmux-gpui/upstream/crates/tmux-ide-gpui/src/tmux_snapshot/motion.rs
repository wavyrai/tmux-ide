//! Bezel motion for the app's chrome (#761): the hand-driven parts.
//!
//! Menus, dialogs, the status slot, the top-row notice and the sidebar's
//! contents enter through `bezel_motion`'s own helpers (`menu_in`,
//! `dialog_in`, `fade_quick`), which gpui snaps under Reduce motion. What
//! needs memory across renders lives here instead: Home's rows arriving
//! while Home is open, a machine's chevron turning and its rows opening,
//! and the sidebar's scroll glide. Each reads the catalog's spec, takes the
//! Reduce motion flag, and reports when it has settled so nothing asks for
//! frames after that.
use bezel_motion::{CHEVRON, COLLAPSE, FADE_IN, MotionSpec, SCROLL_GLIDE};
use gpui::{AnyElement, IntoElement, ParentElement, Pixels, Styled, div, px};
use std::{
    collections::{HashMap, HashSet},
    time::{Duration, Instant},
};

/// The rise, in points, of an entrance that fades in over FADE_IN or
/// COLLAPSE: `bezel_motion::fade_in`'s 4 pt.
pub(super) const RISE: f32 = 4.;

/// How far `spec` has eased `elapsed` after it started: 0 at the start, 1
/// once its duration has passed, and 1 at once under Reduce motion.
pub(super) fn progress(spec: &MotionSpec, elapsed: Duration, reduced: bool) -> f32 {
    let total = spec.total().mul_f32(bezel_motion::speed_scale());
    if reduced || total.is_zero() || elapsed >= total {
        return 1.;
    }
    spec.progress(elapsed.as_secs_f32() / total.as_secs_f32())
}

/// Draws an entrance at `t`: faded and lowered by [`RISE`] at 0, untouched
/// at 1, so a settled element carries no motion style.
pub(super) fn enter<E: Styled>(element: E, t: f32) -> E {
    if t >= 1. {
        return element;
    }
    element.relative().opacity(t).top(px(RISE * (1. - t)))
}

/// [`enter`] for an element that cannot take styles: a wrapper carries
/// them while it moves, and goes once it settles.
pub(super) fn enter_any(element: AnyElement, t: f32) -> AnyElement {
    if t >= 1. {
        return element;
    }
    enter(div().flex().flex_col().min_w_0(), t)
        .child(element)
        .into_any_element()
}

/// A chevron turning over CHEVRON. gpui has no rotation for a div, so,
/// as Bezel's catalog says, the new chevron cross-fades in.
pub(super) fn turn(element: AnyElement, t: f32) -> AnyElement {
    if t >= 1. {
        return element;
    }
    div()
        .flex_shrink_0()
        .opacity(t)
        .child(element)
        .into_any_element()
}

/// How a Home row or machine came onto the page.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Entry {
    /// It arrived while Home was open: FADE_IN.
    Arrived,
    /// Its machine opened: COLLAPSE.
    Revealed,
}
impl Entry {
    fn spec(self) -> &'static MotionSpec {
        match self {
            Self::Arrived => &FADE_IN,
            Self::Revealed => &COLLAPSE,
        }
    }
}

/// What Home showed on its last render, and what is still entering.
#[derive(Default)]
struct Visit {
    /// Each machine's collapsed state, by its key.
    machines: HashMap<String, bool>,
    /// Every row's key.
    rows: HashSet<String>,
    entering: HashMap<String, (Instant, Entry)>,
    /// Machines whose chevron is turning, since when.
    turning: HashMap<String, Instant>,
}

/// One machine as Home's data holds it this render: its key, whether it is
/// collapsed, and its rows' keys, collapsed or not.
pub(super) struct Machine<'a> {
    pub key: &'a str,
    pub collapsed: bool,
    pub rows: Vec<String>,
}

/// Home's entrances, for one visit to Home. The first render of a visit
/// records what is there and animates none of it; later renders animate
/// what is new. The key is the session's or machine's id, so a republished
/// catalog never replays a row.
#[derive(Default)]
pub(in crate::tmux_snapshot) struct HomeMotion {
    visit: Option<Visit>,
}
impl HomeMotion {
    /// Home closed: the next render starts a new visit.
    pub(super) fn end(&mut self) {
        self.visit = None;
    }

    /// Records this render's machines and rows at `now`.
    pub(super) fn observe(&mut self, machines: &[Machine<'_>], now: Instant) {
        let Some(visit) = self.visit.as_mut() else {
            self.visit = Some(Visit {
                machines: machines
                    .iter()
                    .map(|m| (m.key.to_owned(), m.collapsed))
                    .collect(),
                rows: machines
                    .iter()
                    .flat_map(|m| m.rows.iter().cloned())
                    .collect(),
                ..Visit::default()
            });
            return;
        };
        let mut rows = HashSet::new();
        for machine in machines {
            match visit.machines.get(machine.key).copied() {
                // A new machine enters as one group; its rows come with it.
                None => {
                    visit
                        .entering
                        .insert(machine.key.to_owned(), (now, Entry::Arrived));
                }
                Some(was) if was != machine.collapsed => {
                    visit.turning.insert(machine.key.to_owned(), now);
                    if !machine.collapsed {
                        for row in &machine.rows {
                            visit.entering.insert(row.clone(), (now, Entry::Revealed));
                        }
                    }
                }
                Some(_) => {
                    for row in machine.rows.iter().filter(|r| !visit.rows.contains(*r)) {
                        visit.entering.insert(row.clone(), (now, Entry::Arrived));
                    }
                }
            }
            rows.extend(machine.rows.iter().cloned());
        }
        visit.machines = machines
            .iter()
            .map(|m| (m.key.to_owned(), m.collapsed))
            .collect();
        visit.rows = rows;
        // Gone rows and machines stop entering; collapsing snaps shut.
        visit
            .entering
            .retain(|key, _| visit.rows.contains(key) || visit.machines.contains_key(key));
        visit
            .turning
            .retain(|key, _| visit.machines.contains_key(key));
    }

    /// How far the row or machine `key` has entered: 1 when it is settled.
    pub(super) fn entered(&self, key: &str, now: Instant, reduced: bool) -> f32 {
        self.visit
            .as_ref()
            .and_then(|v| v.entering.get(key))
            .map_or(1., |(start, entry)| {
                progress(entry.spec(), now.saturating_duration_since(*start), reduced)
            })
    }

    /// How far the machine `key`'s chevron has turned: 1 when it is settled.
    pub(super) fn chevron(&self, key: &str, now: Instant, reduced: bool) -> f32 {
        self.visit
            .as_ref()
            .and_then(|v| v.turning.get(key))
            .map_or(1., |start| {
                progress(&CHEVRON, now.saturating_duration_since(*start), reduced)
            })
    }

    /// Drops what has settled. True while something still moves, so the
    /// caller asks for one more frame; false means no frame is owed.
    pub(super) fn settle(&mut self, now: Instant, reduced: bool) -> bool {
        let Some(visit) = self.visit.as_mut() else {
            return false;
        };
        visit.entering.retain(|_, (start, entry)| {
            progress(entry.spec(), now.saturating_duration_since(*start), reduced) < 1.
        });
        visit.turning.retain(|_, start| {
            progress(&CHEVRON, now.saturating_duration_since(*start), reduced) < 1.
        });
        !visit.entering.is_empty() || !visit.turning.is_empty()
    }
}

/// Home's machines and rows as `state` holds them: the fleet's machines,
/// or, without a fleet, the local catalog as one unnamed machine.
pub(super) fn home_machines(state: &super::browser::State) -> Vec<Machine<'_>> {
    match &state.fleet {
        Some(fleet) => fleet
            .groups
            .iter()
            .map(|group| Machine {
                key: &group.id,
                collapsed: group.collapsed,
                rows: group
                    .sessions
                    .iter()
                    .map(|s| fleet_row_key(&group.id, &s.id, s.server_id.as_deref()))
                    .collect(),
            })
            .collect(),
        None => vec![Machine {
            key: "",
            collapsed: false,
            rows: state.sessions.iter().map(|s| s.id.clone()).collect(),
        }],
    }
}

impl super::SnapshotView {
    /// How far Home's row or machine `key` has entered: 1 when settled.
    pub(super) fn home_entered(&self, key: &str, now: Instant, reduced: bool) -> f32 {
        self.home_filter
            .as_ref()
            .map_or(1., |c| c.motion.entered(key, now, reduced))
    }

    /// How far the machine `key`'s chevron has turned: 1 when settled.
    pub(super) fn home_chevron(&self, key: &str, now: Instant, reduced: bool) -> f32 {
        self.home_filter
            .as_ref()
            .map_or(1., |c| c.motion.chevron(key, now, reduced))
    }
}

/// The key of a fleet session's row on Home.
pub(super) fn fleet_row_key(machine: &str, session: &str, server: Option<&str>) -> String {
    format!(
        "{machine}\u{1f}{}\u{1f}{session}",
        server.unwrap_or_default()
    )
}

/// A scroll glide over SCROLL_GLIDE, for the sidebar's reveal.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct Glide {
    from: Pixels,
    to: Pixels,
    start: Instant,
    /// The offset the glide last set: anything else means the user scrolled.
    last: Pixels,
}
impl Glide {
    pub(super) fn new(from: Pixels, to: Pixels, start: Instant) -> Self {
        Self {
            from,
            to,
            start,
            last: from,
        }
    }

    pub(super) fn target(&self) -> Pixels {
        self.to
    }

    /// The offset for `now`, or None once the user has moved the list
    /// (`current` is not where the glide left it). The bool says whether the
    /// glide has more frames to run.
    pub(super) fn step(
        &mut self,
        current: Pixels,
        now: Instant,
        reduced: bool,
    ) -> Option<(Pixels, bool)> {
        if (current - self.last).abs() > px(0.5) {
            return None;
        }
        let t = progress(
            &SCROLL_GLIDE,
            now.saturating_duration_since(self.start),
            reduced,
        );
        let at = self.from + (self.to - self.from) * t;
        self.last = at;
        Some((at, t < 1.))
    }
}

/// The offset that brings an item into view the least distance, as gpui's
/// `scroll_to_item` would: `view` and `item` are (top, bottom) with the
/// item laid out at offset 0, and `max` is how far the list can scroll.
pub(super) fn reveal_offset(
    view: (Pixels, Pixels),
    item: (Pixels, Pixels),
    offset: Pixels,
    max: Pixels,
) -> Pixels {
    let target = if item.1 - item.0 > view.1 - view.0 || item.0 + offset < view.0 {
        view.0 - item.0
    } else if item.1 + offset > view.1 {
        view.1 - item.1
    } else {
        offset
    };
    target.max(-max).min(px(0.))
}

#[cfg(test)]
#[path = "motion_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "motion_view_tests.rs"]
mod view_tests;
