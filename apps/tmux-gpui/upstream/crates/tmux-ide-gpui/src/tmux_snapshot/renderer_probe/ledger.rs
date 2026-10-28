use std::collections::BTreeSet;
pub(crate) const ENDPOINT: &str = "input-admission-to-renderer-work-complete";
pub(crate) const MAX_TRIALS: usize = 64;
pub(crate) const TIMEOUT_MICROS: u64 = 5_000_000;
const MAX_SAFE_INTEGER: u64 = (1_u64 << 53) - 1;

/// Construction itself is the explicit fixture opt-in; no ambient environment lookup.
#[derive(Clone, Copy, Debug)]
pub(crate) struct FixtureOptIn(());
impl FixtureOptIn {
    pub fn enabled(enabled: bool) -> Option<Self> {
        enabled.then_some(Self(()))
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Scope {
    pub pane: String,
    pub generation: String,
    pub incarnation: String,
    pub request: u64,
    pub cols: u16,
    pub rows: u16,
    pub viewport_offset: u64,
}
impl Scope {
    pub(super) fn valid(&self) -> bool {
        [&self.pane, &self.generation, &self.incarnation]
            .iter()
            .all(|s| !s.is_empty() && s.len() <= 512)
            && self.request <= MAX_SAFE_INTEGER
            && self.viewport_offset <= MAX_SAFE_INTEGER
            && (1..=1000).contains(&self.cols)
            && (1..=1000).contains(&self.rows)
    }
    fn same_except_offset(&self, other: &Self) -> bool {
        self.pane == other.pane
            && self.generation == other.generation
            && self.incarnation == other.incarnation
            && self.request == other.request
            && self.cols == other.cols
            && self.rows == other.rows
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Kind {
    Input,
    Scroll,
    Output,
}
#[derive(Clone, Debug)]
pub(crate) struct Arm {
    pub id: String,
    pub nonce: String,
    pub kind: Kind,
    pub source: Scope,
    pub expected: Scope,
    /// Scroll fixture's output row number, distinct from viewport witness row.
    pub marker_row: Option<u16>,
    pub admitted_at_micros: u64,
}
pub(crate) struct BeforeInput<'a> {
    pub scope: &'a Scope,
    /// Exactly one string for every visible row, from the actual pre-input view.
    pub visible_rows: &'a [&'a str],
}
pub(crate) struct PaintWitness<'a> {
    pub scope: &'a Scope,
    pub after_paint_at_micros: u64,
    pub paint_sequence: u64,
    pub text: &'a str,
    pub row: u16,
    pub column: u16,
    pub submitted_rows: &'a [u16],
    pub clipped: bool,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Failure {
    ClockInvalid,
    Timeout,
    ScopeChanged,
    MarkerAlreadyPresent,
    NegativeControlIncomplete,
    InvalidWitness,
    InputRejected,
    TransportFailed,
    FixtureStopped,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Outcome {
    Completed,
    Failed(Failure),
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct WitnessIdentity {
    pub scope: Scope,
    pub paint_sequence: u64,
    pub row: u16,
    pub column: u16,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Receipt {
    pub id: String,
    pub nonce: String,
    pub kind: Kind,
    pub marker: String,
    pub source: Scope,
    pub expected: Scope,
    pub witness: Option<WitnessIdentity>,
    pub admitted_at_micros: u64,
    pub at_micros: u64,
    pub duration_micros: Option<u64>,
    pub outcome: Outcome,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ArmError {
    Busy,
    Exhausted,
    DuplicateNonce,
    InvalidTrial,
    InvalidScope,
}
struct Pending {
    arm: Arm,
    marker: String,
}
pub(crate) struct Ledger {
    pending: Option<Pending>,
    seen: BTreeSet<String>,
    receipts: Vec<Receipt>,
}
impl Ledger {
    pub fn new(_fixture: FixtureOptIn) -> Self {
        Self {
            pending: None,
            seen: BTreeSet::new(),
            receipts: Vec::new(),
        }
    }
    pub fn pending(&self) -> bool {
        self.pending.is_some()
    }
    pub fn arm(&mut self, arm: Arm, before: BeforeInput<'_>) -> Result<(), ArmError> {
        if self.pending.is_some() {
            return Err(ArmError::Busy);
        }
        if self.seen.len() >= MAX_TRIALS {
            return Err(ArmError::Exhausted);
        }
        if self.seen.contains(&arm.nonce) {
            return Err(ArmError::DuplicateNonce);
        }
        if arm.id.is_empty()
            || arm.id.len() > 128
            || !valid_nonce(&arm.nonce)
            || arm.admitted_at_micros > MAX_SAFE_INTEGER
            || arm.marker_row.is_some_and(|row| row > 9999)
        {
            return Err(ArmError::InvalidTrial);
        }
        if !arm.source.valid()
            || !arm.expected.valid()
            || !arm.source.same_except_offset(&arm.expected)
            || (arm.kind != Kind::Scroll && arm.source != arm.expected)
        {
            return Err(ArmError::InvalidScope);
        }
        let marker = output_marker(&arm.nonce, arm.marker_row);
        let at = arm.admitted_at_micros;
        self.seen.insert(arm.nonce.clone());
        let negative_complete = before.scope == &arm.source
            && before.visible_rows.len() == usize::from(arm.source.rows)
            && before.visible_rows.iter().all(|row| row.len() <= 64 * 1024)
            && before
                .visible_rows
                .iter()
                .map(|row| row.len())
                .sum::<usize>()
                <= 1024 * 1024;
        self.pending = Some(Pending { arm, marker });
        if !negative_complete {
            self.cancel(Failure::NegativeControlIncomplete, at);
        } else if before.visible_rows.iter().any(|row| {
            self.pending
                .as_ref()
                .is_some_and(|p| row.contains(&p.marker))
        }) {
            self.cancel(Failure::MarkerAlreadyPresent, at);
        }
        Ok(())
    }
    /// Only call from the post-paint edge for rows actually submitted in this paint.
    pub fn after_paint(&mut self, witness: PaintWitness<'_>) -> bool {
        let Some(pending) = self.pending.as_ref() else {
            return false;
        };
        let at = witness.after_paint_at_micros;
        if !witness.scope.valid()
            || witness.paint_sequence > MAX_SAFE_INTEGER
            || witness.submitted_rows.len() > 1000
        {
            self.fail(Failure::InvalidWitness, at, None);
            return false;
        }
        if at > MAX_SAFE_INTEGER || at < pending.arm.admitted_at_micros {
            self.fail(Failure::ClockInvalid, at, Some(&witness));
            return false;
        }
        if at - pending.arm.admitted_at_micros > TIMEOUT_MICROS {
            self.fail(Failure::Timeout, at, Some(&witness));
            return false;
        }
        if witness.scope != &pending.arm.expected {
            if pending.arm.kind == Kind::Scroll && witness.scope == &pending.arm.source {
                return false;
            }
            self.fail(Failure::ScopeChanged, at, Some(&witness));
            return false;
        }
        if witness.clipped
            || witness.row >= witness.scope.rows
            || usize::from(witness.column) + pending.marker.len() > usize::from(witness.scope.cols)
            || !witness.submitted_rows.contains(&witness.row)
            || witness.text != pending.marker
        {
            return false;
        }
        self.finish(Outcome::Completed, at, Some(&witness));
        true
    }
    pub fn tick(&mut self, at: u64) {
        let Some(pending) = self.pending.as_ref() else {
            return;
        };
        if at > MAX_SAFE_INTEGER || at < pending.arm.admitted_at_micros {
            self.cancel(Failure::ClockInvalid, at);
        } else if at - pending.arm.admitted_at_micros > TIMEOUT_MICROS {
            self.cancel(Failure::Timeout, at);
        }
    }
    pub fn cancel(&mut self, reason: Failure, at: u64) {
        self.fail(reason, at, None);
    }
    fn fail(&mut self, reason: Failure, at: u64, witness: Option<&PaintWitness<'_>>) {
        self.finish(Outcome::Failed(reason), at, witness);
    }
    fn finish(&mut self, outcome: Outcome, at: u64, witness: Option<&PaintWitness<'_>>) {
        let Some(Pending { arm, marker }) = self.pending.take() else {
            return;
        };
        self.receipts.push(Receipt {
            id: arm.id,
            nonce: arm.nonce,
            kind: arm.kind,
            marker,
            source: arm.source,
            expected: arm.expected,
            witness: witness.map(|w| WitnessIdentity {
                scope: w.scope.clone(),
                paint_sequence: w.paint_sequence,
                row: w.row,
                column: w.column,
            }),
            admitted_at_micros: arm.admitted_at_micros,
            at_micros: at,
            duration_micros: if outcome == Outcome::Completed {
                at.checked_sub(arm.admitted_at_micros)
            } else {
                None
            },
            outcome,
        });
    }
    pub fn drain(&mut self) -> Vec<Receipt> {
        std::mem::take(&mut self.receipts)
    }
}
fn valid_nonce(nonce: &str) -> bool {
    nonce.len() == 32
        && nonce
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn output_marker(nonce: &str, row: Option<u16>) -> String {
    match row {
        Some(row) => format!("PROBE-ROW:{nonce}:{row:04}"),
        None => format!("PROBE-OUTPUT:{nonce}"),
    }
}
#[cfg(test)]
#[path = "tests.rs"]
mod tests;
