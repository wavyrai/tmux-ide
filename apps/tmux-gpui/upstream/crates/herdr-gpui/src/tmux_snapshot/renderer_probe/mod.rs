//! Fixture-only input-admission → completed renderer work, never display/vsync timing.
//!
//! Parent integration must explicitly enable this only for the isolated prepared fixture.
//! Capture `Arm::admitted_at_micros` at the original GUI action admission edge, before
//! transport/scheduler waiting. Supply the entire visible viewport for the negative control.
//! Call `after_paint` only after the renderer submitted the matching visible row, using
//! that paint's scope and written-row list (not latest model state or queued work).
//! `tick` and `cancel` preserve failures. Send drained receipts with `LogSink::try_submit`;
//! never join the logging worker on the UI thread. A logger error invalidates the run.
mod ledger;
mod logging;
pub(crate) use ledger::*;
pub(crate) use logging::*;

pub(crate) mod runtime;
