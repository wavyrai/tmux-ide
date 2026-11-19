use super::{MAX_BYTES, MAX_ROWS};
use crate::tmux_delivery::{Row, Rows, Snapshot};
use std::sync::Arc;
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Scope {
    /// Changes on every connection/selection lifetime, even when selecting the same pane again.
    pub lifetime: u64,
    pub workspace_name: String,
    pub pane: String,
    pub generation: String,
    pub incarnation: String,
}
#[derive(Clone, Copy, Debug)]
pub enum Scroll {
    Wheel(i16),
    PageUp,
    PageDown,
    Home,
    End,
}
#[derive(Default)]
pub struct Viewport {
    scope: Option<Scope>,
    current: Option<Arc<Snapshot>>,
    history: Shown,
    anchor: Option<Arc<Row>>,
    offset: usize,
}
impl Viewport {
    pub fn scope(&self) -> Option<&Scope> {
        self.scope.as_ref()
    }
    pub fn offset(&self) -> usize {
        self.offset
    }
    /// History rows the scrollback holds: the newest held rows, up to
    /// `MAX_ROWS` and `MAX_BYTES`.
    pub fn history_len(&self) -> usize {
        self.history.len()
    }
    pub fn live(&self) -> Option<&Arc<Snapshot>> {
        self.current.as_ref()
    }
    pub fn clear(&mut self) {
        *self = Self::default();
    }
    pub fn update(&mut self, scope: Scope, snapshot: Arc<Snapshot>) {
        if self.scope.as_ref() != Some(&scope)
            || self
                .current
                .as_ref()
                .is_some_and(|old| old.cols != snapshot.cols)
            || snapshot.modes.alternate_screen
        {
            self.anchor = None;
            self.offset = 0;
        }
        self.scope = Some(scope);
        self.history = Shown::of(&snapshot);
        self.current = Some(snapshot);
        if let Some(anchor) = &self.anchor {
            match unique_index(self.history.iter(), anchor) {
                Some(index) => self.offset = self.history.len() - index,
                None => {
                    self.offset = 0;
                    self.anchor = None;
                }
            }
        }
    }
    pub fn scroll(&mut self, command: Scroll) {
        let page = self
            .current
            .as_ref()
            .map_or(1, |s| s.rows.saturating_sub(1).max(1));
        self.offset = match command {
            Scroll::End => 0,
            Scroll::Home => self.history.len(),
            Scroll::PageUp => self.offset.saturating_add(page).min(self.history.len()),
            Scroll::PageDown => self.offset.saturating_sub(page),
            Scroll::Wheel(lines) => self
                .offset
                .saturating_add_signed(isize::from(lines.clamp(-1000, 1000)))
                .min(self.history.len()),
        };
        self.anchor = self.history.get(self.history.len() - self.offset).cloned();
    }
    /// The anchor's index in the whole history: a partial history's unloaded
    /// rows come first.
    pub fn capture_index(&self) -> Option<usize> {
        let history = &self.current.as_ref()?.history;
        unique_index(history.materialized()?.iter(), self.anchor.as_ref()?)
            .map(|index| history.unloaded_rows() + index)
    }
    pub fn restore_row(&mut self, row: &Arc<Row>) -> bool {
        let Some(index) = unique_index(self.history.iter(), row) else {
            return false;
        };
        self.anchor = Some(row.clone());
        self.offset = self.history.len() - index;
        true
    }
    /// Copies row handles and small metadata only. Never traverses or clones unchanged cells.
    pub fn view(&self) -> Option<Snapshot> {
        let current = self.current.as_ref()?;
        let grid = if self.offset == 0 {
            current.grid.clone()
        } else {
            self.history
                .iter_from(self.history.len() - self.offset)
                .chain(current.grid.iter())
                .take(current.rows)
                .cloned()
                .collect()
        };
        let mut cursor = current.cursor.clone();
        if self.offset != 0 {
            cursor.hidden = true;
        }
        Some(Snapshot {
            cols: current.cols,
            rows: current.rows,
            grid,
            history: current.history.clone(),
            cursor,
            modes: current.modes.clone(),
            bootstrap: current.bootstrap.clone(),
            placements: if self.offset == 0 {
                current.placements.clone()
            } else {
                Vec::new()
            },
        })
    }
}
pub(super) fn unique_index<'a>(
    rows: impl Iterator<Item = &'a Arc<Row>>,
    row: &Arc<Row>,
) -> Option<usize> {
    let mut found = None;
    for (i, candidate) in rows.enumerate() {
        if Arc::ptr_eq(candidate, row) {
            if found.is_some() {
                return None;
            }
            found = Some(i);
        }
    }
    found
}
/// The newest rows of a snapshot's history that the scrollback holds, at most
/// `MAX_ROWS` rows and `MAX_BYTES` of row memory: a suffix of the snapshot's
/// own rows, shared, so an update copies no row handles.
#[derive(Clone, Default)]
pub(super) struct Shown {
    rows: Rows,
    from: usize,
}
impl Shown {
    pub fn of(snapshot: &Snapshot) -> Self {
        let Some(rows) = snapshot.history.materialized() else {
            return Self::default();
        };
        if snapshot.modes.alternate_screen {
            return Self::default();
        }
        let newest = rows.len().saturating_sub(MAX_ROWS);
        let from = if rows.heap_bytes() <= MAX_BYTES {
            // All of them fit, so the newest `MAX_ROWS` do.
            newest
        } else {
            let mut bytes = 0usize;
            let mut from = rows.len();
            for row in rows.iter_from(newest).rev() {
                bytes = bytes.saturating_add(row.heap_bytes());
                if bytes > MAX_BYTES {
                    break;
                }
                from -= 1;
            }
            from
        };
        Self {
            rows: rows.clone(),
            from,
        }
    }
    pub fn len(&self) -> usize {
        self.rows.len() - self.from
    }
    pub fn get(&self, index: usize) -> Option<&Arc<Row>> {
        self.rows.get(self.from.checked_add(index)?)
    }
    pub fn iter(&self) -> impl Iterator<Item = &Arc<Row>> {
        self.rows.iter_from(self.from)
    }
    pub fn iter_from(&self, start: usize) -> impl Iterator<Item = &Arc<Row>> {
        self.rows.iter_from(self.from + start)
    }
}
