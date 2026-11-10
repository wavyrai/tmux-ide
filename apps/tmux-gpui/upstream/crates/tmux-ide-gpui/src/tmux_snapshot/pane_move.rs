//! Moving panes by drag, stage 1: drag one pane's header onto the centre of
//! another pane in the same window, and the two swap.
//!
//! The gesture is local until release, like a divider drag: the source
//! fades in place with a dashed outline, a small card on Bezel's carried
//! surface follows the pointer, and a translucent preview marks the pane it
//! would swap with. Release sends one `Swap` pane action naming the target
//! as the preview showed it; the published layout settles it. Cmd-Z swaps
//! back while the layout is unchanged.
use super::{SnapshotView, browser, hit_regions::Region, motion::progress, pane_actions};
use gpui::{prelude::*, *};
use std::time::{Duration, Instant};

/// What a screen reader adds to a pane's title.
pub(super) const HINT: &str = "Drag the title onto another pane to swap them";

/// How far the pointer moves before a press on a header becomes a drag. Less
/// is a click, which focuses the pane as before.
pub(super) const THRESHOLD: f32 = 4.;
/// The share of a card, on each side, kept for the edge zones of a later
/// stage. Only the middle swaps.
const EDGE: f32 = 0.2;
/// How long a result stays on screen.
const TOAST: Duration = Duration::from_secs(4);
/// The longest a sent swap may wait for its layout: the client's own
/// deadline is 12 s, so past this it can no longer land.
const SETTLE: Duration = Duration::from_secs(15);
/// The status the transport writes when the daemon refuses a pane action.
const NOT_APPLIED: &str = "Pane action was not applied";

/// Why a header press doesn't start a drag.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Refusal {
    Zoomed,
    Held,
    Reconnecting,
    Dialog,
    Pending,
    NoCards,
}

/// What the window is doing, as far as a drag cares.
#[derive(Clone, Copy, Debug, Default)]
pub(super) struct Facts {
    pub zoomed: bool,
    /// A held frame (retained preview) or a pane that doesn't take input.
    pub held: bool,
    pub reconnecting: bool,
    pub dialog: bool,
    /// A pane action is in flight: the pane actions capability is spent.
    pub pending: bool,
    pub cards: bool,
}
impl Facts {
    pub(super) fn refusal(self) -> Option<Refusal> {
        if !self.cards {
            Some(Refusal::NoCards)
        } else if self.zoomed {
            Some(Refusal::Zoomed)
        } else if self.held {
            Some(Refusal::Held)
        } else if self.reconnecting {
            Some(Refusal::Reconnecting)
        } else if self.dialog {
            Some(Refusal::Dialog)
        } else if self.pending {
            Some(Refusal::Pending)
        } else {
            None
        }
    }
}

/// Whether the pointer has moved far enough from the press to drag.
pub(super) fn crossed(origin: Point<Pixels>, pointer: Point<Pixels>) -> bool {
    let (dx, dy) = (
        f32::from(pointer.x - origin.x),
        f32::from(pointer.y - origin.y),
    );
    (dx * dx + dy * dy).sqrt() >= THRESHOLD
}

/// Whether `pointer` is in the swap zone of `card`: its middle, away from
/// the edges a later stage uses.
pub(super) fn in_centre(card: Bounds<Pixels>, pointer: Point<Pixels>) -> bool {
    let inset = point(card.size.width * EDGE, card.size.height * EDGE);
    Bounds::new(
        card.origin + inset,
        card.size - size(inset.x * 2., inset.y * 2.),
    )
    .contains(&pointer)
}

/// Each pane's place in reading order (top, then left).
fn slots(layout: &[Region]) -> Vec<&str> {
    let mut ordered: Vec<&Region> = layout.iter().collect();
    ordered.sort_by_key(|r| (r.top, r.left));
    ordered.into_iter().map(|r| r.id.as_str()).collect()
}

/// Whether `after` shows `a` and `b` exchanged from `before`: each in the
/// other's place, in reading order, and every other pane in its own. Sizes
/// may differ, so a resize published before or with the swap still counts.
pub(super) fn swapped(before: &[Region], after: &[Region], a: &str, b: &str) -> bool {
    let (was, now) = (slots(before), slots(after));
    let at = |order: &[&str], id: &str| order.iter().position(|p| *p == id);
    let (Some(a0), Some(b0), Some(a1), Some(b1)) =
        (at(&was, a), at(&was, b), at(&now, a), at(&now, b))
    else {
        return false;
    };
    a0 != b0
        && a1 == b0
        && b1 == a0
        && was.len() == now.len()
        && was
            .iter()
            .filter(|p| **p != a && **p != b)
            .all(|p| at(&now, p) == at(&was, p))
}

/// The pane under the pointer, as the preview showed it: its id and the
/// input token it was published with. The swap names this token, so a pane
/// replaced under the same id since is refused, never swapped.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Pick {
    pub id: String,
    pub token: String,
}

#[derive(Clone, PartialEq)]
pub(super) enum Phase {
    /// Pressed, not yet past the threshold.
    Pressed,
    /// Dragging; `target` is the pane under the pointer's swap zone.
    Dragging { target: Option<Pick> },
    /// Released over `target`; the swap was sent with the source's pane
    /// action capability `sent`.
    Pending {
        target: Pick,
        before: Vec<Region>,
        since: Instant,
        sent: Option<String>,
    },
    /// Cancelled or refused: the card glides back to its header.
    Returning { from: Point<Pixels>, since: Instant },
}

#[derive(Clone)]
pub(super) struct Gesture {
    pub request: u64,
    pub session: Option<String>,
    pub source: String,
    pub origin: Point<Pixels>,
    pub pointer: Point<Pixels>,
    pub phase: Phase,
    /// The layout the zones were last drawn from.
    pub seen: Vec<Region>,
    /// Cmd-Z's swap back: nothing is carried or previewed.
    pub undoing: bool,
    /// The pane that was selected before the drag selected the source. A
    /// drag that ends without a swap selects it again.
    pub restore: Option<String>,
}
/// A swap that Cmd-Z can reverse while the layout is still `layout`.
#[derive(Clone, PartialEq)]
pub(super) struct Undo {
    pub request: u64,
    pub a: String,
    pub b: String,
    pub layout: Vec<Region>,
}
impl Undo {
    /// The swap that reverses this one, from the selected pane, if the
    /// layout is unchanged since.
    pub(super) fn reverse(
        &self,
        request: u64,
        layout: &[Region],
        selected: &str,
    ) -> Option<String> {
        if request != self.request || layout != self.layout.as_slice() {
            return None;
        }
        if selected == self.a {
            Some(self.b.clone())
        } else if selected == self.b {
            Some(self.a.clone())
        } else {
            None
        }
    }
}

pub(super) struct Toast {
    pub text: SharedString,
    pub undo: bool,
    pub serial: u64,
}

/// What a release does.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum Release {
    /// Never crossed the threshold: the header's own click handles it.
    Click,
    /// Outside a pane, on the source, or Esc.
    Cancel,
    /// The layout changed under the drag since the preview was drawn.
    Stale,
    Swap {
        source: String,
        target: Pick,
    },
}

/// What a pending swap became.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum Settle {
    Waiting,
    Swapped,
    Failed,
}

#[derive(Default)]
pub(super) struct Owner {
    pub gesture: Option<Gesture>,
    pub undo: Option<Undo>,
    pub toast: Option<Toast>,
    serial: u64,
}
impl Owner {
    pub(super) fn dragging(&self) -> bool {
        self.gesture
            .as_ref()
            .is_some_and(|g| matches!(g.phase, Phase::Dragging { .. }))
    }
    /// A header press. Starts nothing visible until the threshold.
    pub(super) fn press(
        &mut self,
        source: &str,
        at: Point<Pixels>,
        request: u64,
        session: Option<String>,
        layout: &[Region],
        facts: Facts,
    ) -> Result<(), Refusal> {
        if let Some(refusal) = facts.refusal() {
            return Err(refusal);
        }
        if self
            .gesture
            .as_ref()
            .is_some_and(|g| matches!(g.phase, Phase::Pending { .. }))
        {
            return Err(Refusal::Pending);
        }
        self.gesture = Some(Gesture {
            request,
            session,
            source: source.into(),
            origin: at,
            pointer: at,
            phase: Phase::Pressed,
            seen: layout.to_vec(),
            undoing: false,
            restore: None,
        });
        Ok(())
    }
    /// The pointer moved. `target` names the pane whose swap zone holds the
    /// pointer in the current layout. True when the drag just started.
    pub(super) fn moved(
        &mut self,
        at: Point<Pixels>,
        target: Option<Pick>,
        layout: &[Region],
    ) -> bool {
        let Some(gesture) = self.gesture.as_mut() else {
            return false;
        };
        gesture.pointer = at;
        match &gesture.phase {
            Phase::Pressed if crossed(gesture.origin, at) => {
                gesture.phase = Phase::Dragging { target: None };
                gesture.seen = layout.to_vec();
                self.retarget(target, layout);
                true
            }
            Phase::Dragging { .. } => {
                self.retarget(target, layout);
                false
            }
            _ => false,
        }
    }
    fn retarget(&mut self, target: Option<Pick>, layout: &[Region]) {
        if let Some(gesture) = self.gesture.as_mut() {
            // The token is the one published when the preview first showed
            // this pane; hovering on doesn't pick up a replacement.
            let shown = match &gesture.phase {
                Phase::Dragging {
                    target: Some(shown),
                } => Some(shown.clone()),
                _ => None,
            };
            let target = target
                .filter(|t| t.id != gesture.source)
                .map(|t| shown.filter(|s| s.id == t.id).unwrap_or(t));
            gesture.phase = Phase::Dragging { target };
            gesture.seen = layout.to_vec();
        }
    }
    /// The layout was republished mid-drag. Zones rebuild from it on the
    /// next draw; a drag whose source or target is gone ends. True if it
    /// ended.
    pub(super) fn relayout(&mut self, layout: &[Region], now: Instant) -> bool {
        let Some(gesture) = self.gesture.as_mut() else {
            return false;
        };
        let has = |id: &str| layout.iter().any(|r| r.id == id);
        let gone = match &gesture.phase {
            Phase::Pressed | Phase::Dragging { target: None } => !has(&gesture.source),
            Phase::Dragging {
                target: Some(target),
            } => !has(&gesture.source) || !has(&target.id),
            _ => false,
        };
        if gone {
            gesture.phase = Phase::Returning {
                from: gesture.pointer,
                since: now,
            };
        }
        gone
    }
    /// The button came up at `at`. `layout` is what is published now.
    pub(super) fn release(&mut self, layout: &[Region], now: Instant) -> Release {
        let Some(gesture) = self.gesture.as_mut() else {
            return Release::Click;
        };
        let release = match &gesture.phase {
            Phase::Pressed => Release::Click,
            Phase::Dragging { target: None } => Release::Cancel,
            Phase::Dragging { .. } if gesture.seen.as_slice() != layout => Release::Stale,
            Phase::Dragging {
                target: Some(target),
            } => Release::Swap {
                source: gesture.source.clone(),
                target: target.clone(),
            },
            _ => return Release::Click,
        };
        match &release {
            Release::Click => self.gesture = None,
            Release::Swap { target, .. } => {
                gesture.phase = Phase::Pending {
                    target: target.clone(),
                    before: layout.to_vec(),
                    since: now,
                    sent: None,
                }
            }
            Release::Cancel | Release::Stale => {
                gesture.phase = Phase::Returning {
                    from: gesture.pointer,
                    since: now,
                }
            }
        }
        release
    }
    /// Esc, or anything else that ends a drag without a swap.
    pub(super) fn cancel(&mut self, now: Instant) {
        match self.gesture.as_ref().map(|g| &g.phase) {
            Some(Phase::Pressed) => self.gesture = None,
            Some(Phase::Dragging { .. }) => {
                if let Some(gesture) = self.gesture.as_mut() {
                    gesture.phase = Phase::Returning {
                        from: gesture.pointer,
                        since: now,
                    };
                }
            }
            _ => {}
        }
    }
    /// The swap went out, spending the source's pane action capability
    /// `token`.
    pub(super) fn sent(&mut self, token: String) {
        if let Some(Phase::Pending { sent, .. }) = self.gesture.as_mut().map(|g| &mut g.phase) {
            *sent = Some(token);
        }
    }
    /// Reads a pending swap's result off the published state. The layout
    /// showing the exchange settles it, whatever else changed first. Only
    /// the daemon's refusal or the deadline fails it: `actions` is the pane
    /// action capability published now, and one other than the spent one
    /// means the swap was admitted and has finished, so the status is its.
    pub(super) fn settle(
        &mut self,
        layout: &[Region],
        actions: Option<&str>,
        status: &str,
        now: Instant,
    ) -> Settle {
        let Some(gesture) = self.gesture.as_ref() else {
            return Settle::Waiting;
        };
        let Phase::Pending {
            target,
            before,
            since,
            sent,
        } = &gesture.phase
        else {
            return Settle::Waiting;
        };
        if swapped(before, layout, &gesture.source, &target.id) {
            self.undo = Some(Undo {
                request: gesture.request,
                a: gesture.source.clone(),
                b: target.id.clone(),
                layout: layout.to_vec(),
            });
            self.gesture = None;
            return Settle::Swapped;
        }
        let finished = actions.is_some_and(|now| sent.as_deref().is_some_and(|sent| now != sent));
        let refused = finished && status == NOT_APPLIED;
        if refused || now.saturating_duration_since(*since) >= SETTLE {
            let from = gesture.pointer;
            if let Some(gesture) = self.gesture.as_mut() {
                gesture.phase = Phase::Returning { from, since: now };
            }
            return Settle::Failed;
        }
        Settle::Waiting
    }
    /// The pane to select again now that the drag has ended without a swap.
    pub(super) fn take_restore(&mut self) -> Option<String> {
        let gesture = self.gesture.as_mut()?;
        if matches!(gesture.phase, Phase::Returning { .. }) {
            gesture.restore.take()
        } else {
            None
        }
    }
    /// A swap that couldn't be sent: the card goes home.
    pub(super) fn fail(&mut self, now: Instant) {
        if let Some(gesture) = self.gesture.as_mut()
            && matches!(gesture.phase, Phase::Pending { .. })
        {
            gesture.phase = Phase::Returning {
                from: gesture.pointer,
                since: now,
            };
        }
    }
    /// How far a returning card has travelled: 1 when it is home, and the
    /// gesture is then over.
    pub(super) fn returning(&mut self, now: Instant, reduced: bool) -> Option<f32> {
        let Some(Phase::Returning { since, .. }) = self.gesture.as_ref().map(|g| &g.phase) else {
            return None;
        };
        let t = progress(
            &bezel_motion::LAYOUT,
            now.saturating_duration_since(*since),
            reduced,
        );
        if t >= 1. {
            self.gesture = None;
        }
        Some(t)
    }
    pub(super) fn show(&mut self, text: impl Into<SharedString>, undo: bool) -> u64 {
        self.serial = self.serial.wrapping_add(1);
        self.toast = Some(Toast {
            text: text.into(),
            undo,
            serial: self.serial,
        });
        self.serial
    }
}

fn label(state: &browser::State, id: &str) -> String {
    state
        .panes
        .iter()
        .find(|p| p.id == id)
        .map(|p| p.label.trim().to_owned())
        .filter(|l| !l.is_empty())
        .unwrap_or_else(|| "Pane".into())
}

#[path = "pane_move/view.rs"]
mod view;

#[cfg(test)]
#[path = "pane_move/tests.rs"]
mod tests;
