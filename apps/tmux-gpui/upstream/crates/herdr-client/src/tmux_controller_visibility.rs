//! Delivery visibility (PM, 17 Nov): a pane of a window that is not on screen
//! costs bytes for nothing. Such panes are marked `hidden`; the daemon then
//! sends them nothing until they are marked `visible` again, when their
//! window is shown, and then sends their latest state. No protocol change:
//! `terminal-delivery-visibility` is in the contract and in every daemon this
//! app talks to.
use super::*;

impl Controller {
    /// Tells the daemon which panes are on screen: those of the window that
    /// holds the selected pane. Only changes are sent; a new delivery (new
    /// nonce) starts visible on the daemon's side.
    pub(super) fn follow_visibility(&mut self) -> Result<(), Error> {
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
            let told = match self.visibility_sent.get(pane) {
                Some((nonce, told)) if *nonce == identity.delivery_nonce => *told,
                // A delivery the daemon has not been told about is visible.
                _ => true,
            };
            if told != visible {
                frames.push((
                    pane.clone(),
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
            self.visibility_sent
                .insert(pane.clone(), (identity.delivery_nonce.clone(), told));
        }
        let current = &self.current;
        self.visibility_sent
            .retain(|pane, _| current.contains_key(pane));
        for (pane, frame) in frames {
            let command = tmux_stream::Command::from_json(frame.to_string())?;
            if let Err(error) = self.session.try_send(command) {
                self.retire();
                return Err(error.into());
            }
            if let Some((_, told)) = self.visibility_sent.get_mut(&pane) {
                *told = !*told;
            }
        }
        Ok(())
    }
}

#[cfg(test)]
#[path = "tmux_controller_visibility_tests.rs"]
mod tests;
