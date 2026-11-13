//! Capability 119, "topology in place" (#723): another tmux client split or
//! closed a pane and the stream stayed open. The controller's per-pane state
//! follows the `topology` frame; the layout snapshot that comes after it is
//! applied as any other.
//!
//! - Removed panes lose their commit, lifetime, queued input and paste.
//! - Added panes are known to the input policy and the layout check from now
//!   on; they paint once their seed has committed.
//! - Between the frame and the layout snapshot of its epoch the old layout
//!   still names the removed pane, so the window is not presented again
//!   until that snapshot is in; what was painted stays, without input.
//! - If the selected pane was removed, that snapshot picks the pane tmux
//!   made active (else the first remaining pane of the current window).
//! - The window that follows a frame often cannot be painted at once: an
//!   added pane has no cells before its seed, a pane that got a closed
//!   pane's room has cells of the old size. The window as it was stays up,
//!   without input, until the new one can be painted.
//! - That is owed within [`REMOVAL_MS`] of the frame. If it does not come,
//!   the stream no longer matches the session: it fails as a pane-set
//!   change, which the app answers with a new lease.
//! - A pane whose source the daemon closed must be removed by a frame within
//!   [`REMOVAL_MS`] too, with the same answer.
//! - The delivery of a pane that is being closed often breaks off a moment
//!   before its frame, and the pane has no cells then. The window as it was
//!   stays up for at most [`REMOVAL_MS`], without input; with no frame and
//!   no new cells by then it goes, as on a stream without the capability.
use super::*;

/// How long a closed pane may wait for the frame that removes it, and a
/// frame for a window that can be painted.
pub(super) const REMOVAL_MS: u64 = 2_000;

#[derive(Default)]
pub(super) struct InPlace {
    /// The ready frame said `topologyInPlace`.
    pub(super) enabled: bool,
    /// A frame of this epoch was applied and its layout snapshot is not in.
    settling: Option<u64>,
    /// The selected pane left: choose again when the snapshot is in.
    reselect: bool,
    /// Since when a frame's window is owed: set by the frame, cleared when a
    /// window was painted after it.
    following: Option<u64>,
    /// Since when a window that cannot be painted waits with no frame.
    waiting: Option<u64>,
    /// The window as it was is up in place of one that cannot be painted.
    held: bool,
    /// Panes whose source closed, and when that was first seen.
    closed: BTreeMap<String, u64>,
}

impl Controller {
    /// Applies one `topology` frame. The stream reader already checked it
    /// against the stream's pane set.
    pub(super) fn follow_topology(
        &mut self,
        frame: &str,
        now: u64,
    ) -> Result<Vec<InputCompletion>, Error> {
        let change = tmux_stream::Topology::parse(frame).map_err(Error::Transport)?;
        if !self.in_place.enabled {
            return Err(Error::Invalid);
        }
        let inputs = self.policy.follow(&change.removed, &change.added)?;
        self.topology.follow(&change.panes)?;
        for pane in &change.removed {
            self.current.remove(pane);
            self.materializing.remove(pane);
            self.received.remove(pane);
            self.in_place.closed.remove(pane);
        }
        let gone = |pane: &str| change.removed.iter().any(|removed| removed == pane);
        if (self.pending_selection.as_ref()).is_some_and(|pending| pending.names(&gone)) {
            // Its receipt, if one still comes, finds nothing waiting.
            self.pending_selection = None;
        }
        self.in_place.reselect |= gone(&self.selected);
        self.in_place.settling = Some(change.topology_epoch);
        self.in_place.following.get_or_insert(now);
        self.actionable = false;
        self.presentation.reset();
        if let Some(held) = &mut self.cached_window {
            held.coherent = false;
        }
        Ok(inputs)
    }
    /// The stream's whole pane set as it is now, when the stream follows
    /// pane changes in place; `None` for a stream whose set is the lease's.
    pub fn panes_in_place(&self) -> Option<Vec<String>> {
        (self.in_place.enabled).then(|| self.topology.issued().iter().cloned().collect())
    }
    /// After the controls of one poll: when the layout snapshot of the last
    /// frame's epoch is in, the window may be presented again, and a removed
    /// selected pane is replaced. Whether that happened now.
    pub(super) fn settle(&mut self) -> Result<bool, Error> {
        let Some(epoch) = self.in_place.settling else {
            return Ok(false);
        };
        if self.topology.epoch().is_none_or(|current| current < epoch) {
            return Ok(false);
        }
        if self.in_place.reselect {
            let Some(pane) = (self.topology.preferred_pane().map(str::to_owned))
                .or_else(|| self.topology.first_issued_in_current_window())
            else {
                return Ok(false);
            };
            self.in_place.reselect = false;
            self.selected.clone_from(&pane);
            self.presentation = Presentation::new(pane)?;
        }
        self.in_place.settling = None;
        Ok(true)
    }
    /// The layout snapshot of the last frame is still awaited; an error
    /// when it is overdue.
    pub(super) fn settling(&self, now: u64) -> Result<bool, Error> {
        if self.in_place.settling.is_none() {
            return Ok(false);
        }
        if (self.in_place.following).is_some_and(|since| now.saturating_sub(since) >= REMOVAL_MS) {
            return Err(Error::Topology(tmux_topology::Error::Unissued));
        }
        Ok(true)
    }
    /// A pane change is being followed, or the window as it was is up for
    /// one that cannot be painted: the window is looked at again on every
    /// poll, and nothing is actionable.
    pub(super) fn changing(&self) -> bool {
        self.in_place.settling.is_some() || self.in_place.following.is_some() || self.in_place.held
    }
    /// The window after the controls and commits of one poll: `painted`, or
    /// it cannot be painted now. Whether the window as it was stays up
    /// instead (`up`: there is one); an error when a frame's window is
    /// overdue.
    pub(super) fn hold(&mut self, painted: bool, up: bool, now: u64) -> Result<bool, Error> {
        self.in_place.held = false;
        if painted {
            self.in_place.following = None;
            self.in_place.waiting = None;
            return Ok(false);
        }
        if let Some(since) = self.in_place.following {
            if now.saturating_sub(since) >= REMOVAL_MS {
                return Err(Error::Topology(tmux_topology::Error::Unissued));
            }
            self.in_place.held = up;
            return Ok(true);
        }
        if !self.in_place.enabled || !up {
            return Ok(false);
        }
        let since = *self.in_place.waiting.get_or_insert(now);
        self.in_place.held = now.saturating_sub(since) < REMOVAL_MS;
        Ok(self.in_place.held)
    }
    /// The 2 s rule. `unavailable` is the session's set of panes whose source
    /// closed.
    pub(super) fn await_removal(
        &mut self,
        unavailable: &std::collections::BTreeSet<String>,
        now: u64,
    ) -> Result<(), Error> {
        if !self.in_place.enabled {
            return Ok(());
        }
        self.in_place
            .closed
            .retain(|pane, _| unavailable.contains(pane));
        for pane in unavailable {
            self.in_place.closed.entry(pane.clone()).or_insert(now);
        }
        if (self.in_place.closed.values()).any(|since| now.saturating_sub(*since) >= REMOVAL_MS) {
            return Err(Error::Topology(tmux_topology::Error::Unissued));
        }
        Ok(())
    }
}

#[cfg(test)]
#[path = "tmux_controller_in_place_tests.rs"]
mod tests;
