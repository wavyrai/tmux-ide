//! Delivery visibility (PM, 17 Nov; owner: visible panes stay live). A pane of
//! a window that is not on screen costs bytes for nothing: it is marked
//! `hidden`, and the daemon sends it nothing until it is marked `visible`
//! again, when its window is shown; the daemon then sends its latest state at
//! once. Until that state is in (at most `REVEAL_MS`), the window being left
//! stays up, so a window shown again never paints a pane's old state. No
//! protocol change: `terminal-delivery-visibility` is in the contract and in
//! every daemon this app talks to.
use super::*;

/// The most the window being left stays up for a revealed pane's fresh state.
/// Past the hold the window is shown with what there is, and the fresh state
/// replaces it when it comes; never a blank window.
pub(super) const REVEAL_MS: u64 = 150;
/// The least hold: one display frame.
pub(super) const FRAME_MS: u64 = 17;
/// An input ACK's round trip counts over the ping's for this long.
const ACK_FRESH_MS: u64 = 10_000;

#[derive(Default)]
pub(super) struct Visibility {
    /// Per pane: the delivery nonce and whether the daemon was last told the
    /// pane is on screen.
    told: BTreeMap<String, (String, bool)>,
    /// Panes shown again: their revision and nonce then, and when.
    revealing: BTreeMap<String, (u64, String, u64)>,
    /// The window was held for a reveal: present it once the reveal settles.
    held: bool,
    /// Inputs on their way, by pane and sequence: when each was sent.
    sent: BTreeMap<(String, u32), u64>,
    /// The last input ACK's round trip, and when it came.
    ack_rtt: Option<(u64, u64)>,
}
impl Visibility {
    pub(super) fn input_sent(&mut self, pane: &str, sequence: u32, now: u64) {
        if self.sent.len() < 256 {
            self.sent.insert((pane.to_owned(), sequence), now);
        }
    }
    pub(super) fn inputs_answered(&mut self, inputs: &[InputCompletion], now: u64) {
        for input in inputs {
            if let Some(sent) = self.sent.remove(&(input.pane.clone(), input.sequence))
                && input.result == tmux_control::InputResult::Ok
            {
                self.ack_rtt = Some((now, now.saturating_sub(sent)));
            }
        }
    }
}

impl Controller {
    /// Tells the daemon which panes are on screen: those of the window that
    /// holds the selected pane. Only changes are sent; a new delivery (new
    /// nonce) starts visible on the daemon's side.
    pub(super) fn follow_visibility(&mut self, now: u64) -> Result<(), Error> {
        if self.retired {
            return Ok(());
        }
        let on_screen: Option<std::collections::BTreeSet<&str>> = (self.topology.layouts())
            .values()
            .map(|layout| {
                (layout.panes.iter())
                    .filter_map(|row| row.pane.as_deref())
                    .collect::<std::collections::BTreeSet<_>>()
            })
            .find(|panes| panes.contains(self.selected.as_str()));
        let Some(on_screen) = on_screen else {
            return Ok(());
        };
        let mut frames = Vec::new();
        for (pane, committed) in &self.current {
            if committed.snapshot.is_none() {
                continue;
            }
            let identity = &committed.identity;
            let visible = on_screen.contains(pane.as_str());
            let told = match self.visibility.told.get(pane) {
                Some((nonce, told)) if *nonce == identity.delivery_nonce => *told,
                // A delivery the daemon has not been told about is visible.
                _ => true,
            };
            if told != visible {
                frames.push((
                    pane.clone(),
                    visible,
                    (identity.canonical_revision, identity.delivery_nonce.clone()),
                    json!({
                        "type": "terminal-delivery-visibility",
                        "workspaceName": self.policy.workspace(),
                        "pane": pane,
                        "generation": identity.generation,
                        "incarnation": identity.incarnation,
                        "deliveryNonce": identity.delivery_nonce,
                        "visibility": if visible { "visible" } else { "hidden" },
                    }),
                ));
            }
            self.visibility
                .told
                .insert(pane.clone(), (identity.delivery_nonce.clone(), told));
        }
        let current = &self.current;
        self.visibility
            .told
            .retain(|pane, _| current.contains_key(pane));
        for (pane, visible, (revision, nonce), frame) in frames {
            let command = tmux_stream::Command::from_json(frame.to_string())?;
            if let Err(error) = self.session.try_send(command) {
                self.retire();
                return Err(error.into());
            }
            if let Some((_, told)) = self.visibility.told.get_mut(&pane) {
                *told = visible;
            }
            if visible {
                self.visibility
                    .revealing
                    .insert(pane, (revision, nonce, now));
            } else {
                self.visibility.revealing.remove(&pane);
            }
        }
        Ok(())
    }

    /// The Mac woke or the network changed: ask the stream whether its link
    /// is still there. No answer within the pong limit ends it as silent.
    pub fn probe_link(&self) {
        self.session.probe();
    }
    /// The link is being probed: keys are better held than sent.
    pub fn link_probing(&self) -> bool {
        self.session.probing()
    }
    /// The connection's round trip in ms: the last input ACK's while keys
    /// flow (fresher), else the stream's last ping; `None` before either.
    fn rtt_ms(&self, now: u64) -> Option<u64> {
        let ack = (self.visibility.ack_rtt)
            .filter(|(at, _)| now.saturating_sub(*at) < ACK_FRESH_MS)
            .map(|(_, rtt)| rtt);
        let ping =
            (self.session.rtt()).map(|rtt| u64::try_from(rtt.as_millis()).unwrap_or(u64::MAX));
        ack.or(ping)
    }
    /// How long a window shown again is held (PM, 17 Nov): twice the round
    /// trip, at least one display frame, at most `REVEAL_MS`; the cap until
    /// the round trip is known. A changed pane's delivery usually lands within
    /// two round trips; an unchanged pane's state is already current.
    pub(super) fn reveal_ms(&self, now: u64) -> u64 {
        self.rtt_ms(now).map_or(REVEAL_MS, |rtt| {
            rtt.saturating_mul(2).clamp(FRAME_MS, REVEAL_MS)
        })
    }
    /// Whether a pane shown again still waits for its fresh state, within
    /// `reveal_ms`.
    pub(super) fn revealing(&mut self, now: u64) -> bool {
        let bound = self.reveal_ms(now);
        let current = &self.current;
        self.visibility
            .revealing
            .retain(|pane, (revision, nonce, since)| {
                current.get(pane).is_some_and(|committed| {
                    committed.identity.canonical_revision <= *revision
                        && committed.identity.delivery_nonce == *nonce
                }) && now.saturating_sub(*since) < bound
            });
        let revealing = !self.visibility.revealing.is_empty();
        self.visibility.held |= revealing;
        revealing
    }

    /// A window shown again is held for its panes' fresh state: input waits
    /// for it, and keys typed meanwhile are held for the pane then selected.
    pub fn reveal_hold(&self) -> bool {
        !self.visibility.revealing.is_empty()
    }

    /// The window was held for a reveal that has now settled: present again
    /// even with nothing else new.
    pub(super) fn reveal_settled(&mut self, now: u64) -> bool {
        if !self.visibility.held || self.revealing(now) {
            return false;
        }
        self.visibility.held = false;
        true
    }
}

#[cfg(test)]
#[path = "tmux_controller_visibility_tests.rs"]
mod tests;
