//! An interrupted terminal gesture must never resume with only its suffix.
use super::SnapshotView;
use gpui::Context;
impl SnapshotView {
    pub(super) fn terminal_input_ready(&self) -> bool {
        !self.browser_state.input_target_rejected
            && self.divider.is_none()
            && !self.resize_gesture.busy()
            && !self.browser_state.retained_preview
            && self.picker.is_none()
            && self.pane_actions.is_none()
            && self.new_session.is_none()
            && self.presence.ready()
            && self.session_tabs.pending.is_none()
            && self.browser_state.input_ready
            && !self.browser_state.link_probe
            && self.frame.is_some()
            && self.browser_state.selected_pane.is_some()
    }
    pub(super) fn historical_selection_ready(&self) -> bool {
        !self.browser_state.retained_preview
            && self.divider.is_none()
            && !self.resize_gesture.busy()
            && self.picker.is_none()
            && self.pane_actions.is_none()
            && self.new_session.is_none()
            && self.presence.ready()
            && self.browser_commands.is_some()
            && self.browser_state.request == self.browser_request
            && self.browser_state.surface == super::browser::Surface::Workspace
            && self.browser_state.history_offset > 0
            && !self.browser_state.input_ready
            && self
                .frame
                .as_ref()
                .zip(self.browser_state.frame.as_ref())
                .is_some_and(|(paint, current)| paint.same(current))
            && self.browser_state.selected_pane.is_some()
    }
    /// The catalog is reconnecting: keys are refused, unless the reconnect
    /// only just began (`pending_input/reconnect.rs` holds those).
    fn reconnect_hold(&self) -> bool {
        self.browser_state.reconnect_attempt.is_some()
    }
    /// A refused key counts toward the pane's "not sent": the catalog is
    /// reconnecting, or a reconnect hold was dropped and its notice shows.
    fn counts_refused_keys(&self) -> bool {
        self.reconnect_hold() || self.connection.keys_refused
    }
    /// Lifts a latch that only a reconnect set, once the same session accepts
    /// input again. Nothing typed meanwhile is sent: those keys were refused.
    /// A latch from anything else (a gesture, a rejected target) still needs
    /// the terminal click.
    pub(super) fn release_refused_keys(&mut self) {
        if !self.connection.keys_refused {
            return;
        }
        let state = &self.browser_state;
        if state.surface != super::browser::Surface::Workspace || state.input_target_rejected {
            self.connection.keys_refused = false;
            self.connection.keys_not_sent = 0;
        } else if state.reconnect_attempt.is_none()
            && !state.link_probe
            && state.input_ready
            && !state.retained_preview
        {
            self.connection.keys_refused = false;
            self.connection.keys_not_sent = 0;
            self.input_interrupted = false;
        }
    }
    pub(super) fn interrupt_input(&mut self, cx: &mut Context<Self>) {
        // A dropped reconnect hold is a reconnect's refusal, also when its
        // link was only probed and no reconnect shows yet: the pane says how
        // many keys, and the latch lifts by itself (review of #863, round 2).
        let held = (self.pending_input.take()).and_then(|pending| pending.reconnect_keys());
        self.connection.keys_not_sent += held.unwrap_or(0);
        self.cancel_pointer();
        // Only a latch that every cause was a reconnect hold lifts by itself.
        // A key refused while a probe hold's notice shows is such a cause:
        // a key on repeat goes on after the hold was dropped.
        let probing = self.connection.keys_refused && self.browser_state.link_probe;
        let hold = self.reconnect_hold() || held.is_some() || probing;
        self.connection.keys_refused =
            hold && (self.connection.keys_refused || !self.input_interrupted);
        self.input_interrupted = true;
        self.discard_composition(cx);
        cx.notify();
    }
    /// Refuses a key at the keyboard, before it is offered to the terminal.
    /// While reconnecting, a key meant for the pane (`typed`) counts toward
    /// the pane's "not sent", as one refused by [`Self::offer_terminal_input`].
    pub(super) fn refuse_key(&mut self, typed: bool, cx: &mut Context<Self>) {
        if typed && self.counts_refused_keys() {
            self.connection.keys_not_sent += 1;
        }
        self.interrupt_input(cx);
    }
    /// Whether a key may go to the terminal now (or wait in a hold). A key
    /// refused while reconnecting counts toward the pane's "not sent".
    pub(super) fn offer_terminal_input(&mut self, cx: &mut Context<Self>) -> bool {
        let offered = self.offer_terminal(cx);
        if !offered && self.counts_refused_keys() {
            self.connection.keys_not_sent += 1;
        }
        offered
    }
    /// As [`Self::offer_terminal_input`], for a pointer or wheel event: never
    /// counted as a key.
    pub(super) fn offer_terminal_pointer(&mut self, cx: &mut Context<Self>) -> bool {
        self.offer_terminal(cx)
    }
    fn offer_terminal(&mut self, cx: &mut Context<Self>) -> bool {
        if self.picker.is_some()
            || self.pane_actions.is_some()
            || self.new_session.is_some()
            || self.about.is_some()
        {
            return false;
        }
        if self.divider.is_some() || self.resize_gesture.busy() {
            self.interrupt_input(cx);
            return false;
        }
        self.expire_pending_input(cx);
        if !self.terminal_input_ready()
            && !self.pending_input_ready()
            && !self.hold_reconnect_input()
            && !self.hold_reveal_input()
        {
            self.interrupt_input(cx);
        }
        // Only a current, ready terminal click clears this local latch. Publications,
        // target changes and activation never turn an interrupted command into input.
        !self.input_interrupted
    }
}
