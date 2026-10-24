//! Single-producer GUI admission, above the wire client's 256-request bound.
//! A dispatch reserves admission before transport enqueue. Bind its exact sequence
//! synchronously after enqueue; enqueue failure must call `retire`. Never replay a
//! dispatch or pending admission onto another connection or presentation scope.
use crate::tmux_control::{Input, InputCompletion, InputResult, Lifetime};
use std::collections::BTreeMap;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Scope {
    pub pane: String,
    pub lifetime: Lifetime,
    /// Rotate on selection, history/restoration handoff, or reconnect. Ordinary
    /// content/geometry changes do not change keyboard admission identity.
    pub presentation_epoch: u64,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct Ticket(pub u64);
#[derive(Debug)]
pub enum Work<T> {
    Input(Input),
    /// Paste, mouse, wheel, presence and semantic/control commands are barriers.
    Barrier(T),
}
#[derive(Debug)]
pub struct Dispatch<T> {
    pub ticket: Ticket,
    pub scope: Scope,
    pub work: Work<T>,
}
#[derive(Debug)]
pub enum Admission<T> {
    Ready(Dispatch<T>),
    Queued(Ticket),
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub enum Error {
    #[error("GUI input scheduler retired")]
    Retired,
    #[error("GUI input scope changed")]
    ScopeChanged,
    #[error("GUI input already has one waiting admission")]
    Busy,
    #[error("invalid GUI input completion correlation")]
    Correlation,
    #[error("GUI input exceeds its admission bound")]
    InvalidInput,
    #[error("GUI input ticket sequence exhausted")]
    Sequence,
}
/// Rejected work remains caller-owned. Busy is producer backpressure, not permission
/// to bypass the waiting admission. Do not create an unbounded UI queue around it.
#[derive(Debug)]
pub struct Rejected<T> {
    pub reason: Error,
    pub work: Work<T>,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Completion {
    Ok,
    AuthorityLost,
    Timeout,
    Retired,
}
#[derive(Debug)]
pub struct Update<T> {
    pub finished: Vec<(Ticket, Completion)>,
    pub next: Option<Dispatch<T>>,
}
impl<T> Default for Update<T> {
    fn default() -> Self {
        Self {
            finished: Vec::new(),
            next: None,
        }
    }
}
struct Pending {
    input: bool,
    barrier: bool,
    correlation: Option<(String, u32)>,
}
pub struct Scheduler<T> {
    scope: Scope,
    retired: bool,
    dispatch_enabled: bool,
    next_ticket: u64,
    pending: BTreeMap<Ticket, Pending>,
    waiting: Option<Dispatch<T>>,
}
impl<T> Scheduler<T> {
    pub fn new(scope: Scope) -> Self {
        Self {
            scope,
            retired: false,
            dispatch_enabled: true,
            next_ticket: 0,
            pending: BTreeMap::new(),
            waiting: None,
        }
    }
    /// Cancel only the single admission that has never reached the transport.
    /// Already dispatched correlations must still settle; cancellation never replays.
    pub fn cancel_waiting(&mut self) -> Option<Ticket> {
        self.waiting.take().map(|dispatch| dispatch.ticket)
    }
    pub fn retired(&self) -> bool {
        self.retired
    }
    pub fn pending(&self) -> usize {
        self.pending.len()
    }
    pub fn waiting(&self) -> bool {
        self.waiting.is_some()
    }
    pub fn idle(&self) -> bool {
        self.pending.is_empty() && self.waiting.is_none()
    }
    pub fn scope(&self) -> &Scope {
        &self.scope
    }
    /// Only an already drained barrier may change selection/presentation. Otherwise
    /// all old work is retired and no queued suffix is dispatched into the new pane.
    pub fn change_scope(&mut self, scope: Scope) -> Result<(), Error> {
        if self.retired {
            return Err(Error::Retired);
        }
        if self.scope == scope {
            return Ok(());
        }
        if !self.idle() {
            self.retired = true;
            return Err(Error::ScopeChanged);
        }
        self.scope = scope;
        Ok(())
    }
    pub fn admit(&mut self, scope: &Scope, work: Work<T>) -> Result<Admission<T>, Rejected<T>> {
        let bounded = match &work {
            Work::Input(Input::Text(s)) => {
                !s.is_empty()
                    && s.len() <= 4096
                    && s.encode_utf16().count() <= 1024
                    && !s.contains('\0')
            }
            Work::Input(Input::Bytes(s)) => crate::tmux_control::valid_input_bytes(s),
            Work::Input(Input::Key(s)) => !s.is_empty() && s.len() <= 64,
            Work::Barrier(_) => true, // T must itself be a bounded validated control payload.
        };
        let reason = if !bounded {
            Some(Error::InvalidInput)
        } else if self.retired {
            Some(Error::Retired)
        } else if scope != &self.scope {
            self.retired = true;
            Some(Error::ScopeChanged)
        } else if self.waiting.is_some() {
            Some(Error::Busy)
        } else {
            None
        };
        if let Some(reason) = reason {
            return Err(Rejected { reason, work });
        }
        let Some(sequence) = self.next_ticket.checked_add(1) else {
            self.retired = true;
            return Err(Rejected {
                reason: Error::Sequence,
                work,
            });
        };
        self.next_ticket = sequence;
        let dispatch = Dispatch {
            ticket: Ticket(sequence),
            scope: scope.clone(),
            work,
        };
        if self.can_dispatch(&dispatch.work) {
            self.reserve(&dispatch);
            Ok(Admission::Ready(dispatch))
        } else {
            let ticket = dispatch.ticket;
            self.waiting = Some(dispatch);
            Ok(Admission::Queued(ticket))
        }
    }
    fn can_dispatch(&self, work: &Work<T>) -> bool {
        if self.retired || !self.dispatch_enabled {
            return false;
        }
        if self.pending.values().any(|p| p.barrier) {
            return false;
        }
        if pipeline(work) {
            self.pending.len() < 8
        } else {
            self.pending.is_empty()
        }
    }
    fn reserve(&mut self, dispatch: &Dispatch<T>) {
        self.pending.insert(
            dispatch.ticket,
            Pending {
                input: matches!(dispatch.work, Work::Input(_)),
                barrier: !pipeline(&dispatch.work),
                correlation: None,
            },
        );
    }
    /// Correlate exactly one accepted wire input with the admission reservation.
    /// Multi-chunk barriers (paste/wheel) use complete_barrier only after every ACK.
    pub fn bind_input(&mut self, ticket: Ticket, pane: &str, sequence: u32) -> Result<(), Error> {
        if self.retired {
            return Err(Error::Retired);
        }
        let duplicate = self.pending.values().any(|p| {
            p.correlation
                .as_ref()
                .is_some_and(|(p, s)| p == pane && *s == sequence)
        });
        let valid = sequence != 0
            && pane == self.scope.pane
            && !duplicate
            && self
                .pending
                .get(&ticket)
                .is_some_and(|p| p.input && p.correlation.is_none());
        if !valid {
            self.retired = true;
            return Err(Error::Correlation);
        }
        if let Some(pending) = self.pending.get_mut(&ticket) {
            pending.correlation = Some((pane.into(), sequence));
        }
        Ok(())
    }
    pub fn complete_input(&mut self, completion: &InputCompletion) -> Update<T> {
        if self.retired {
            return self.retire();
        }
        let ticket = self.pending.iter().find_map(|(ticket, pending)| {
            pending
                .correlation
                .as_ref()
                .filter(|(pane, seq)| pane == &completion.pane && *seq == completion.sequence)
                .map(|_| *ticket)
        });
        let Some(ticket) = ticket else {
            return Update::default();
        };
        match completion.result {
            InputResult::Ok => self.finish(ticket),
            InputResult::AuthorityLost => self.fail(ticket, Completion::AuthorityLost),
            InputResult::Timeout => self.fail(ticket, Completion::Timeout),
            InputResult::Retired => self.fail(ticket, Completion::Retired),
        }
    }
    pub fn complete_barrier(&mut self, ticket: Ticket, success: bool) -> Result<Update<T>, Error> {
        if self.retired {
            return Err(Error::Retired);
        }
        if !self
            .pending
            .get(&ticket)
            .is_some_and(|p| !p.input && p.barrier)
        {
            self.retired = true;
            return Err(Error::Correlation);
        }
        Ok(if success {
            self.finish(ticket)
        } else {
            self.fail(ticket, Completion::Retired)
        })
    }
    /// Pause unsent work while the current presentation is temporarily unavailable.
    /// ACKs still settle normally; authority loss and scope changes still retire work.
    pub fn set_dispatch_enabled(&mut self, enabled: bool) {
        self.dispatch_enabled = enabled;
    }
    pub fn take_ready(&mut self) -> Option<Dispatch<T>> {
        if self
            .waiting
            .as_ref()
            .is_some_and(|d| self.can_dispatch(&d.work))
        {
            let dispatch = self.waiting.take();
            if let Some(dispatch) = &dispatch {
                self.reserve(dispatch);
            }
            dispatch
        } else {
            None
        }
    }
    fn finish(&mut self, ticket: Ticket) -> Update<T> {
        self.pending.remove(&ticket);
        let next = self.take_ready();
        Update {
            finished: vec![(ticket, Completion::Ok)],
            next,
        }
    }
    fn fail(&mut self, ticket: Ticket, reason: Completion) -> Update<T> {
        let mut update = self.retire();
        for (id, completion) in &mut update.finished {
            if *id == ticket {
                *completion = reason;
            }
        }
        update
    }
    /// Stop all accepted work, including the single not-yet-sent admission. Repeated
    /// calls are idempotent; late ACKs can never release a queued suffix.
    pub fn retire(&mut self) -> Update<T> {
        self.retired = true;
        let mut finished: Vec<_> = self
            .pending
            .keys()
            .map(|ticket| (*ticket, Completion::Retired))
            .collect();
        self.pending.clear();
        if let Some(waiting) = self.waiting.take() {
            finished.push((waiting.ticket, Completion::Retired));
        }
        Update {
            finished,
            next: None,
        }
    }
}
fn pipeline<T>(work: &Work<T>) -> bool {
    match work {
        Work::Input(Input::Text(data)) => !data.chars().any(char::is_control),
        Work::Input(Input::Key(data)) => matches!(
            data.as_str(),
            "BSpace"
                | "DC"
                | "Left"
                | "Right"
                | "Up"
                | "Down"
                | "Home"
                | "End"
                | "NPage"
                | "PPage"
                | "PgUp"
                | "PgDn"
                | "Space"
        ),
        Work::Input(Input::Bytes(_)) | Work::Barrier(_) => false,
    }
}
#[cfg(test)]
mod tests;
