use super::{MAX_BYTES, MAX_ROWS, size::Sizes};
use crate::tmux_delivery::{Row, Snapshot};
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
    history: Vec<Arc<Row>>,
    anchor: Option<Arc<Row>>,
    offset: usize,
    sizes: Sizes,
}
impl Viewport {
    pub fn scope(&self) -> Option<&Scope> {
        self.scope.as_ref()
    }
    pub fn offset(&self) -> usize {
        self.offset
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
        self.history = bounded_history(&snapshot, &mut self.sizes);
        self.current = Some(snapshot);
        if let Some(anchor) = &self.anchor {
            match unique_index(&self.history, anchor) {
                Some(index) => self.offset = self.history.len() - index,
                None => {
                    self.offset = 0;
                    self.anchor = None;
                }
            }
        }
        self.sizes.prune();
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
    pub fn capture_index(&self) -> Option<usize> {
        unique_index(
            self.current.as_ref()?.history.materialized()?,
            self.anchor.as_ref()?,
        )
    }
    pub fn restore_row(&mut self, row: &Arc<Row>) -> bool {
        let Some(index) = unique_index(&self.history, row) else {
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
                .iter()
                .skip(self.history.len() - self.offset)
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
pub(super) fn unique_index(rows: &[Arc<Row>], row: &Arc<Row>) -> Option<usize> {
    let mut found = None;
    for (i, candidate) in rows.iter().enumerate() {
        if Arc::ptr_eq(candidate, row) {
            if found.is_some() {
                return None;
            }
            found = Some(i);
        }
    }
    found
}
pub(super) fn bounded_history(snapshot: &Snapshot, sizes: &mut Sizes) -> Vec<Arc<Row>> {
    if snapshot.modes.alternate_screen {
        return Vec::new();
    }
    let mut bytes = 0usize;
    let mut history = Vec::new();
    let Some(rows) = snapshot.history.materialized() else {
        return history;
    };
    for row in rows.iter().rev().take(MAX_ROWS) {
        bytes = bytes.saturating_add(sizes.row(row));
        if bytes > MAX_BYTES {
            break;
        }
        history.push(row.clone());
    }
    history.reverse();
    history
}
