//! Keys typed after a split are held for the pane that split created.
//!
//! A split re-issues the stream, so for a moment nothing can take input. The
//! user expects to type straight into the new pane: the worker opens the
//! re-issued stream on it (tmux itself splits with `-d`, keeping focus). Keys
//! typed from the click on are held, never sent to the old pane, and go to the
//! created pane once its stream is ready. The worker names that pane from the
//! split's own validated receipt (`browser::PaneSplit`), so a pane another
//! client splits in is never a target. Anything else drops the keys and sets
//! the latch, as before: the split was not applied, the stream came back on
//! another pane, the pane has no input target, the session or request
//! changed, or the hold outlived its deadline.
use super::*;

/// How long a split may take to come back before held keys are dropped. It
/// stays the deadline after the hold binds to the new pane.
const SPLIT_LIMIT: Duration = Duration::from_secs(3);

pub(in crate::tmux_snapshot) struct Hold {
    /// The split outcome already in the state when the hold started: an older
    /// split's answer, never this one's.
    seen: Option<uuid::Uuid>,
    /// This split's outcome, once seen: `Some(None)` when not applied.
    created: Option<Option<String>>,
    /// The stream went away after the click, as a re-issue does.
    reissued: bool,
    /// Bound to the created pane: `Pending::id` and `token` name it.
    bound: bool,
}
impl Hold {
    /// Still waiting for the created pane's stream.
    pub(super) fn waiting(&self) -> bool {
        !self.bound
    }
    /// The split was not applied: the keys have nowhere to go.
    pub(super) fn failed(&self) -> bool {
        matches!(self.created, Some(None))
    }
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
            seen: self.browser_state.pane_split.as_ref().map(|s| s.nonce),
            created: None,
            reissued: false,
            bound: false,
        });
        pending.id.clear();
        pending.token.clear();
        self.pending_input = Some(pending);
    }
    /// A split hold is running, bound or not.
    pub(in crate::tmux_snapshot) fn split_hold_waiting(&self) -> bool {
        self.pending_input
            .as_ref()
            .is_some_and(|p| matches!(&p.kind, Kind::Split(hold) if hold.waiting()))
    }
    /// Records this split's outcome and the stream going away, then binds the
    /// hold to the created pane once the re-issued stream is ready on it.
    pub(super) fn observe_split_hold(&mut self) {
        let gone = !self.browser_state.input_ready
            || self.browser_state.retained_preview
            || self.frame.is_none();
        let ready = self.terminal_input_ready();
        let outcome = self.browser_state.pane_split.clone();
        let selected = self.browser_state.selected_pane.clone();
        let targets = self.browser_state.input_targets.clone();
        let Some(pending) = self.pending_input.as_mut() else {
            return;
        };
        let Kind::Split(hold) = &mut pending.kind else {
            return;
        };
        if hold.created.is_none()
            && let Some(outcome) = outcome.filter(|o| Some(o.nonce) != hold.seen)
        {
            hold.created = Some(outcome.created);
        }
        hold.reissued |= gone;
        let Some(Some(created)) = &hold.created else {
            return;
        };
        if hold.bound || !hold.reissued || !ready || selected.as_ref() != Some(created) {
            return;
        }
        let Some(target) = targets.into_iter().find(|t| &t.id == created) else {
            return;
        };
        hold.bound = true;
        pending.id = target.id;
        pending.token = target.token;
    }
    #[cfg(test)]
    pub(in crate::tmux_snapshot) fn age_split_hold(&mut self, by: Duration) {
        if let Some(pending) = &mut self.pending_input {
            pending.started = Instant::now() - by;
        }
    }
}
