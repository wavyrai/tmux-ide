//! One native pane action, never retried after transport submission.
use super::{Controller, Error, Update};
use crate::tmux_control::{
    self, Authority, Axis, Direction, Intent, IntentOutcome, Lifetime, Rename, Zoom,
};
#[derive(Clone, Debug)]
pub enum PaneAction {
    Rename(String),
    Zoom(Zoom),
    Split(Direction),
    Close,
    Resize { axis: Axis, cells: u16 },
}
impl PaneAction {
    pub fn structural(&self) -> bool {
        matches!(self, Self::Split(_) | Self::Close)
    }
    pub fn geometry(&self) -> bool {
        !matches!(self, Self::Rename(_))
    }
    fn intent(&self, pane: &str) -> Intent {
        match self {
            Self::Rename(name) => Intent::Rename(Rename::Pane {
                pane: pane.into(),
                name: name.clone(),
            }),
            Self::Zoom(desired) => Intent::Zoom {
                pane: pane.into(),
                desired: *desired,
            },
            Self::Split(direction) => Intent::Split {
                pane: pane.into(),
                direction: *direction,
                display_title: None,
            },
            Self::Close => Intent::KillPane { pane: pane.into() },
            Self::Resize { axis, cells } => Intent::Resize {
                pane: pane.into(),
                axis: *axis,
                cells: *cells,
            },
        }
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActionOutcome {
    Applied,
    Rejected,
    Stale,
    TimedOut,
    Cancelled,
}
#[derive(Debug)]
pub struct ActionCompletion {
    pub operation_id: String,
    pub pane: String,
    pub outcome: ActionOutcome,
    pub reissue: bool,
}
struct Pending {
    pane: String,
    lifetime: Lifetime,
    operation: String,
    action: PaneAction,
    deadline: u64,
    sent: bool,
    geometry_requested: bool,
}
#[derive(Default)]
pub struct ActionState {
    pending: Option<Pending>,
}
impl ActionState {
    pub fn busy(&self) -> bool {
        self.pending.is_some()
    }
    /// Waiting means accepted locally but not yet submitted as a semantic intent.
    pub fn waiting(&self) -> bool {
        self.pending.as_ref().is_some_and(|p| !p.sent)
    }
    pub fn submit(
        &mut self,
        c: &mut Controller,
        pane: &str,
        lifetime: &Lifetime,
        operation: &str,
        action: PaneAction,
        now: u64,
    ) -> Result<(), Error> {
        if self.busy()
            || c.pending_selection.is_some()
            || c.viewport.is_some()
            || c.inflight_viewport.is_some()
            || !c.policy.barrier_ready()
        {
            return Err(tmux_control::Error::Busy.into());
        }
        if uuid::Uuid::parse_str(operation).is_err() {
            return Err(Error::Invalid);
        }
        match &action {
            PaneAction::Rename(name)
                if name.is_empty()
                    || name.encode_utf16().count() > 80
                    || name.trim() != name
                    || name.chars().any(char::is_control) =>
            {
                return Err(Error::Invalid);
            }
            PaneAction::Resize { cells, .. } if !(1..=4096).contains(cells) => {
                return Err(Error::Invalid);
            }
            _ => {}
        }
        if !current(c, pane, lifetime) {
            return Err(tmux_control::Error::Lifetime.into());
        }
        self.pending = Some(Pending {
            pane: pane.into(),
            lifetime: lifetime.clone(),
            operation: operation.into(),
            action,
            deadline: now.saturating_add(2000),
            sent: false,
            geometry_requested: false,
        });
        if let Err(error) = self.advance(c, now) {
            self.pending = None;
            return Err(error);
        }
        Ok(())
    }
    fn advance(&mut self, c: &mut Controller, now: u64) -> Result<(), Error> {
        let Some(pending) = self.pending.as_mut() else {
            return Ok(());
        };
        if pending.sent || !c.policy.barrier_ready() {
            return Ok(());
        }
        if pending.action.geometry() && !c.owns(Authority::Geometry) {
            if !pending.geometry_requested {
                // Share the connection's outstanding geometry request; never create a contender.
                if !c.geometry_requested {
                    let command = match c.policy.request_authority(
                        Authority::Geometry,
                        &uuid::Uuid::new_v4().to_string(),
                        now,
                    ) {
                        Ok(command) => command,
                        Err(tmux_control::Error::Busy) => return Ok(()),
                        Err(error) => return Err(error.into()),
                    };
                    c.send(command)?;
                }
                pending.geometry_requested = true;
            }
            return Ok(());
        }
        let command = c.policy.submit_intent(
            &pending.operation,
            pending.action.intent(&pending.pane),
            now,
        )?;
        pending.sent = true;
        pending.deadline = now.saturating_add(12000);
        c.send(command)
    }
    /// Feed every ordered controller update. An uncertain structural result is not replayed.
    pub fn poll(
        &mut self,
        c: &mut Controller,
        update: &Update,
        now: u64,
    ) -> Result<Option<ActionCompletion>, Error> {
        let Some(pending) = self.pending.as_ref() else {
            return Ok(None);
        };
        let receipt = update
            .intents
            .iter()
            .find(|r| r.operation_id == pending.operation);
        let outcome = if let Some(receipt) = receipt {
            Some(if !receipt.current {
                ActionOutcome::Stale
            } else if matches!(receipt.outcome, IntentOutcome::Applied { .. }) {
                ActionOutcome::Applied
            } else {
                ActionOutcome::Rejected
            })
        } else if update.intent_timeouts.contains(&pending.operation) || now >= pending.deadline {
            Some(ActionOutcome::TimedOut)
        } else if !pending.sent && !current(c, &pending.pane, &pending.lifetime) {
            Some(ActionOutcome::Stale)
        } else {
            None
        };
        if let Some(outcome) = outcome {
            // A validated applied structural receipt may already have invalidated its old
            // lifetime. Refresh scope without treating that stale receipt as authority.
            let reissue = pending.action.structural()
                && receipt.is_some_and(|receipt| {
                    matches!(receipt.outcome, IntentOutcome::Applied { .. })
                });
            let mut completion = self.finish(outcome);
            if let Some(completion) = completion.as_mut() {
                completion.reissue |= reissue;
            }
            return Ok(completion);
        }
        self.advance(c, now)?;
        Ok(None)
    }
    /// Only never-dispatched actions may be cancelled locally; accepted intents still correlate.
    pub fn cancel_waiting(&mut self) -> Option<ActionCompletion> {
        if self.waiting() {
            self.finish(ActionOutcome::Cancelled)
        } else {
            None
        }
    }
    /// A structural action can close its source stream before its receipt arrives.
    /// Refresh inventory after submission, but never replay the uncertain mutation.
    pub fn interrupted(&mut self) -> Option<ActionCompletion> {
        let reissue = self
            .pending
            .as_ref()
            .is_some_and(|p| p.sent && p.action.structural());
        let mut completion = self.finish(ActionOutcome::TimedOut)?;
        completion.reissue = reissue;
        Some(completion)
    }
    fn finish(&mut self, outcome: ActionOutcome) -> Option<ActionCompletion> {
        self.pending.take().map(|pending| ActionCompletion {
            operation_id: pending.operation,
            pane: pending.pane,
            reissue: pending.action.structural() && outcome == ActionOutcome::Applied,
            outcome,
        })
    }
}
fn current(c: &Controller, pane: &str, lifetime: &Lifetime) -> bool {
    !c.retired
        && c.actionable
        && c.selected() == pane
        && c.owns(Authority::Input)
        && c.selectable(pane).as_ref() == Some(lifetime)
}
#[cfg(test)]
#[path = "tmux_controller_actions_tests.rs"]
mod tests;
