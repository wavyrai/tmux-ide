//! Reordering tabs by dragging them along their strip, as workspace rows are
//! dragged in the sidebar. Holding a press on a tab, or moving it a few
//! pixels, lifts it; the tabs it passes slide aside, so the gap they open is
//! where it lands, and the strip scrolls when it is carried to either end.
//!
//! A Herdr tab moves with `tab.move`. The daemon owns the order, so the
//! preview holds until the next snapshot reorders the strip, the same for
//! every attached client. A browser tab is this client's own and moves at
//! once. Each kind moves among its own, since Herdr tabs always lead a strip.

use super::HerdrWindow;
use crate::{
    browser::{GroupId, Pick, Store},
    motion,
    reorder::{Beside, LIFT_DELAY, LIFT_DISTANCE, SETTLE_TIMEOUT, SLIDE, Slide, preview, slot_for},
};
use gpui::{Context, Pixels, Point, ScrollHandle, Task, px};
use herdr_client::{Method, protocol::ClientShellSnapshot};
use std::{
    cell::{Cell, RefCell},
    collections::HashMap,
    time::{Duration, Instant},
};

/// How near the strip's ends a carried tab scrolls it.
const EDGE: f32 = 32.;
/// How fast a carried tab scrolls the strip, in pixels a second, at the very
/// end; slower further in.
const EDGE_SPEED: f32 = 900.;
/// The step the first frame at an end scrolls, as one frame at 60 Hz.
const FIRST_STEP: Duration = Duration::from_millis(16);
/// The longest step one frame scrolls, so a stalled frame does not jump.
const MAX_STEP: Duration = Duration::from_millis(50);
/// How long a lifted tab takes to grow. Tests settle at once, as slides do.
const GROW: Duration = if cfg!(test) {
    Duration::ZERO
} else {
    motion::ENTER
};

/// A press on a tab that may become a reorder.
pub(crate) struct TabDrag {
    group: GroupId,
    pub(super) pick: Pick,
    /// The boot a Herdr tab's move is sent to.
    boot: Option<String>,
    origin: Point<Pixels>,
    pointer: Point<Pixels>,
    /// The strip's scroll when pressed, so the carried tab stays under the
    /// pointer while the strip scrolls beneath it.
    scrolled: Pixels,
    pub(super) lifted: Option<Instant>,
    /// Where it lands, `None` over its own place.
    pub(super) target: Option<Target>,
    /// The workspace's Herdr tab order when the move was sent, kept so the
    /// preview lasts exactly until the daemon's answer.
    dropped: Option<Vec<String>>,
    /// Each moving tab's slide, and the shift it last painted at, which the
    /// strip's last layout includes and the gaps must not.
    slides: RefCell<HashMap<Pick, Slide>>,
    painted: RefCell<HashMap<Pick, f32>>,
    /// When the strip last scrolled for the carried tab.
    edge_scrolled: Cell<Option<Instant>>,
    /// Lifts the tab once the press has rested, then ends a dropped preview
    /// the daemon never answered. Dropping the drag cancels it.
    _timer: Task<()>,
}

/// Where a lifted tab would land: the gap before the tab of its kind at
/// `slot`, beside that tab or the last one.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Target {
    pub(super) slot: usize,
    pub(super) beside: Beside<Pick>,
}

/// What a strip draws for the drag in it.
pub(super) struct StripDrag {
    /// Each moving tab's shift along the strip.
    pub(super) shifts: HashMap<Pick, f32>,
    /// The tab following the pointer, and how far it has grown as it lifted,
    /// from 0 to 1.
    pub(super) carried: Option<(Pick, f32)>,
    /// Whether anything is still moving, so the strip draws another frame.
    pub(super) moving: bool,
}

fn same_kind(a: &Pick, b: &Pick) -> bool {
    matches!(
        (a, b),
        (Pick::Herdr(_), Pick::Herdr(_)) | (Pick::Page(_), Pick::Page(_))
    )
}

/// Where dropping the tab at `dragged` into `slot`, the gap before the tab
/// at `slot`, lands it. `None` for the two gaps around it, which move nothing.
fn landing(kin: &[Pick], dragged: usize, slot: usize) -> Option<Beside<Pick>> {
    if slot == dragged || slot == dragged + 1 || slot > kin.len() {
        return None;
    }
    match kin.get(slot) {
        Some(pick) => Some(Beside::Before(pick.clone())),
        None => kin.last().cloned().map(Beside::After),
    }
}

/// The Herdr tabs of `tab`'s workspace, in the daemon's order.
fn workspace_tabs<'a>(snapshot: &'a ClientShellSnapshot, tab: &str) -> Vec<&'a str> {
    let Some(workspace) = snapshot
        .tabs
        .iter()
        .find(|candidate| candidate.tab_id == tab)
        .map(|tab| &tab.workspace_id)
    else {
        return Vec::new();
    };
    snapshot
        .tabs
        .iter()
        .filter(|tab| &tab.workspace_id == workspace)
        .map(|tab| tab.tab_id.as_str())
        .collect()
}

/// The `tab.move` that lands `tab` beside `anchor`: the daemon takes the gap
/// in the whole workspace's order, counted before the tab leaves its place,
/// which a strip listing only some of the tabs cannot see.
fn tab_move(
    snapshot: &ClientShellSnapshot,
    tab: &str,
    beside: &Beside<String>,
) -> Option<serde_json::Value> {
    let (Beside::Before(anchor) | Beside::After(anchor)) = beside;
    let order = workspace_tabs(snapshot, tab);
    let at = order.iter().position(|candidate| candidate == anchor)?;
    let insert_index = match beside {
        Beside::Before(_) => at,
        Beside::After(_) => at + 1,
    };
    Some(serde_json::json!({ "tab_id": tab, "insert_index": insert_index }))
}

impl TabDrag {
    /// Whether it would land anywhere if dropped now.
    #[cfg(test)]
    pub(crate) fn has_target(&self) -> bool {
        self.target.is_some()
    }

    fn floating(&self) -> bool {
        self.lifted.is_some() && self.dropped.is_none()
    }

    /// Whether the strip shows the drop in place: while it floats, and after
    /// it is dropped until the daemon's order replaces the old one.
    fn previewing(&self, snapshot: Option<&ClientShellSnapshot>) -> bool {
        let Pick::Herdr(tab) = &self.pick else {
            return self.lifted.is_some();
        };
        self.lifted.is_some()
            && self.dropped.as_ref().is_none_or(|order| {
                snapshot.is_some_and(|snapshot| {
                    order
                        .iter()
                        .map(String::as_str)
                        .eq(workspace_tabs(snapshot, tab))
                })
            })
    }

    /// Where a tab paints on its way to shift `to`, and whether it is still
    /// moving. A tab starts from its resting place.
    fn slide(&self, pick: &Pick, to: f32, now: Instant) -> (f32, bool) {
        let mut slides = self.slides.borrow_mut();
        let slide = slides.entry(pick.clone()).or_insert(Slide {
            from: 0.,
            to: 0.,
            start: now,
        });
        *slide = slide.toward(to, now, SLIDE);
        (slide.at(now, SLIDE), slide.progress(now, SLIDE) < 1.)
    }

    /// Scrolls `scroll` toward whichever end the pointer is carried near, by
    /// how long since the last frame; whether it scrolled.
    fn scroll_at_edge(&self, scroll: &ScrollHandle, now: Instant) -> bool {
        let view = scroll.bounds();
        let x = f32::from(self.pointer.x);
        let (left, right) = (f32::from(view.left()), f32::from(view.right()));
        let edge = EDGE.min((right - left) / 3.);
        let push = if x < left + edge {
            -((left + edge - x) / edge).min(1.)
        } else if x > right - edge {
            ((x - (right - edge)) / edge).min(1.)
        } else {
            self.edge_scrolled.set(None);
            return false;
        };
        // The first frame at an end steps as one frame would, so the strip
        // answers at once rather than a frame later.
        let step = self
            .edge_scrolled
            .replace(Some(now))
            .map_or(FIRST_STEP, |since| now.saturating_duration_since(since))
            .min(MAX_STEP);
        let max = scroll.max_offset().x;
        let offset = scroll.offset();
        let x = (offset.x - px(push * EDGE_SPEED * step.as_secs_f32())).clamp(-max, px(0.));
        scroll.set_offset(gpui::point(x, offset.y));
        true
    }
}

impl HerdrWindow {
    /// Arms a reorder for a left press on a tab in `group`'s strip.
    pub(super) fn press_tab(
        &mut self,
        group: GroupId,
        pick: &Pick,
        position: Point<Pixels>,
        cx: &mut Context<Self>,
    ) {
        if self.menu.page.is_some() {
            return;
        }
        let boot = match pick {
            Pick::Herdr(_) => {
                let Some(snapshot) = &self.live.snapshot else {
                    return;
                };
                if !self.live.status.is_connected() || !self.live.supports_tab_move {
                    return;
                }
                Some(snapshot.boot_id.clone())
            }
            Pick::Page(_) => None,
        };
        let kin = self
            .group_tabs(group, cx)
            .into_iter()
            .filter(|candidate| same_kind(candidate, pick))
            .count();
        if kin < 2 {
            return;
        }
        let lift = cx.spawn(async move |this, cx| {
            cx.background_executor().timer(LIFT_DELAY).await;
            let _ = this.update(cx, |this, cx| this.lift_tab(cx));
        });
        self.tab_drag = Some(TabDrag {
            group,
            pick: pick.clone(),
            boot,
            origin: position,
            pointer: position,
            scrolled: self.strip_scroll(group).offset().x,
            lifted: None,
            target: None,
            dropped: None,
            slides: RefCell::default(),
            painted: RefCell::default(),
            edge_scrolled: Cell::new(None),
            _timer: lift,
        });
    }

    fn lift_tab(&mut self, cx: &mut Context<Self>) {
        if let Some(drag) = &mut self.tab_drag
            && drag.lifted.is_none()
        {
            drag.lifted = Some(Instant::now());
            cx.notify();
        }
    }

    /// Follows the pointer; the strip resolves the gap as it draws. Returns
    /// whether the move belongs to the drag, so nothing under it sees it.
    pub(super) fn move_tab_drag(
        &mut self,
        position: Point<Pixels>,
        held: bool,
        cx: &mut Context<Self>,
    ) -> bool {
        let Some(drag) = self.tab_drag.as_mut().filter(|d| d.dropped.is_none()) else {
            return false;
        };
        // A release outside the window never reaches the strip.
        if !held {
            let lifted = drag.lifted.is_some();
            self.tab_drag = None;
            cx.notify();
            return lifted;
        }
        drag.pointer = position;
        let moved = position - drag.origin;
        if drag.lifted.is_none() && f32::from(moved.x.abs().max(moved.y.abs())) > LIFT_DISTANCE {
            self.lift_tab(cx);
        }
        if self.tab_drag.as_ref().is_some_and(|d| d.lifted.is_some()) {
            cx.notify();
            return true;
        }
        false
    }

    /// Ends the drag on release, moving the tab if it was lifted over a gap.
    /// Returns whether it had lifted, in which case the release is not a click.
    pub(super) fn release_tab_drag(&mut self, cx: &mut Context<Self>) -> bool {
        let Some(drag) = self.tab_drag.take() else {
            return false;
        };
        if !drag.floating() {
            return false;
        }
        cx.notify();
        let Some(target) = drag.target.clone() else {
            return true;
        };
        match drag.pick.clone() {
            Pick::Page(id) => {
                let beside = target.beside.and_then(|anchor| match anchor {
                    Pick::Page(anchor) => Some(anchor),
                    Pick::Herdr(_) => None,
                });
                if let Some(beside) = beside {
                    Store::update(cx, |store| store.move_tab(id, beside));
                }
            }
            Pick::Herdr(tab) => {
                let beside = target.beside.and_then(|anchor| match anchor {
                    Pick::Herdr(anchor) => Some(anchor),
                    Pick::Page(_) => None,
                });
                if let Some(beside) = beside {
                    self.send_tab_move(drag, tab, beside, cx);
                }
            }
        }
        true
    }

    fn send_tab_move(
        &mut self,
        mut drag: TabDrag,
        tab: String,
        beside: Beside<String>,
        cx: &mut Context<Self>,
    ) {
        let connection = &self.endpoints[self.selected_endpoint].connection;
        let (Some(handle), Some(snapshot), Some(boot)) =
            (&connection.handle, &self.live.snapshot, &drag.boot)
        else {
            return;
        };
        if snapshot.boot_id != *boot {
            return;
        }
        let Some(params) = tab_move(snapshot, &tab, &beside) else {
            return;
        };
        match handle.request(boot, Method::TabMove, params) {
            Ok(_) => {
                drag.dropped = Some(
                    workspace_tabs(snapshot, &tab)
                        .into_iter()
                        .map(str::to_owned)
                        .collect(),
                );
                drag._timer = cx.spawn(async move |this, cx| {
                    cx.background_executor().timer(SETTLE_TIMEOUT).await;
                    let _ = this.update(cx, |this, cx| {
                        this.tab_drag = None;
                        cx.notify();
                    });
                });
                self.tab_drag = Some(drag);
            }
            Err(error) => self.local_error = Some(format!("Tab move not sent: {error}")),
        }
    }

    /// Drops a lifted tab where it came from. Returns whether one was lifted.
    pub(crate) fn cancel_tab_drag(&mut self, cx: &mut Context<Self>) -> bool {
        if !self.tab_drag.as_ref().is_some_and(TabDrag::floating) {
            return false;
        }
        self.tab_drag = None;
        cx.notify();
        true
    }

    /// Whether `group`'s strip has a drag armed in it, whose pointer it
    /// follows.
    pub(super) fn tab_drag_in(&self, group: GroupId) -> bool {
        self.tab_drag
            .as_ref()
            .is_some_and(|drag| drag.group == group)
    }

    /// Lays out the drag in `group`'s strip, whose children are `places`
    /// (`None` for a tab shrinking out) tracked by `scroll`, as the strip
    /// last laid out: resolves the gap under the carried tab, scrolls at the
    /// ends, and slides the tabs it passes aside.
    pub(super) fn strip_drag(
        &mut self,
        group: GroupId,
        places: &[Option<Pick>],
        scroll: &ScrollHandle,
        now: Instant,
    ) -> Option<StripDrag> {
        let snapshot = self.live.snapshot.clone();
        let drag = self.tab_drag.as_mut().filter(|drag| drag.group == group)?;
        if !drag.previewing(snapshot.as_deref()) {
            // The daemon's new order has arrived; the strip now shows it.
            if drag.dropped.is_some() {
                self.tab_drag = None;
            }
            return None;
        }
        let kin: Vec<(&Pick, usize)> = places
            .iter()
            .enumerate()
            .filter_map(|(child, place)| Some((place.as_ref()?, child)))
            .filter(|(pick, _)| same_kind(pick, &drag.pick))
            .collect();
        let Some(dragged) = kin.iter().position(|(pick, _)| **pick == drag.pick) else {
            // The carried tab closed under it.
            if drag.dropped.is_none() {
                self.tab_drag = None;
            }
            return None;
        };
        let floating = drag.floating();
        let mut moving = floating && drag.scroll_at_edge(scroll, now);
        let offset = scroll.offset().x;
        // Where each tab rests, from the strip's last layout less the shift
        // it painted at: the gaps are measured where tabs rest, or the strip
        // would chase its own preview.
        let spans: Option<Vec<(f32, f32)>> = {
            let painted = drag.painted.borrow();
            kin.iter()
                .map(|(pick, child)| {
                    let bounds = scroll.bounds_for_item(*child)?;
                    let shift = painted.get(*pick).copied().unwrap_or(0.);
                    let left = f32::from(bounds.left()) - shift;
                    Some((left, left + f32::from(bounds.size.width)))
                })
                .collect()
        };
        let widths: Vec<f32> = spans.as_ref().map_or_else(
            || vec![0.; kin.len()],
            |spans| spans.iter().map(|(left, right)| right - left).collect(),
        );
        // The carried tab keeps under the pointer as the strip scrolls, and
        // inside the strip, so it never paints over what surrounds it.
        let carried_shift = spans.as_ref().map_or(0., |spans| {
            let (left, right) = spans[dragged];
            let view = scroll.bounds();
            let lift = f32::from(drag.pointer.x - drag.origin.x + drag.scrolled - offset);
            let on_screen = left + f32::from(offset);
            let low = f32::from(view.left()) - on_screen;
            let high = f32::from(view.right()) - (on_screen + right - left);
            lift.clamp(low.min(high), high.max(low))
        });
        if floating {
            let kin_picks: Vec<Pick> = kin.iter().map(|(pick, _)| (*pick).clone()).collect();
            drag.target = spans.as_ref().and_then(|spans| {
                let card = (
                    spans[dragged].0 + carried_shift,
                    spans[dragged].1 + carried_shift,
                );
                let spans: Vec<_> = spans.iter().copied().map(Some).collect();
                let slot = slot_for(&spans, dragged, card);
                let beside = landing(&kin_picks, dragged, slot)?;
                Some(Target { slot, beside })
            });
        }
        let slot = drag.target.as_ref().map_or(dragged, |target| target.slot);
        let resting = preview(&widths, dragged, slot);
        let mut shifts = HashMap::new();
        for (unit, (pick, _)) in kin.iter().enumerate() {
            let shift = if unit == dragged && floating {
                // Pinned where it floats, so once dropped it slides from there.
                drag.slides.borrow_mut().insert(
                    (*pick).clone(),
                    Slide {
                        from: carried_shift,
                        to: carried_shift,
                        start: now,
                    },
                );
                carried_shift
            } else {
                let (at, still) = drag.slide(pick, resting[unit], now);
                moving |= still;
                at
            };
            shifts.insert((*pick).clone(), shift);
        }
        *drag.painted.borrow_mut() = shifts.clone();
        let grown = drag
            .lifted
            .and_then(|lifted| motion::progress(lifted, now, GROW));
        moving |= grown.is_some();
        Some(StripDrag {
            shifts,
            carried: floating.then(|| (drag.pick.clone(), grown.unwrap_or(1.))),
            moving,
        })
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use super::*;
    use core::prelude::v1::test;

    fn herdr(ids: &[&str]) -> Vec<Pick> {
        ids.iter().map(|id| Pick::Herdr((*id).into())).collect()
    }

    #[test]
    fn a_tab_lands_before_the_tab_at_its_gap_or_after_the_last() {
        let kin = herdr(&["a", "b", "c"]);
        let before = |id: &str| Some(Beside::Before(Pick::Herdr(id.into())));
        // The gaps around the carried tab move nothing.
        assert_eq!(landing(&kin, 1, 1), None);
        assert_eq!(landing(&kin, 1, 2), None);
        assert_eq!(landing(&kin, 1, 0), before("a"));
        assert_eq!(landing(&kin, 0, 2), before("c"));
        assert_eq!(
            landing(&kin, 0, 3),
            Some(Beside::After(Pick::Herdr("c".into())))
        );
        assert_eq!(landing(&kin, 0, 4), None);
    }

    #[test]
    fn a_move_counts_its_gap_in_the_whole_workspace_before_the_tab_leaves() {
        let mut snapshot: ClientShellSnapshot = serde_json::from_str(include_str!(
            "../../../herdr-protocol/tests/fixtures/endpoint-snapshot-v1.json"
        ))
        .unwrap();
        let first = snapshot.tabs[0].clone();
        let tab = |id: &str, workspace: &str| {
            let mut tab = first.clone();
            tab.tab_id = id.into();
            tab.workspace_id = workspace.into();
            tab
        };
        snapshot.tabs = vec![
            tab("a", "w1"),
            tab("other", "w2"),
            tab("b", "w1"),
            tab("c", "w1"),
        ];
        let params = |tab: &str, beside: Beside<&str>| {
            tab_move(
                &snapshot,
                tab,
                &beside.and_then(|anchor| Some(anchor.to_owned()))?,
            )
        };
        // Another workspace's tabs never count.
        assert_eq!(
            params("c", Beside::Before("a")),
            Some(serde_json::json!({"tab_id": "c", "insert_index": 0}))
        );
        assert_eq!(
            params("a", Beside::Before("c")),
            Some(serde_json::json!({"tab_id": "a", "insert_index": 2}))
        );
        assert_eq!(
            params("a", Beside::After("c")),
            Some(serde_json::json!({"tab_id": "a", "insert_index": 3}))
        );
        assert_eq!(params("a", Beside::Before("other")), None);
        assert_eq!(params("missing", Beside::Before("a")), None);
    }
}
