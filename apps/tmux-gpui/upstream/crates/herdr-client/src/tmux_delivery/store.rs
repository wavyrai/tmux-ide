use super::{Error, Result, hash_snapshot, hash_tombstone, types::*};
use std::{collections::HashSet, sync::Arc};
#[derive(Debug, Default)]
pub struct Store {
    snapshot: Option<Arc<Snapshot>>,
    revision: Option<u64>,
    hash: Option<String>,
}
#[derive(Debug)]
pub struct ApplyResult {
    pub revision: u64,
    pub hash: String,
    pub changed_rows: Vec<usize>,
    pub tombstone: bool,
}
impl Store {
    pub fn snapshot(&self) -> Option<&Arc<Snapshot>> {
        self.snapshot.as_ref()
    }
    pub fn revision(&self) -> Option<u64> {
        self.revision
    }
    pub fn hash(&self) -> Option<&str> {
        self.hash.as_deref()
    }
    /// Stage and verify before publishing any state. Rejected updates retain Arc identity.
    pub fn apply(&mut self, update: Update, expected_hash: &str) -> Result<ApplyResult> {
        let revision = update.revision();
        if self.revision.is_some_and(|r| revision <= r)
            || update
                .base_revision()
                .is_some_and(|b| self.revision != Some(b))
        {
            return Err(Error::Revision);
        }
        let (snapshot, changed_rows, hash) = match update {
            Update::Seed { snapshot, .. } => {
                if !snapshot.history.is_complete() {
                    return Err(Error::Invalid("canonical history unavailable"));
                }
                validate(&snapshot)?;
                let changed = (0..snapshot.rows).collect();
                let hash = hash_snapshot(&snapshot);
                (Some(Arc::new(snapshot)), changed, hash)
            }
            Update::Patch { patch, .. } => {
                let prior = self.snapshot.as_ref().ok_or(Error::Revision)?;
                let next = apply_patch(prior, patch)?;
                let changed = next
                    .grid
                    .iter()
                    .enumerate()
                    .filter_map(|(i, r)| {
                        (!prior.grid.get(i).is_some_and(|old| Arc::ptr_eq(old, r))).then_some(i)
                    })
                    .collect();
                let hash = hash_snapshot(&next);
                (Some(Arc::new(next)), changed, hash)
            }
            Update::Tombstone { reason, .. } => {
                if self.snapshot.is_none() {
                    return Err(Error::Revision);
                }
                if !["pane-closed", "session-restarted", "runtime-disposed"]
                    .contains(&reason.as_str())
                {
                    return Err(Error::Invalid("tombstone"));
                }
                (None, Vec::new(), hash_tombstone(&reason))
            }
        };
        if hash != expected_hash {
            return Err(Error::Hash);
        }
        let tombstone = snapshot.is_none();
        self.snapshot = snapshot;
        self.revision = Some(revision);
        self.hash = Some(hash.clone());
        Ok(ApplyResult {
            revision,
            hash,
            changed_rows,
            tombstone,
        })
    }
}
pub(super) fn validate(s: &Snapshot) -> Result<()> {
    if s.cols == 0
        || s.rows == 0
        || s.cols > 4096
        || s.rows > 4096
        || s.grid.len() != s.rows
        || match &s.history {
            History::Complete(rows) => {
                rows.len() > 10000 || (s.grid.len() + rows.len()).saturating_mul(s.cols) > 1_000_000
            }
            History::Deferred(h) => {
                !s.modes.alternate_screen
                    || h.rows > 10000
                    || h.digest.len() != 16
                    || !h
                        .digest
                        .bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                    || s.grid.len().saturating_mul(s.cols) > 1_000_000
            }
        }
    {
        return Err(Error::Invalid("snapshot bounds"));
    }
    if s.grid.iter().any(|r| r.cells().len() != s.cols)
        || s.history
            .materialized()
            .is_some_and(|rows| rows.iter().any(|r| r.cells().len() != s.cols))
    {
        return Err(Error::Invalid("snapshot row width"));
    }
    if s.cursor.x >= s.cols || s.cursor.y >= s.rows {
        return Err(Error::Invalid("cursor bounds"));
    }
    if s.placements.len() > 4096
        || s.placements.iter().any(|p| {
            p.rows == 0
                || p.columns == 0
                || p.row.checked_add(p.rows).is_none_or(|n| n > s.rows)
                || p.column.checked_add(p.columns).is_none_or(|n| n > s.cols)
        })
    {
        return Err(Error::Invalid("placement bounds"));
    }
    Ok(())
}
fn apply_patch(prior: &Snapshot, p: Patch) -> Result<Snapshot> {
    if !prior.history.is_complete() {
        return Err(Error::Invalid("canonical history unavailable"));
    }
    apply_patch_inner(prior, p, None)
}
pub(super) fn apply_projection_patch(
    prior: &Snapshot,
    p: Patch,
    history: DeferredHistory,
) -> Result<Snapshot> {
    if !matches!(prior.history, History::Deferred(_))
        || p.history.is_some()
        || p.history_delta.is_some()
    {
        return Err(Error::Invalid("projection history"));
    }
    apply_patch_inner(prior, p, Some(history))
}
fn apply_patch_inner(
    prior: &Snapshot,
    p: Patch,
    deferred: Option<DeferredHistory>,
) -> Result<Snapshot> {
    if p.history.is_some() && p.history_delta.is_some() {
        return Err(Error::Invalid("conflicting history"));
    }
    let (cols, rows) = p.dimensions.unwrap_or((prior.cols, prior.rows));
    if cols == 0 || rows == 0 || cols > 4096 || rows > 4096 {
        return Err(Error::Invalid("dimension bounds"));
    }
    let mut grid = if cols == prior.cols && rows == prior.rows {
        prior.grid.clone()
    } else {
        let blank = Arc::new(Row::new(
            vec![
                Cell {
                    grapheme: Arc::from(" "),
                    width: 1,
                    foreground: Color::Default,
                    background: Color::Default,
                    attributes: 0
                };
                cols
            ],
            false,
        ));
        (0..rows)
            .map(|i| {
                prior
                    .grid
                    .get(i)
                    .filter(|r| r.cells().len() == cols)
                    .cloned()
                    .unwrap_or_else(|| blank.clone())
            })
            .collect()
    };
    let mut seen = HashSet::new();
    for (i, row) in p.rows {
        if i >= rows || !seen.insert(i) || row.cells().len() != cols {
            return Err(Error::Invalid("dirty row"));
        }
        grid[i] = row;
    }
    let history = if let Some(h) = deferred {
        History::Deferred(h)
    } else if let Some(h) = p.history {
        History::from(h)
    } else if let Some((trim, append)) = p.history_delta {
        let prior_history = prior
            .history
            .materialized()
            .ok_or(Error::Invalid("history unavailable"))?;
        if trim > prior_history.len() {
            return Err(Error::Invalid("history trim"));
        }
        History::from(
            prior_history[trim..]
                .iter()
                .cloned()
                .chain(append)
                .collect::<Vec<_>>(),
        )
    } else {
        prior.history.clone()
    };
    let next = Snapshot {
        cols,
        rows,
        grid,
        history,
        cursor: p.cursor.unwrap_or_else(|| prior.cursor.clone()),
        modes: p.modes.unwrap_or_else(|| prior.modes.clone()),
        placements: p.placements.unwrap_or_else(|| prior.placements.clone()),
        bootstrap: p.bootstrap.unwrap_or_else(|| prior.bootstrap.clone()),
    };
    validate(&next)?;
    Ok(next)
}
