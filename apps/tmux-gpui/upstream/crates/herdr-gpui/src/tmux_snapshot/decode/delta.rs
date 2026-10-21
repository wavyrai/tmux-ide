//! Worker-owned baseline. Prepared frames cannot change the baseline until outer validation commits.
use super::{
    compact::{self, WireRow},
    *,
};

const MAX_SEQUENCE: u64 = 9_007_199_254_740_991;
#[derive(Deserialize)]
enum Kind {
    #[serde(rename = "rle-v1")]
    Full,
    #[serde(rename = "rle-delta-v1")]
    Delta,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Envelope {
    encoding: Kind,
    epoch: String,
    seq: u64,
    #[serde(default, deserialize_with = "present")]
    base_seq: Option<u64>,
    cols: u16,
    rows: u16,
    #[serde(default, deserialize_with = "present")]
    grid: Option<Vec<WireRow>>,
    #[serde(default, deserialize_with = "present")]
    changed_rows: Option<Vec<(usize, WireRow)>>,
    history: Vec<WireRow>,
    cursor: Cursor,
    modes: Modes,
    placements: Vec<serde_json::Value>,
    bootstrap: Bootstrap,
}
fn present<'de, D: serde::Deserializer<'de>, T: Deserialize<'de>>(
    d: D,
) -> Result<Option<T>, D::Error> {
    T::deserialize(d).map(Some)
}
#[derive(Clone)]
struct Baseline {
    epoch: String,
    seq: u64,
    cols: u16,
    rows: u16,
    alternate: bool,
    grid: Vec<WireRow>,
}
#[derive(Default)]
pub(in crate::tmux_snapshot) struct Store {
    baseline: Option<Baseline>,
}
pub(in crate::tmux_snapshot) struct Prepared {
    pub frame: std::sync::Arc<FrameData>,
    pub modes: Option<PointerModes>,
    baseline: Baseline,
}
pub(in crate::tmux_snapshot) enum Outcome {
    Ready(Prepared),
    Resync {
        epoch: String,
        base_seq: u64,
        frame: FrameData,
    },
}
impl Store {
    pub fn reset(&mut self) {
        self.baseline = None;
    }
    pub fn commit(&mut self, prepared: Prepared) {
        self.baseline = Some(prepared.baseline);
    }
    pub fn prepare(&self, bytes: &[u8]) -> Result<Outcome, Error> {
        self.prepare_envelope(serde_json::from_slice(bytes)?)
    }
    pub fn prepare_binary(&self, cells: &binary::cells::CellFrame) -> Result<Outcome, Error> {
        let mut metadata = cells.metadata.clone();
        metadata["history"] = serde_json::Value::Array(Vec::new());
        metadata[if cells.full { "grid" } else { "changedRows" }] =
            serde_json::Value::Array(Vec::new());
        let mut envelope: Envelope = serde_json::from_value(metadata)?;
        if cells.full {
            envelope.grid = Some(
                cells
                    .changed_rows
                    .iter()
                    .map(|(_, row)| row.clone())
                    .collect(),
            );
        } else {
            envelope.changed_rows = Some(cells.changed_rows.clone());
        }
        envelope.history = cells.history.clone();
        self.prepare_envelope(envelope)
    }
    fn prepare_envelope(&self, e: Envelope) -> Result<Outcome, Error> {
        if e.epoch.is_empty()
            || e.epoch.len() > 128
            || !e.epoch.bytes().all(|b| (0x21..=0x7e).contains(&b))
            || e.seq == 0
            || e.seq > MAX_SEQUENCE
            || e.cols == 0
            || e.rows == 0
        {
            return Err(Error::Invalid("invalid compact frame identity"));
        }
        if e.history
            .len()
            .checked_add(usize::from(e.rows))
            .and_then(|rows| rows.checked_mul(usize::from(e.cols)))
            .is_none_or(|cells| cells > 262_144)
        {
            return Err(Error::Invalid("compact cell budget exceeded"));
        }
        let recovery_base = self
            .baseline
            .as_ref()
            .filter(|b| b.epoch == e.epoch)
            .map_or(0, |b| b.seq);
        let mut missing_base = false;
        let stale_full = matches!(e.encoding, Kind::Full)
            && self
                .baseline
                .as_ref()
                .is_some_and(|b| b.epoch == e.epoch && e.seq <= b.seq);
        let grid = match e.encoding {
            Kind::Full => {
                if e.base_seq.is_some() || e.changed_rows.is_some() {
                    return Err(Error::Invalid("invalid compact full envelope"));
                }
                let grid = e.grid.ok_or(Error::Invalid("missing compact full grid"))?;
                grid
            }
            Kind::Delta => {
                let base_seq = e
                    .base_seq
                    .ok_or(Error::Invalid("missing compact base sequence"))?;
                if base_seq == 0
                    || base_seq >= MAX_SEQUENCE
                    || e.seq != base_seq + 1
                    || e.grid.is_some()
                {
                    return Err(Error::Invalid("invalid compact delta sequence"));
                }
                let changed = e
                    .changed_rows
                    .ok_or(Error::Invalid("missing compact changed rows"))?;
                let mut previous = None;
                for (index, _) in &changed {
                    if *index >= usize::from(e.rows) || previous.is_some_and(|p| *index <= p) {
                        return Err(Error::Invalid("compact changed rows not sorted and unique"));
                    }
                    previous = Some(*index);
                }
                let matching = self.baseline.as_ref().filter(|base| {
                    base.epoch == e.epoch
                        && base.seq == base_seq
                        && base.cols == e.cols
                        && base.rows == e.rows
                });
                let mut grid = if let Some(base) = matching {
                    if base.alternate != e.modes.alternate_screen {
                        return Err(Error::Invalid("compact delta changed screen basis"));
                    }
                    base.grid.clone()
                } else {
                    // Validate all payload-intrinsic data even without the missing rows.
                    // Empty graphemes add no synthetic bytes to the expansion budget.
                    missing_base = true;
                    vec![compact::empty_row(e.cols); usize::from(e.rows)]
                };
                for (index, row) in changed {
                    grid[index] = row;
                }
                grid
            }
        };
        let baseline = Baseline {
            epoch: e.epoch,
            seq: e.seq,
            cols: e.cols,
            rows: e.rows,
            alternate: e.modes.alternate_screen,
            grid: grid.clone(),
        };
        let snapshot = compact::expand_snapshot(Snapshot {
            encoding: Encoding::RleV1,
            cols: e.cols,
            rows: e.rows,
            grid,
            history: e.history,
            cursor: e.cursor,
            modes: e.modes,
            placements: e.placements,
            bootstrap: e.bootstrap,
            _kitty_graphics: None,
        })?;
        let (frame, modes) = convert(snapshot)?;
        if stale_full || missing_base {
            return Ok(Outcome::Resync {
                epoch: baseline.epoch,
                base_seq: recovery_base,
                frame,
            });
        }
        Ok(Outcome::Ready(Prepared {
            frame: std::sync::Arc::new(frame),
            modes,
            baseline,
        }))
    }
}

#[cfg(test)]
mod tests;
