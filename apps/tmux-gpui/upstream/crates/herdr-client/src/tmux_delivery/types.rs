use serde::Serialize;
use std::sync::Arc;
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Color {
    Default,
    Indexed { index: u8 },
    Rgb { value: u32 },
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Cell {
    pub grapheme: Arc<str>,
    pub width: u8,
    pub foreground: Color,
    pub background: Color,
    pub attributes: u8,
}
/// Cells and their cached digest cannot be mutated after validation.
#[derive(Debug, PartialEq, Eq)]
pub struct Row {
    pub(super) cells: Vec<Cell>,
    pub(super) wrapped: bool,
    pub(super) digest: u64,
}
impl Row {
    pub fn cells(&self) -> &[Cell] {
        &self.cells
    }
    pub fn wrapped(&self) -> bool {
        self.wrapped
    }
    pub fn digest(&self) -> u64 {
        self.digest
    }
    pub(super) fn new(cells: Vec<Cell>, wrapped: bool) -> Self {
        let digest = super::hash::hash_row(&cells, wrapped);
        Self {
            cells,
            wrapped,
            digest,
        }
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CursorStyle {
    Block,
    Underline,
    Bar,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Cursor {
    pub x: usize,
    pub y: usize,
    pub hidden: bool,
    pub style: CursorStyle,
    pub blink: bool,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MouseProtocol {
    None,
    X10,
    Vt200,
    Drag,
    Any,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum MouseEncoding {
    Default,
    Utf8,
    Sgr,
    SgrPixels,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Modes {
    pub alternate_screen: bool,
    pub application_cursor: bool,
    pub application_keypad: bool,
    pub bracketed_paste: bool,
    pub insert: bool,
    pub origin: bool,
    pub wraparound: bool,
    pub mouse_tracking: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mouse_protocol: Option<MouseProtocol>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mouse_encoding: Option<MouseEncoding>,
    pub synchronized_output: bool,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Placement {
    pub id: String,
    pub kind: String,
    pub row: usize,
    pub column: usize,
    pub columns: usize,
    pub rows: usize,
    pub content_digest: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum BootstrapKind {
    PaintedCapture,
    AuthoritativeStream,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum HiddenState {
    Unknown,
    ObservedFromStart,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Bootstrap {
    pub kind: BootstrapKind,
    pub hidden_state: HiddenState,
}
/// Deferred rows are a source commitment, never locally available history.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeferredHistory {
    pub rows: usize,
    pub digest: String,
}
/// Capability 122 (history on demand): the newest history rows, held, and a
/// commitment to the older rows the daemon has not sent (`unloaded`, oldest
/// first). The rows digest is a polynomial fold, so the two together give the
/// whole history's digest and the canonical state hash.
#[derive(Debug, Clone)]
pub struct PartialHistory {
    pub unloaded: DeferredHistory,
    pub loaded: Arc<Vec<Arc<Row>>>,
}
#[derive(Debug, Clone)]
pub enum History {
    Complete(Arc<Vec<Arc<Row>>>),
    Deferred(DeferredHistory),
    Partial(PartialHistory),
}
impl History {
    /// The history rows held here: all of them, or the loaded newest ones of
    /// a partial history. `None` for a deferred (projection) history.
    pub fn materialized(&self) -> Option<&[Arc<Row>]> {
        match self {
            Self::Complete(rows) => Some(rows),
            Self::Partial(partial) => Some(&partial.loaded),
            Self::Deferred(_) => None,
        }
    }
    pub fn materialized_mut(&mut self) -> Option<&mut Vec<Arc<Row>>> {
        match self {
            Self::Complete(rows) => Some(Arc::make_mut(rows)),
            Self::Partial(partial) => Some(Arc::make_mut(&mut partial.loaded)),
            Self::Deferred(_) => None,
        }
    }
    /// Every history row is held. A partial history becomes complete once its
    /// last unloaded row is loaded.
    pub fn is_complete(&self) -> bool {
        match self {
            Self::Complete(_) => true,
            Self::Partial(partial) => partial.unloaded.rows == 0,
            Self::Deferred(_) => false,
        }
    }
    /// A projection's history (111/112): the canonical rows are not here at
    /// all, unlike a partial history, which holds the newest rows.
    pub fn is_deferred(&self) -> bool {
        matches!(self, Self::Deferred(_))
    }
    /// History rows not held: older than every held row.
    pub fn unloaded_rows(&self) -> usize {
        match self {
            Self::Complete(_) => 0,
            Self::Partial(partial) => partial.unloaded.rows,
            Self::Deferred(deferred) => deferred.rows,
        }
    }
}
impl From<Vec<Arc<Row>>> for History {
    fn from(rows: Vec<Arc<Row>>) -> Self {
        Self::Complete(Arc::new(rows))
    }
}
#[derive(Debug, Clone)]
pub struct Snapshot {
    pub cols: usize,
    pub rows: usize,
    pub grid: Vec<Arc<Row>>,
    pub history: History,
    pub cursor: Cursor,
    pub modes: Modes,
    pub placements: Vec<Placement>,
    pub bootstrap: Bootstrap,
}
#[derive(Debug, Clone)]
pub struct Patch {
    pub dimensions: Option<(usize, usize)>,
    pub rows: Vec<(usize, Arc<Row>)>,
    pub history: Option<Vec<Arc<Row>>>,
    pub history_delta: Option<(usize, Vec<Arc<Row>>)>,
    pub cursor: Option<Cursor>,
    pub modes: Option<Modes>,
    pub placements: Option<Vec<Placement>>,
    pub bootstrap: Option<Bootstrap>,
}
#[derive(Debug, Clone)]
pub enum Update {
    Seed {
        revision: u64,
        snapshot: Snapshot,
    },
    Patch {
        base_revision: u64,
        revision: u64,
        patch: Patch,
    },
    Tombstone {
        base_revision: u64,
        revision: u64,
        reason: String,
    },
    /// Capability 122: the newest unloaded history rows, oldest first, at the
    /// client's revision. It changes no revision and no canonical state.
    History {
        revision: u64,
        rows: Vec<Arc<Row>>,
    },
}
impl Update {
    pub fn revision(&self) -> u64 {
        match self {
            Self::Seed { revision, .. }
            | Self::Patch { revision, .. }
            | Self::Tombstone { revision, .. }
            | Self::History { revision, .. } => *revision,
        }
    }
    pub fn frame(&self) -> &'static str {
        match self {
            Self::Seed { .. } => "seed",
            Self::Patch { .. } => "patch",
            Self::Tombstone { .. } => "tombstone",
            Self::History { .. } => "history",
        }
    }
    pub fn base_revision(&self) -> Option<u64> {
        match self {
            Self::Seed { .. } | Self::History { .. } => None,
            Self::Patch { base_revision, .. } | Self::Tombstone { base_revision, .. } => {
                Some(*base_revision)
            }
        }
    }
}
