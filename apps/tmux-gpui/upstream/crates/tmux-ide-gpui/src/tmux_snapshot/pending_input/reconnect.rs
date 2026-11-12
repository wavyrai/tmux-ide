//! Keys typed while a dropped stream is being put back wait for it, briefly.
//!
//! A daemon that closes a stream and stays up has it back in well under a
//! second, and the user, who sees the same frame, keeps typing. Those keys
//! are held, never sent to the dead stream, and go to the same pane of the
//! same session once the new stream takes input (PM, 12 Nov 2026). The queue
//! is small ([`MAX_KEYS`], [`MAX_BYTES`]) and short ([`RECONNECT_LIMIT`] from
//! the drop). Anything else drops every held key and sets the latch, which
//! shows "Not sent…" in the pane: the reconnect took longer, the queue
//! filled, keys typed just before the drop were lost (what follows them must
//! not run alone), or the stream came back on another pane, session or
//! request, or without an input target for the pane.
use super::*;

/// From the drop, by the connection's clock, to the stream taking input.
pub(super) const RECONNECT_LIMIT: Duration = Duration::from_secs(3);
pub(super) const MAX_KEYS: usize = 32;
pub(super) const MAX_BYTES: usize = 256;

pub(in crate::tmux_snapshot) struct Hold {
    /// The new stream takes input for the pane: `Pending::token` is its token.
    bound: bool,
}
impl Hold {
    pub(super) fn waiting(&self) -> bool {
        !self.bound
    }
}
impl Pending {
    /// Whether a reconnect hold may go on waiting, or deliver, in `view`.
    pub(super) fn reconnect_compatible(&self, hold: &Hold, view: &SnapshotView) -> bool {
        let state = &view.browser_state;
        self.started.elapsed() < RECONNECT_LIMIT
            && self.request == view.browser_request
            && state.request == self.request
            && state.surface == browser::Surface::Workspace
            && state.selected_session.as_ref() == Some(&self.session)
            && state.selected_pane.as_ref() == Some(&self.id)
            && state.presence_revision == self.presence
            && view.presence.ready()
            && !view.input_interrupted
            && !state.input_target_rejected
            && !state.reconnect_keys_lost
            && state.history_offset == 0
            && view.picker.is_none()
            && view.pane_actions.is_none()
            && view.new_session.is_none()
            && view.selection.is_none()
            && view.divider.is_none()
            && view.browser_commands.is_some()
            // Back, but not for this pane: nowhere to deliver.
            && (hold.bound || !view.terminal_input_ready() || self.reconnect_target(view).is_some())
            && (!hold.bound
                || state
                    .input_targets
                    .iter()
                    .any(|t| t.id == self.id && t.token == self.token))
    }
    fn reconnect_target(&self, view: &SnapshotView) -> Option<String> {
        (view.browser_state.input_targets.iter())
            .find(|t| t.id == self.id)
            .map(|t| t.token.clone())
    }
}
impl SnapshotView {
    /// Starts holding keys for the reconnect under way, if it only just began
    /// and nothing typed before it was lost. `false`: the key is refused.
    pub(in crate::tmux_snapshot) fn hold_reconnect_input(&mut self) -> bool {
        let state = &self.browser_state;
        let Some(waited) = self.session_reconnecting_for() else {
            return false;
        };
        if self.pending_input.is_some()
            || self.input_interrupted
            || state.reconnect_attempt.is_none()
            || state.reconnect_keys_lost
            || !state.retained_preview
            || state.surface != browser::Surface::Workspace
            || state.request != self.browser_request
            || state.history_offset != 0
            || waited >= RECONNECT_LIMIT
            || !self.presence.ready()
            || self.selection.is_some()
            || self.resize_gesture.busy()
            || self.browser_commands.is_none()
        {
            return false;
        }
        let (Some(id), Some(session)) =
            (state.selected_pane.clone(), state.selected_session.clone())
        else {
            return false;
        };
        self.pending_input = Some(Pending {
            kind: Kind::Reconnect(Hold { bound: false }),
            request: self.browser_request,
            id,
            token: String::new(),
            session,
            presence: state.presence_revision,
            // The limit counts from the drop, not from the first key.
            started: Instant::now()
                .checked_sub(waited)
                .unwrap_or_else(Instant::now),
            inputs: Vec::new(),
            bytes: 0,
        });
        true
    }
    /// A reconnect hold is waiting for its stream, or starts now.
    pub(in crate::tmux_snapshot) fn reconnect_hold_takes_keys(&mut self) -> bool {
        self.reconnect_hold_waiting() || self.hold_reconnect_input()
    }
    /// A reconnect hold is still waiting for its stream.
    pub(in crate::tmux_snapshot) fn reconnect_hold_waiting(&self) -> bool {
        self.pending_input
            .as_ref()
            .is_some_and(|p| matches!(&p.kind, Kind::Reconnect(hold) if hold.waiting()))
    }
    /// Binds the hold to the pane's new input token once the stream is back.
    pub(super) fn observe_reconnect_hold(&mut self) {
        if !self.reconnect_hold_waiting() || !self.terminal_input_ready() {
            return;
        }
        let token = (self.pending_input.as_ref()).and_then(|p| p.reconnect_target(self));
        if let (Some(pending), Some(token)) = (self.pending_input.as_mut(), token)
            && let Kind::Reconnect(hold) = &mut pending.kind
        {
            hold.bound = true;
            pending.token = token;
        }
    }
    #[cfg(test)]
    pub(in crate::tmux_snapshot) fn age_pending_input_by(&mut self, by: Duration) {
        if let Some(pending) = &mut self.pending_input {
            pending.started -= by;
        }
    }
    /// The pane shows "Not sent…".
    #[cfg(test)]
    pub(in crate::tmux_snapshot) fn not_sent_shown(&self) -> bool {
        self.input_interrupted && self.browser_state.reconnect_attempt.is_some()
    }
}
