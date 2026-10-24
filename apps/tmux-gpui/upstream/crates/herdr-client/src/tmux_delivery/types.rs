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
#[derive(Debug, Clone)]
pub enum History {
    Complete(Arc<Vec<Arc<Row>>>),
    Deferred(DeferredHistory),
}
impl History {
    pub fn materialized(&self) -> Option<&[Arc<Row>]> {
        match self {
            Self::Complete(rows) => Some(rows),
            Self::Deferred(_) => None,
        }
    }
    pub fn materialized_mut(&mut self) -> Option<&mut Vec<Arc<Row>>> {
        match self {
            Self::Complete(rows) => Some(Arc::make_mut(rows)),
            Self::Deferred(_) => None,
        }
    }
    pub fn is_complete(&self) -> bool {
        matches!(self, Self::Complete(_))
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
}
impl Update {
    pub fn revision(&self) -> u64 {
        match self {
            Self::Seed { revision, .. }
            | Self::Patch { revision, .. }
            | Self::Tombstone { revision, .. } => *revision,
        }
    }
    pub fn frame(&self) -> &'static str {
        match self {
            Self::Seed { .. } => "seed",
            Self::Patch { .. } => "patch",
            Self::Tombstone { .. } => "tombstone",
        }
    }
    pub fn base_revision(&self) -> Option<u64> {
        match self {
            Self::Seed { .. } => None,
            Self::Patch { base_revision, .. } | Self::Tombstone { base_revision, .. } => {
                Some(*base_revision)
            }
        }
    }
}
