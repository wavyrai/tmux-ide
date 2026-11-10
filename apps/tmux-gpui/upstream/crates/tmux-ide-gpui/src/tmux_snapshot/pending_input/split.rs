//! Keys typed after a split are held for the pane the split creates.
//!
//! A split re-issues the stream, so for a moment nothing can take input. The
//! user expects to type straight into the new pane, which tmux focuses. Keys
//! typed from the click on are held, never sent to the old pane, and go to the
//! new pane once its stream arrives. Any doubt drops them and sets the latch,
//! as before: the stream never came back, it came back on a pane that existed
//! before the split, it has no input target, the session or request changed,
//! or the hold timed out.
use super::*;

/// How long a split may take to come back before held keys are dropped.
const SPLIT_LIMIT: Duration = Duration::from_secs(3);

pub(in crate::tmux_snapshot) struct Hold {
    /// The panes before the split; the pane it creates is not among them.
    before: Vec<String>,
    /// The stream went away after the split, as a re-issue does.
    reissued: bool,
}
impl Pending {
    pub(super) fn limit(&self) -> Duration {
        match self.kind {
            Kind::Split(_) => SPLIT_LIMIT,
            _ => Duration::from_secs(1),
        }
    }
}
impl SnapshotView {
    /// Starts holding keys for a split that was just sent. Nothing is held
    /// while input is already interrupted or another hold is running.
    pub(in crate::tmux_snapshot) fn hold_split_input(&mut self) {
        if self.pending_input.is_some() {
            return;
        }
        let Some(id) = self.browser_state.selected_pane.clone() else {
            return;
        };
        let Some(mut pending) = Pending::capture(self, self.browser_request, &id) else {
            return;
        };
        pending.kind = Kind::Split(Hold {
            before: self
                .browser_state
                .panes
                .iter()
                .map(|p| p.id.clone())
                .collect(),
            reissued: false,
        });
        pending.id.clear();
        pending.token.clear();
        self.pending_input = Some(pending);
    }
    pub(in crate::tmux_snapshot) fn split_hold_waiting(&self) -> bool {
        self.pending_input
            .as_ref()
            .is_some_and(|p| matches!(p.kind, Kind::Split(_)))
    }
    /// Notes the stream going away, then binds the hold to the new pane once
    /// the re-issued stream is ready on it.
    pub(super) fn observe_split_hold(&mut self) {
        let gone = !self.browser_state.input_ready
            || self.browser_state.retained_preview
            || self.frame.is_none();
        let ready = self.terminal_input_ready();
        let selected = self.browser_state.selected_pane.clone();
        let targets = self.browser_state.input_targets.clone();
        let Some(pending) = self.pending_input.as_mut() else {
            return;
        };
        let Kind::Split(hold) = &mut pending.kind else {
            return;
        };
        hold.reissued |= gone;
        if !hold.reissued || !ready {
            return;
        }
        let Some(pane) = selected.filter(|pane| !hold.before.contains(pane)) else {
            return;
        };
        let Some(target) = targets.into_iter().find(|t| t.id == pane) else {
            return;
        };
        pending.kind = Kind::Selection;
        pending.id = target.id;
        pending.token = target.token;
    }
}
