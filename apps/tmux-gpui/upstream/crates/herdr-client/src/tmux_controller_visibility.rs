//! Delivery visibility (PM, 17 Nov; owner: visible panes stay live). A pane of
//! a window that is not on screen costs bytes for nothing: it is marked
//! `hidden`, and the daemon sends it nothing until it is marked `visible`
//! again, when its window is shown; the daemon then sends its latest state at
//! once. Until that state is in (at most `REVEAL_MS`), the window being left
//! stays up, so a window shown again never paints a pane's old state. No
//! protocol change: `terminal-delivery-visibility` is in the contract and in
//! every daemon this app talks to.
use super::*;

/// How long the window being left stays up for a revealed pane's fresh state.
/// Past it the window is shown with what there is, and the fresh state
/// replaces it when it comes; never a blank window.
pub(super) const REVEAL_MS: u64 = 150;

#[derive(Default)]
pub(super) struct Visibility {
    /// Per pane: the delivery nonce and whether the daemon was last told the
    /// pane is on screen.
    told: BTreeMap<String, (String, bool)>,
    /// Panes shown again: their revision and nonce then, and when.
    revealing: BTreeMap<String, (u64, String, u64)>,
    /// The window was held for a reveal: present it once the reveal settles.
    held: bool,
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

    /// Whether a pane shown again still waits for its fresh state, within
    /// `REVEAL_MS`.
    pub(super) fn revealing(&mut self, now: u64) -> bool {
        let current = &self.current;
        self.visibility
            .revealing
            .retain(|pane, (revision, nonce, since)| {
                current.get(pane).is_some_and(|committed| {
                    committed.identity.canonical_revision <= *revision
                        && committed.identity.delivery_nonce == *nonce
                }) && now.saturating_sub(*since) < REVEAL_MS
            });
        let revealing = !self.visibility.revealing.is_empty();
        self.visibility.held |= revealing;
        revealing
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
