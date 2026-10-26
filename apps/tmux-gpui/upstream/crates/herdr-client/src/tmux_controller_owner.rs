//! Bounded permission gate for broker-owned HTTP actions. Authorization is single-use.
use super::{Controller, Error};
use crate::tmux_control::{self, Authority, Lifetime};

#[derive(Clone, Debug)]
pub struct OwnerAuthorization {
    pub operation_id: String,
    pub pane: String,
    pub lifetime: Lifetime,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OwnerOutcome {
    Applied,
    Rejected,
    Stale,
    TimedOut,
    Cancelled,
}
#[derive(Debug)]
pub struct OwnerCompletion {
    pub operation_id: String,
    pub pane: String,
    pub outcome: OwnerOutcome,
    /// A submitted request may have changed topology even when its HTTP result is unknown.
    pub submitted: bool,
}
#[derive(Debug)]
pub enum OwnerEvent {
    Authorized(OwnerAuthorization),
    Completed(OwnerCompletion),
}
struct Pending {
    authorization: OwnerAuthorization,
    deadline: u64,
    submitted: bool,
    geometry_requested: bool,
}
#[derive(Default)]
pub struct OwnerState {
    pending: Option<Pending>,
}
impl OwnerState {
    pub fn busy(&self) -> bool {
        self.pending.is_some()
    }
    pub fn waiting(&self) -> bool {
        self.pending.as_ref().is_some_and(|p| !p.submitted)
    }
    /// Caller blocks all input, navigation, fits and other actions until completion.
    pub fn submit(
        &mut self,
        c: &Controller,
        pane: &str,
        lifetime: &Lifetime,
        operation: &str,
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
        if !current(c, pane, lifetime) {
            return Err(tmux_control::Error::Lifetime.into());
        }
        self.pending = Some(Pending {
            authorization: OwnerAuthorization {
                operation_id: operation.into(),
                pane: pane.into(),
                lifetime: lifetime.clone(),
            },
            deadline: now.saturating_add(2000),
            submitted: false,
            geometry_requested: false,
        });
        Ok(())
    }
    /// Run after each Controller poll, immediately before sending an Authorized broker message.
    pub fn poll(&mut self, c: &mut Controller, now: u64) -> Result<Option<OwnerEvent>, Error> {
        let Some(pending) = self.pending.as_ref() else {
            return Ok(None);
        };
        let is_current = current(
            c,
            &pending.authorization.pane,
            &pending.authorization.lifetime,
        );
        if let Some(event) = self.transition(
            now,
            is_current,
            c.policy.barrier_ready(),
            c.owns(Authority::Geometry),
        ) {
            return Ok(Some(event));
        }
        let Some(pending) = self.pending.as_mut() else {
            return Ok(None);
        };
        if !pending.submitted
            && !pending.geometry_requested
            && c.policy.barrier_ready()
            && !c.owns(Authority::Geometry)
        {
            if !c.geometry_requested {
                let command = match c.policy.request_authority(
                    Authority::Geometry,
                    &uuid::Uuid::new_v4().to_string(),
                    now,
                ) {
                    Ok(command) => command,
                    Err(tmux_control::Error::Busy) => return Ok(None),
                    Err(error) => return Err(error.into()),
                };
                c.send(command)?;
            }
            pending.geometry_requested = true;
        }
        Ok(None)
    }
    fn transition(
        &mut self,
        now: u64,
        current: bool,
        barrier: bool,
        geometry: bool,
    ) -> Option<OwnerEvent> {
        let pending = self.pending.as_mut()?;
        if now >= pending.deadline {
            return self
                .finish(OwnerOutcome::TimedOut)
                .map(OwnerEvent::Completed);
        }
        if pending.submitted {
            return None;
        }
        if !current {
            return self.finish(OwnerOutcome::Stale).map(OwnerEvent::Completed);
        }
        if !barrier || !geometry {
            return None;
        }
        pending.submitted = true;
        pending.deadline = now.saturating_add(12000);
        Some(OwnerEvent::Authorized(pending.authorization.clone()))
    }
    /// A retired terminal cannot authorize new work. Already submitted owner IO
    /// stays correlated until its reply or the original deadline.
    pub fn poll_interrupted(&mut self, now: u64) -> Option<OwnerCompletion> {
        match self.transition(now, false, false, false) {
            Some(OwnerEvent::Completed(done)) => Some(done),
            _ => None,
        }
    }
    /// Only the exact submitted operation may release the gate; duplicate/stale replies do nothing.
    pub fn complete(&mut self, operation: &str, success: bool) -> Option<OwnerCompletion> {
        if !self
            .pending
            .as_ref()
            .is_some_and(|p| p.submitted && p.authorization.operation_id == operation)
        {
            return None;
        }
        self.finish(if success {
            OwnerOutcome::Applied
        } else {
            OwnerOutcome::Rejected
        })
    }
    /// Blur drops an unsent action. Submitted HTTP requests remain correlated and are never replayed.
    pub fn cancel_waiting(&mut self) -> Option<OwnerCompletion> {
        if self.waiting() {
            self.finish(OwnerOutcome::Cancelled)
        } else {
            None
        }
    }
    fn finish(&mut self, outcome: OwnerOutcome) -> Option<OwnerCompletion> {
        self.pending.take().map(|p| OwnerCompletion {
            operation_id: p.authorization.operation_id,
            pane: p.authorization.pane,
            outcome,
            submitted: p.submitted,
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
#[path = "tmux_controller_owner_tests.rs"]
mod tests;
