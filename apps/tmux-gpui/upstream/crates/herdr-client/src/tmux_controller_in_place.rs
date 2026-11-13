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
//! - An added pane has nothing to paint before its seed. The window as it
//!   was stays up, without input, until the seed commits or [`REMOVAL_MS`]
//!   passed.
//! - A pane whose source the daemon closed must be removed by a frame within
//!   [`REMOVAL_MS`]. If none comes, the stream no longer matches the session:
//!   it fails as a pane-set change, which the app answers with a new lease.
use super::*;

/// How long a closed pane may wait for the frame that removes it.
pub(super) const REMOVAL_MS: u64 = 2_000;

#[derive(Default)]
pub(super) struct InPlace {
    /// The ready frame said `topologyInPlace`.
    pub(super) enabled: bool,
    /// A frame of this epoch was applied and its layout snapshot is not in.
    settling: Option<u64>,
    /// The selected pane left: choose again when the snapshot is in.
    reselect: bool,
    /// Since when an added pane's seed is awaited with the old window up.
    seeding: Option<u64>,
    /// A frame added panes whose first commit the window still waits for.
    awaits_seed: bool,
    /// Panes whose source closed, and when that was first seen.
    closed: BTreeMap<String, u64>,
}

impl Controller {
    /// Applies one `topology` frame. The stream reader already checked it
    /// against the stream's pane set.
    pub(super) fn follow_topology(&mut self, frame: &str) -> Result<Vec<InputCompletion>, Error> {
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
        self.in_place.seeding = None;
        self.in_place.awaits_seed |= !change.added.is_empty();
        self.actionable = false;
        self.presentation.reset();
        Ok(inputs)
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
    /// The layout snapshot of the last frame is still awaited.
    pub(super) fn settling(&self) -> bool {
        self.in_place.settling.is_some()
    }
    /// The old window is up while an added pane's seed is awaited.
    pub(super) fn seeding(&self) -> bool {
        self.in_place.seeding.is_some()
    }
    /// Nothing is actionable while a pane change is being followed.
    pub(super) fn changing(&self) -> bool {
        self.in_place.settling.is_some() || self.in_place.seeding.is_some()
    }
    /// Whether the window as it was stays up because the new one cannot be
    /// presented yet (`presented` is false) and an added pane's seed is
    /// still awaited. Bounded by [`REMOVAL_MS`].
    pub(super) fn hold_for_seed(&mut self, presented: bool, now: u64) -> bool {
        if presented || !self.in_place.awaits_seed {
            self.in_place.awaits_seed = false;
            self.in_place.seeding = None;
            return false;
        }
        let since = *self.in_place.seeding.get_or_insert(now);
        if now.saturating_sub(since) >= REMOVAL_MS {
            self.in_place.awaits_seed = false;
            self.in_place.seeding = None;
            return false;
        }
        true
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
