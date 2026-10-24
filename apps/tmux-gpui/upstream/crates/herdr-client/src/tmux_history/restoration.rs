use super::{
    AnchorResult, Proof, Scope, Viewport, size::Sizes, viewport::bounded_history, wire::uuid,
};
use crate::tmux_delivery::Row;
use std::{collections::VecDeque, sync::Arc};
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HistoryState {
    Live,
    Historical,
    Restoring,
    Lost,
    Unavailable,
    Unsupported,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Ticket {
    serial: u64,
    scope: Scope,
}
#[derive(Clone, Debug)]
pub enum AnchorOperation {
    Capture { history_index: usize },
    Resolve { token: String },
}
#[derive(Clone, Debug)]
pub struct AnchorAction {
    pub ticket: Ticket,
    pub proof: Proof,
    pub operation: AnchorOperation,
}
struct Frame {
    proof: Proof,
    scope: Scope,
    cols: usize,
    rows: usize,
    alternate: bool,
    start: usize,
    history: Vec<Arc<Row>>,
    bytes: usize,
}
struct Pending {
    ticket: Ticket,
    resolve: bool,
    deadline_ms: Option<u64>,
}
/// Opaque token persistence; all viewport identity is proved by canonical row Arcs.
pub struct Restoration {
    state: HistoryState,
    token: Option<String>,
    serial: u64,
    pending: Option<Pending>,
    resolved: Option<(Proof, usize)>,
    frames: VecDeque<Frame>,
    sizes: Sizes,
}
impl Default for Restoration {
    fn default() -> Self {
        Self {
            state: HistoryState::Live,
            token: None,
            serial: 0,
            pending: None,
            resolved: None,
            frames: VecDeque::new(),
            sizes: Sizes::default(),
        }
    }
}
impl Restoration {
    pub fn state(&self) -> HistoryState {
        self.state
    }
    pub fn token(&self) -> Option<&str> {
        self.token.as_deref()
    }
    pub fn pending(&self) -> bool {
        self.pending.is_some()
    }
    fn cancel(&mut self) {
        self.serial = self.serial.saturating_add(1);
        self.pending = None;
        self.resolved = None;
    }
    fn finish(&mut self, state: HistoryState) {
        self.cancel();
        self.state = state;
    }
    pub fn live(&mut self) {
        self.token = None;
        self.finish(HistoryState::Live);
    }
    pub fn lost(&mut self) {
        self.token = None;
        self.finish(HistoryState::Lost);
    }
    pub fn unavailable(&mut self) {
        self.token = None;
        self.finish(HistoryState::Unavailable);
    }
    /// Retire on any selected-pane/connection lifetime change, even if pane labels match.
    pub fn retire(&mut self) {
        self.live();
        self.frames.clear();
        self.sizes = Sizes::default();
    }
    pub fn observe(&mut self, proof: Proof, viewport: &mut Viewport, now_ms: u64) {
        self.tick(now_ms);
        let (Some(scope), Some(snapshot)) = (viewport.scope(), viewport.live()) else {
            self.frames.clear();
            return;
        };
        if !snapshot.history.is_complete() {
            self.retire();
            return;
        }
        if !proof.valid() || !matches_scope(&proof, scope) {
            self.unavailable();
            return;
        }
        if self.frames.back().is_some_and(|f| &f.scope != scope) {
            self.retire();
        }
        if !self.frames.iter().any(|f| f.proof == proof) {
            let history = bounded_history(snapshot, &mut self.sizes);
            let bytes = history.iter().map(|r| self.sizes.row(r)).sum();
            self.frames.push_back(Frame {
                proof,
                scope: scope.clone(),
                cols: snapshot.cols,
                rows: snapshot.rows,
                alternate: snapshot.modes.alternate_screen,
                start: snapshot
                    .history
                    .materialized()
                    .map_or(0, |rows| rows.len())
                    .saturating_sub(history.len()),
                history,
                bytes,
            });
            while self.frames.len() > 4
                || self.frames.iter().map(|f| f.bytes).sum::<usize>() > 4 * 1024 * 1024
            {
                self.frames.pop_front();
            }
            self.sizes.prune();
        }
        self.apply(viewport);
    }
    pub fn capture(&mut self, proof: Proof, viewport: &Viewport) -> Option<AnchorAction> {
        self.cancel();
        self.token = None;
        let Some(index) = viewport.capture_index() else {
            self.state = HistoryState::Live;
            return None;
        };
        self.state = HistoryState::Historical;
        self.action(
            proof,
            viewport,
            AnchorOperation::Capture {
                history_index: index,
            },
            None,
        )
    }
    pub fn restore(
        &mut self,
        proof: Proof,
        viewport: &Viewport,
        token: String,
        now_ms: u64,
    ) -> Option<AnchorAction> {
        self.cancel();
        if !uuid(&token) {
            self.unavailable();
            return None;
        }
        self.token = Some(token.clone());
        self.state = HistoryState::Restoring;
        self.action(
            proof,
            viewport,
            AnchorOperation::Resolve { token },
            Some(now_ms.saturating_add(3000)),
        )
    }
    fn action(
        &mut self,
        proof: Proof,
        viewport: &Viewport,
        operation: AnchorOperation,
        deadline_ms: Option<u64>,
    ) -> Option<AnchorAction> {
        let Some(scope) = viewport.scope() else {
            self.unavailable();
            return None;
        };
        if !proof.valid() || !matches_scope(&proof, scope) || self.serial == u64::MAX {
            self.unavailable();
            return None;
        }
        let ticket = Ticket {
            serial: self.serial,
            scope: scope.clone(),
        };
        self.pending = Some(Pending {
            ticket: ticket.clone(),
            resolve: matches!(operation, AnchorOperation::Resolve { .. }),
            deadline_ms,
        });
        Some(AnchorAction {
            ticket,
            proof,
            operation,
        })
    }
    pub fn tick(&mut self, now_ms: u64) {
        if self
            .pending
            .as_ref()
            .and_then(|p| p.deadline_ms)
            .is_some_and(|deadline| now_ms >= deadline)
        {
            self.finish(HistoryState::Unavailable);
        }
    }
    /// `None` means unsupported endpoint. Transport errors should call `failed` instead.
    pub fn complete(
        &mut self,
        ticket: &Ticket,
        result: Option<AnchorResult>,
        viewport: &mut Viewport,
        now_ms: u64,
    ) -> bool {
        self.tick(now_ms);
        let Some(pending) = &self.pending else {
            return false;
        };
        if &pending.ticket != ticket
            || viewport.scope() != Some(&ticket.scope)
            || self.resolved.is_some()
        {
            return false;
        }
        let resolve = pending.resolve;
        match result {
            None => self.finish(HistoryState::Unsupported),
            Some(AnchorResult::Captured { token }) if !resolve && uuid(&token) => {
                self.token = Some(token);
                self.finish(HistoryState::Historical);
            }
            Some(AnchorResult::Resolved {
                proof,
                history_index,
            }) if resolve && proof.valid() && matches_scope(&proof, &ticket.scope) => {
                self.resolved = Some((proof, history_index));
                self.apply(viewport);
            }
            Some(AnchorResult::Lost) => self.finish(HistoryState::Lost),
            _ => self.finish(HistoryState::Unavailable),
        }
        true
    }
    pub fn failed(&mut self, ticket: &Ticket) {
        if self.pending.as_ref().is_some_and(|p| &p.ticket == ticket) {
            self.finish(HistoryState::Unavailable);
        }
    }
    fn apply(&mut self, viewport: &mut Viewport) {
        let Some((proof, index)) = &self.resolved else {
            return;
        };
        let Some(frame) = self.frames.iter().find(|f| &f.proof == proof) else {
            return;
        };
        let Some(current) = viewport.live() else {
            self.finish(HistoryState::Lost);
            return;
        };
        let valid = viewport.scope() == Some(&frame.scope)
            && current.cols == frame.cols
            && current.rows == frame.rows
            && current.modes.alternate_screen == frame.alternate;
        let row = index
            .checked_sub(frame.start)
            .and_then(|i| frame.history.get(i))
            .cloned();
        self.finish(
            if valid && row.is_some_and(|row| viewport.restore_row(&row)) {
                HistoryState::Historical
            } else {
                HistoryState::Lost
            },
        );
    }
}
fn matches_scope(proof: &Proof, scope: &Scope) -> bool {
    proof.workspace_name == scope.workspace_name
        && proof.semantic_pane_id == scope.pane
        && proof.generation == scope.generation
        && proof.incarnation == scope.incarnation
}
