//! Keys typed while a dropped stream is being put back wait for it, briefly.
//!
//! A daemon that closes a stream and stays up has it back in well under a
//! second, and the user, who sees the same frame, keeps typing. Those keys
//! are held, never sent to the dead stream, and go to the same pane of the
//! same session once the new stream takes input (PM, 12 Nov 2026), in order
//! and exactly once. The queue is bounded ([`MAX_KEYS`], [`MAX_BYTES`], and
//! [`MAX_INPUTS`] once text is joined) and short ([`RECONNECT_LIMIT`] from
//! the drop; reconnect, 19 Nov: 512 keys and 5 s). Anything else drops every held key and sets the latch, which shows
//! how many keys were not sent in the pane: the reconnect took longer, the
//! queue filled, keys typed just before the drop were lost (what follows them
//! must not run alone), or the stream came back on another pane, session
//! (a session re-created under the same name has another live id) or
//! request, or without an input target for the pane.
//!
//! The same hold covers a link that is only suspect: the Mac woke or the
//! network changed and the stream's probe is unanswered (`link_probe`). Keys
//! typed then wait for the answer, on the same stream, rather than going into
//! a link that may be dead. If the probe fails, the drop that follows
//! continues the hold, and its limit counts from that drop.
//!
//! All or nothing: once the first held key is sent the rest follow, whatever
//! the clock says, so a hold never delivers only its beginning by its own
//! limit.
use super::*;

/// From the drop, by the connection's clock, to the stream taking input.
pub(super) const RECONNECT_LIMIT: Duration = Duration::from_secs(5);
pub(super) const MAX_KEYS: usize = 512;
pub(super) const MAX_BYTES: usize = 64 * 1024;
/// How many inputs a hold may send once its text is joined: what the command
/// channel to the terminal loop takes at once (32), as before 19 Nov. The
/// loop's queue behind it takes 64 and refuses the newest when full, and it
/// empties only 8 inputs per round trip, so a longer hold of keys that do
/// not join (Enter or Backspace on repeat) would lose keys from its middle
/// and say nothing (review of #863, item 2). One key more refuses them all.
pub(super) const MAX_INPUTS: usize = 32;

/// Whether `next` joins a held text input of `bytes` and `units` (UTF-16):
/// together they stay within what one input carries.
fn joins(bytes: usize, units: usize, next: &str) -> bool {
    bytes + next.len() <= 4096 && units + next.encode_utf16().count() <= 1024
}
/// How many inputs `inputs` are once [`Pending::join_reconnect_text`] has
/// joined their text.
pub(super) fn joined_len<'a>(inputs: impl Iterator<Item = &'a Input>) -> usize {
    let mut count = 0;
    // The bytes and UTF-16 units of the text input still open for joining.
    let mut open: Option<(usize, usize)> = None;
    for input in inputs {
        let Input::Text(next) = input else {
            open = None;
            count += 1;
            continue;
        };
        match &mut open {
            Some((bytes, units)) if joins(*bytes, *units, next) => {
                *bytes += next.len();
                *units += next.encode_utf16().count();
            }
            _ => {
                open = Some((next.len(), next.encode_utf16().count()));
                count += 1;
            }
        }
    }
    count
}

pub(in crate::tmux_snapshot) struct Hold {
    /// The new stream takes input for the pane: `Pending::token` is its token.
    bound: bool,
    /// Begun while the live stream's link was probed, before any drop. The
    /// probe bounds this phase (the stream's pong limit); a drop restarts the
    /// clock from the drop.
    probe: bool,
    /// The first held key was sent: the rest go too.
    pub(super) delivering: bool,
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
        // A probe ends in its answer or a drop well within twice the limit.
        let limit = if hold.probe {
            RECONNECT_LIMIT * 2
        } else {
            RECONNECT_LIMIT
        };
        (hold.delivering || self.started.elapsed() < limit)
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
    /// Before the first held key goes out: text typed one letter at a time
    /// is joined (bounded like one input), so 512 held letters are a few
    /// commands, not 512, and fit the queues between here and the stream.
    /// The order is kept; keys and pastes stay as they were.
    pub(super) fn join_reconnect_text(&mut self) {
        if !matches!(&self.kind, Kind::Reconnect(hold) if !hold.delivering) {
            return;
        }
        let mut joined: Vec<Input> = Vec::with_capacity(self.inputs.len());
        for input in self.inputs.drain(..) {
            if let (Some(Input::Text(last)), Input::Text(next)) = (joined.last_mut(), &input)
                && joins(last.len(), last.encode_utf16().count(), next)
            {
                last.push_str(next);
                continue;
            }
            joined.push(input);
        }
        self.inputs = joined;
    }
    /// The first held key was sent: the rest follow, all of them.
    pub(super) fn reconnect_delivering(&mut self) {
        if let Kind::Reconnect(hold) = &mut self.kind {
            hold.delivering = true;
        }
    }
    /// Held keys a reconnect drops, for the pane's notice.
    pub(in crate::tmux_snapshot) fn reconnect_keys(&self) -> usize {
        match &self.kind {
            Kind::Reconnect(_) => self.inputs.len(),
            _ => 0,
        }
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
        let probe = state.link_probe
            && state.reconnect_attempt.is_none()
            && state.input_ready
            && !state.retained_preview;
        let Some(waited) = (if probe {
            Some(Duration::ZERO)
        } else {
            self.session_reconnecting_for()
        }) else {
            return false;
        };
        if self.pending_input.is_some()
            || self.input_interrupted
            || (!probe && (state.reconnect_attempt.is_none() || !state.retained_preview))
            || state.reconnect_keys_lost
            || state.surface != browser::Surface::Workspace
            || state.request != self.browser_request
            || state.history_offset != 0
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
            kind: Kind::Reconnect(Hold {
                bound: false,
                probe,
                delivering: false,
            }),
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
    /// Keys waiting in a reconnect hold, and how long the hold has waited.
    pub(in crate::tmux_snapshot) fn reconnect_held(&self) -> Option<(usize, Duration)> {
        let pending = self.pending_input.as_ref()?;
        matches!(&pending.kind, Kind::Reconnect(hold) if hold.waiting())
            .then(|| (pending.inputs.len(), pending.started.elapsed()))
    }
    /// Wakes the view when the hold's limit passes, so keys that can no
    /// longer be delivered are reported at once, not on the next event.
    pub(super) fn arm_reconnect_hold_wake(&mut self, cx: &mut Context<Self>) {
        let Some(pending) = self.pending_input.as_ref() else {
            self.connection._hold_wake = None;
            return;
        };
        let Kind::Reconnect(hold) = &pending.kind else {
            self.connection._hold_wake = None;
            return;
        };
        if hold.delivering {
            return;
        }
        let limit = if hold.probe {
            RECONNECT_LIMIT * 2
        } else {
            RECONNECT_LIMIT
        };
        let at = pending.started + limit + Duration::from_millis(10);
        if self
            .connection
            ._hold_wake
            .as_ref()
            .is_some_and(|(armed, _)| *armed == at)
        {
            return;
        }
        let task = cx.spawn(async move |this, cx| {
            let wait = at.saturating_duration_since(Instant::now());
            cx.background_executor().timer(wait).await;
            let _ = this.update(cx, |view, cx| {
                view.expire_pending_input(cx);
                cx.notify();
            });
        });
        self.connection._hold_wake = Some((at, task));
    }
    /// A reconnect hold is still waiting for its stream.
    pub(in crate::tmux_snapshot) fn reconnect_hold_waiting(&self) -> bool {
        self.pending_input
            .as_ref()
            .is_some_and(|p| matches!(&p.kind, Kind::Reconnect(hold) if hold.waiting()))
    }
    /// Binds the hold to the pane's new input token once the stream is back.
    /// A probe that failed became a drop: the limit counts from the drop.
    pub(super) fn observe_reconnect_hold(&mut self) {
        if !self.reconnect_hold_waiting() {
            return;
        }
        let dropped = self.session_reconnecting_for();
        if let Some(pending) = self.pending_input.as_mut()
            && let Kind::Reconnect(hold) = &mut pending.kind
            && hold.probe
            && let Some(waited) = dropped
        {
            hold.probe = false;
            pending.started = Instant::now()
                .checked_sub(waited)
                .unwrap_or_else(Instant::now);
        }
        if !self.terminal_input_ready() {
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
