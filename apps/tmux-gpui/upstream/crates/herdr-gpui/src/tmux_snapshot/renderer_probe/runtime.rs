//! Explicit isolated fixture adapter. One prepared fixture window per process.
use super::*;
use crate::tmux_snapshot::{browser, display_frame::DisplayFrame, keys::Input};
use std::{cell::RefCell, collections::VecDeque, time::Instant};
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Trial {
    id: String,
    nonce: String,
    #[serde(default)]
    kind: Option<String>,
}
struct Scroll {
    trial: Trial,
    source: Scope,
    rows: Vec<String>,
    at: u64,
}
struct Runtime {
    ledger: Ledger,
    log: LogSink,
    trials: VecDeque<Trial>,
    started: Instant,
    scroll: Option<Scroll>,
    sequence: u64,
}
thread_local! { static RUNTIME: RefCell<Option<Runtime>> = RefCell::new(Runtime::load()); }
static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
pub(crate) fn enabled() -> bool {
    *std::sync::OnceLock::get_or_init(&ENABLED, || {
        std::env::var_os("TMUX_IDE_RENDERER_FIXTURE").is_some_and(|s| s == "1")
    })
}
impl Runtime {
    fn load() -> Option<Self> {
        let opt = FixtureOptIn::enabled(enabled())?;
        let raw = std::env::var("TMUX_IDE_RENDERER_PROBE_TRIALS").ok()?;
        if raw.len() > 16384 {
            return None;
        }
        let trials: Vec<Trial> = serde_json::from_str(&raw).ok()?;
        let mut seen = std::collections::BTreeSet::new();
        if trials.is_empty()
            || trials.len() > MAX_TRIALS
            || trials.iter().any(|t| {
                t.id.is_empty()
                    || t.id.len() > 128
                    || t.nonce.len() != 32
                    || !t
                        .nonce
                        .bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                    || !seen.insert(t.nonce.clone())
                    || t.kind
                        .as_deref()
                        .is_some_and(|k| k != "input" && k != "scroll" && k != "output")
            })
        {
            return None;
        }
        let path = std::path::PathBuf::from(std::env::var_os("TMUX_IDE_RENDERER_PROBE_LOG")?);
        if !path.is_absolute() {
            return None;
        }
        let (log, _worker) = LogSink::spawn(opt, path).ok()?;
        Some(Self {
            ledger: Ledger::new(opt),
            log,
            trials: trials.into(),
            started: Instant::now(),
            scroll: None,
            sequence: 0,
        })
    }
    fn now(&self) -> u64 {
        self.started.elapsed().as_micros().min(u128::from(u64::MAX)) as u64
    }
    fn flush(&mut self) {
        for receipt in self.ledger.drain() {
            let _ = self.log.try_submit(receipt);
        }
    }
}
fn rows(frame: &DisplayFrame, region: &crate::tmux_snapshot::copy::Region) -> Vec<String> {
    let f = frame.view();
    let mut result = Vec::new();
    let mut total = 0_usize;
    for y in usize::from(region.top)..usize::from(region.top) + usize::from(region.height) {
        let mut row = String::new();
        for cell in f
            .row(y)
            .unwrap_or_default()
            .iter()
            .skip(usize::from(region.left))
            .take(usize::from(region.width))
        {
            if row.len().saturating_add(cell.symbol.len()) > 64 * 1024
                || total.saturating_add(cell.symbol.len()) > 1024 * 1024
            {
                return Vec::new();
            }
            total += cell.symbol.len();
            row.push_str(&cell.symbol);
        }
        result.push(row);
    }
    result
}
fn scope(state: &browser::State) -> Option<Scope> {
    if state.retained_preview || state.regions.len() != 1 {
        return None;
    }
    let scope = state.renderer_probe_scope.as_ref()?;
    let region = state.copy_region.as_ref()?;
    let frame = state.frame.as_ref()?;
    (scope.valid()
        && state.selected_pane.as_deref() == Some(scope.pane.as_str())
        && state.request == scope.request
        && region.valid_view(frame.view(), Some(&scope.pane))
        && region.width == scope.cols
        && region.height == scope.rows)
        .then(|| scope.clone())
}
pub(crate) fn admit(input: Input, state: &browser::State) -> Input {
    RUNTIME.with_borrow_mut(|runtime| {
        let Some(r) = runtime else {
            return input;
        };
        let admitted_at = r.now();
        if r.ledger.pending() || r.scroll.is_some() {
            return input;
        }
        let (Some(s), Some(frame), Some(t), Some(region)) = (
            scope(state),
            state.frame.as_ref(),
            r.trials.front(),
            state.copy_region.as_ref(),
        ) else {
            return input;
        };
        if matches!(&input,Input::Text(s) if s=="!") {
            if t.kind.as_deref() == Some("scroll") {
                return Input::Text(format!("PROBE-PREPARE-SCROLL:{}\n", t.nonce));
            }
            let Some(t) = r.trials.pop_front() else {
                return input;
            };
            let visible = rows(frame, region);
            let refs: Vec<_> = visible.iter().map(String::as_str).collect();
            let output = t.kind.as_deref() == Some("output");
            let arm = Arm {
                id: t.id,
                nonce: t.nonce.clone(),
                kind: if output { Kind::Output } else { Kind::Input },
                source: s.clone(),
                expected: s.clone(),
                marker_row: None,
                admitted_at_micros: admitted_at,
            };
            if r.ledger
                .arm(
                    arm,
                    BeforeInput {
                        scope: &s,
                        visible_rows: &refs,
                    },
                )
                .is_ok()
                && r.ledger.pending()
            {
                let command = if output { "PROBE-BURST" } else { "PROBE-IN" };
                return Input::Text(format!("{command}:{}\n", t.nonce));
            }
            r.flush();
            return Input::Text(String::new());
        }
        if t.kind.as_deref() == Some("scroll")
            && s.viewport_offset == 0
            && matches!(input, Input::Scroll(_) | Input::Wheel { .. })
        {
            let visible = rows(frame, region);
            let prefix = format!("PROBE-ROW:{}:", t.nonce);
            let prepared = visible.iter().any(|row| {
                row.trim_end().strip_prefix(&prefix).is_some_and(|number| {
                    number.len() == 4 && number.bytes().all(|b| b.is_ascii_digit())
                })
            });
            // Returning to live and scrolling unprepared/older output are setup,
            // not admission of the next nonce's timed trial.
            if prepared && let Some(trial) = r.trials.pop_front() {
                r.scroll = Some(Scroll {
                    trial,
                    source: s,
                    rows: visible,
                    at: admitted_at,
                });
            }
        }
        input
    })
}
pub(crate) fn tick() {
    RUNTIME.with_borrow_mut(|r| {
        if let Some(r) = r {
            let now = r.now();
            r.ledger.tick(now);
            if r.scroll
                .as_ref()
                .is_some_and(|s| now.saturating_sub(s.at) > TIMEOUT_MICROS)
            {
                let s = r.scroll.take();
                if let Some(s) = s {
                    r.fail_scroll(s);
                }
            }
            r.flush();
            let status = r.log.status();
            if status.failure.is_some() || status.dropped > 0 {
                r.ledger.cancel(Failure::TransportFailed, now);
                r.trials.clear();
            }
        }
    });
}
impl Runtime {
    fn fail_scroll(&mut self, s: Scroll) {
        let refs: Vec<_> = s.rows.iter().map(String::as_str).collect();
        let _ = self.ledger.arm(
            Arm {
                id: s.trial.id,
                nonce: s.trial.nonce,
                kind: Kind::Scroll,
                source: s.source.clone(),
                expected: s.source.clone(),
                marker_row: Some(0),
                admitted_at_micros: s.at,
            },
            BeforeInput {
                scope: &s.source,
                visible_rows: &refs,
            },
        );
        self.ledger.cancel(Failure::Timeout, self.now());
    }
}
pub(crate) fn after_paint(
    state: &browser::State,
    frame: &DisplayFrame,
    visible_cols: u16,
    visible_rows: u16,
    ok: bool,
) {
    RUNTIME.with_borrow_mut(|runtime| {
        let Some(r) = runtime else {
            return;
        };
        // Timestamp the paint edge before any fixture-only row scanning or allocation.
        let completed_at = r.now();
        let Some(s) = scope(state) else {
            r.ledger.cancel(Failure::ScopeChanged, completed_at);
            r.flush();
            return;
        };
        let Some(region) = state.copy_region.as_ref() else {
            return;
        };
        let visible_cols = visible_cols.saturating_sub(region.left).min(region.width);
        let visible_rows = visible_rows.saturating_sub(region.top).min(region.height);
        if !state.frame.as_ref().is_some_and(|f| f.same(frame)) {
            return;
        }
        if !r.ledger.pending() && r.scroll.is_none() {
            return;
        }
        let text = rows(frame, region);
        if let Some(waiting) = r.scroll.as_ref()
            && waiting.source.viewport_offset != s.viewport_offset
        {
            let prefix = format!("PROBE-ROW:{}:", waiting.trial.nonce);
            let marker = text.first().map(|s| s.trim_end()).unwrap_or_default();
            let row = marker
                .strip_prefix(&prefix)
                .filter(|n| n.len() == 4)
                .and_then(|n| n.parse::<u16>().ok());
            if let Some(row) = row
                && let Some(waiting) = r.scroll.take()
            {
                let refs: Vec<_> = waiting.rows.iter().map(String::as_str).collect();
                let _ = r.ledger.arm(
                    Arm {
                        id: waiting.trial.id,
                        nonce: waiting.trial.nonce,
                        kind: Kind::Scroll,
                        source: waiting.source.clone(),
                        expected: s.clone(),
                        marker_row: Some(row),
                        admitted_at_micros: waiting.at,
                    },
                    BeforeInput {
                        scope: &waiting.source,
                        visible_rows: &refs,
                    },
                );
            }
        }
        if !r.ledger.pending() {
            r.flush();
            return;
        }
        r.sequence = r.sequence.saturating_add(1);
        let submitted: Vec<u16> = if ok {
            (0..visible_rows.min(s.rows)).collect()
        } else {
            Vec::new()
        };
        for (y, text) in text.iter().enumerate() {
            let marker = text.trim_end();
            if marker.starts_with("PROBE-OUTPUT:") || marker.starts_with("PROBE-ROW:") {
                let ascii = frame
                    .view()
                    .row(y + usize::from(region.top))
                    .is_some_and(|cells| {
                        cells
                            .iter()
                            .skip(usize::from(region.left))
                            .take(marker.len())
                            .all(|c| !c.skip && c.symbol.len() == 1 && c.symbol.is_ascii())
                    });
                r.ledger.after_paint(PaintWitness {
                    scope: &s,
                    after_paint_at_micros: completed_at,
                    paint_sequence: r.sequence,
                    text: marker,
                    row: y as u16,
                    column: 0,
                    submitted_rows: &submitted,
                    clipped: !ascii || marker.len() > usize::from(visible_cols),
                });
            }
        }
        r.flush();
    });
}

pub(crate) fn rejected() {
    RUNTIME.with_borrow_mut(|r| {
        if let Some(r) = r {
            r.ledger.cancel(Failure::InputRejected, r.now());
            r.flush();
        }
    });
}
impl Drop for Runtime {
    fn drop(&mut self) {
        self.ledger.cancel(Failure::FixtureStopped, self.now());
        self.flush();
    }
}
#[cfg(test)]
#[path = "runtime_tests.rs"]
mod tests;
