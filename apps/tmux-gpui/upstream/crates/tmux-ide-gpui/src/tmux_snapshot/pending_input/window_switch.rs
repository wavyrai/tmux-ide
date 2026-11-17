//! Keys typed after choosing a pane of another window, in a session streamed
//! one window at a time (#806), wait for that window's stream.
//!
//! The pane is not in the current stream, so choosing it re-issues the stream
//! for its window. Meanwhile the old window stays painted and takes no input
//! (the open's retained preview). Keys typed from the click on are held,
//! never sent to the old window, and go to the chosen pane once its stream
//! takes input. Anything else drops them and sets the latch: the switch took
//! longer than [`SWITCH_LIMIT`], the stream came back on another pane, session
//! or request, or the pane has no input target there.
use super::*;

/// From the click to the new window's stream taking input. A window's first
/// pane commits in under 0.8 s even with 3000 lines of history per pane
/// (conn-daemon-o, 17 Nov, p50 under load), well inside this.
pub(super) const SWITCH_LIMIT: Duration = Duration::from_secs(3);

pub(in crate::tmux_snapshot) struct Hold {
    /// The old stream went away, as the re-issue does.
    reissued: bool,
    /// The new stream takes input for the pane: `Pending::token` is its token.
    bound: bool,
    /// A stream took input on another pane first: the keys have nowhere to go.
    stray: bool,
}
impl Hold {
    pub(super) fn waiting(&self) -> bool {
        !self.bound
    }
    pub(super) fn failed(&self) -> bool {
        self.stray
    }
}
impl Pending {
    /// A hold for `id`, a pane of another window chosen with `request`. The
    /// current pane must be ready, as for any selection hold.
    pub(in crate::tmux_snapshot) fn capture_switch(
        view: &SnapshotView,
        request: u64,
        id: &str,
    ) -> Option<Self> {
        let state = &view.browser_state;
        if !state.window_stream
            || state.input_targets.iter().any(|t| t.id == id)
            || !state.panes.iter().any(|pane| pane.id == id)
        {
            return None;
        }
        let selected = state.selected_pane.as_deref()?;
        let mut pending = Self::capture(view, request, selected)?;
        pending.kind = Kind::Switch(Hold {
            reissued: false,
            bound: false,
            stray: false,
        });
        id.clone_into(&mut pending.id);
        pending.token.clear();
        Some(pending)
    }
}
impl SnapshotView {
    /// A window switch hold that has not bound yet.
    pub(in crate::tmux_snapshot) fn switch_hold_waiting(&self) -> bool {
        self.pending_input
            .as_ref()
            .is_some_and(|p| matches!(&p.kind, Kind::Switch(hold) if hold.waiting()))
    }
    /// Records the old stream going away, then binds the hold to the chosen
    /// pane once the new stream takes input for it.
    pub(super) fn observe_switch_hold(&mut self) {
        let gone = !self.browser_state.input_ready
            || self.browser_state.retained_preview
            || self.frame.is_none();
        let ready = self.terminal_input_ready();
        let selected = self.browser_state.selected_pane.clone();
        let targets = self.browser_state.input_targets.clone();
        let Some(pending) = self.pending_input.as_mut() else {
            return;
        };
        let Kind::Switch(hold) = &mut pending.kind else {
            return;
        };
        hold.reissued |= gone;
        if hold.bound || !hold.reissued || !ready {
            return;
        }
        if selected.as_ref() != Some(&pending.id) {
            hold.stray = true;
            return;
        }
        let Some(target) = targets.into_iter().find(|t| t.id == pending.id) else {
            return;
        };
        hold.bound = true;
        pending.token = target.token;
    }
}
