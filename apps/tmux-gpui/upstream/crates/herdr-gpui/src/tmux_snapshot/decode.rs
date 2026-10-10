//! Converts a tmux-ide TerminalReplicaSnapshot to the existing GPUI painter.
//! Full snapshots only: this is NOT a replica protocol, authority, or patch owner.
use super::Error;
use herdr_client::protocol::{CellData, CursorState, FrameData};
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Snapshot {
    cols: u16,
    rows: u16,
    grid: Vec<Row>,
    history: Vec<Row>,
    cursor: Cursor,
    modes: Modes,
    placements: Vec<serde_json::Value>,
    bootstrap: Bootstrap,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Row {
    cells: Vec<Cell>,
    wrapped: bool,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Cell {
    grapheme: String,
    width: u8,
    foreground: Color,
    background: Color,
    attributes: u8,
}
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
enum Color {
    Default,
    Indexed { index: u8 },
    Rgb { value: u32 },
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Cursor {
    x: u16,
    y: u16,
    hidden: bool,
    style: CursorStyle,
    blink: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum CursorStyle {
    Block,
    Underline,
    Bar,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Modes {
    alternate_screen: bool,
    application_cursor: bool,
    application_keypad: bool,
    bracketed_paste: bool,
    insert: bool,
    origin: bool,
    wraparound: bool,
    mouse_tracking: bool,
    mouse_protocol: Option<MouseProtocol>,
    mouse_encoding: Option<MouseEncoding>,
    synchronized_output: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum MouseProtocol {
    None,
    X10,
    Vt200,
    Drag,
    Any,
}
#[derive(Deserialize)]
#[serde(rename_all = "kebab-case")]
enum MouseEncoding {
    Default,
    Utf8,
    Sgr,
    SgrPixels,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Bootstrap {
    kind: BootstrapKind,
    hidden_state: HiddenState,
}
#[derive(Deserialize)]
#[serde(rename_all = "kebab-case")]
enum BootstrapKind {
    PaintedCapture,
    AuthoritativeStream,
}
#[derive(Deserialize)]
#[serde(rename_all = "kebab-case")]
enum HiddenState {
    Unknown,
    ObservedFromStart,
}

impl Color {
    fn encoded(&self) -> Result<u32, Error> {
        Ok(match *self {
            Self::Default => 0,
            Self::Indexed { index } => 0x0100_0000 | u32::from(index),
            Self::Rgb { value } if value <= 0xffffff => 0x0200_0000 | value,
            Self::Rgb { .. } => return Err(Error::Invalid("RGB color out of range")),
        })
    }
}

pub(super) fn frame(bytes: &[u8]) -> Result<FrameData, Error> {
    let snapshot: Snapshot = serde_json::from_slice(bytes)?;
    let Snapshot {
        cols,
        rows,
        grid,
        history,
        cursor,
        modes,
        placements,
        bootstrap,
    } = snapshot;
    if cols == 0 || rows == 0 || usize::from(cols) * usize::from(rows) > 262_144 {
        return Err(Error::Invalid("dimensions out of bounds"));
    }
    if grid.len() != usize::from(rows) {
        return Err(Error::Invalid("row count mismatch"));
    }
    if !placements.is_empty() {
        return Err(Error::Invalid(
            "graphics placements not supported in snapshot preview",
        ));
    }
    if !cursor.hidden && (cursor.x >= cols || cursor.y >= rows) {
        return Err(Error::Invalid("cursor out of bounds"));
    }
    // Validate metadata and history, but do not give this read-only view input authority.
    let Modes {
        alternate_screen,
        application_cursor,
        application_keypad,
        bracketed_paste,
        insert,
        origin,
        wraparound,
        mouse_tracking,
        mouse_protocol,
        mouse_encoding,
        synchronized_output,
    } = modes;
    let Bootstrap { kind, hidden_state } = bootstrap;
    let _ = (
        alternate_screen,
        application_cursor,
        application_keypad,
        bracketed_paste,
        insert,
        origin,
        wraparound,
        mouse_tracking,
        mouse_protocol,
        mouse_encoding,
        synchronized_output,
        kind,
        hidden_state,
    );
    let mut cells = Vec::with_capacity(usize::from(cols) * usize::from(rows));
    for row in grid.iter().chain(history.iter()) {
        let _ = row.wrapped;
        if row.cells.len() != usize::from(cols) {
            return Err(Error::Invalid("column count mismatch"));
        }
        for (x, cell) in row.cells.iter().enumerate() {
            if cell.grapheme.len() > 256 {
                return Err(Error::Invalid("cell grapheme exceeds preview limit"));
            }
            if cell.grapheme.chars().any(char::is_control) {
                return Err(Error::Invalid("control character in cell"));
            }
            match cell.width {
                0 if x > 0 && row.cells[x - 1].width == 2 && cell.grapheme.is_empty() => (),
                1 => (),
                2 if x + 1 < row.cells.len() && row.cells[x + 1].width == 0 => (),
                _ => return Err(Error::Invalid("invalid wide-cell pair")),
            }
            cell.foreground.encoded()?;
            cell.background.encoded()?;
        }
    }
    for row in grid {
        for cell in row.cells {
            // tmux-ide inverse/hidden/strike bits differ from Herdr's modifier layout.
            let a = cell.attributes;
            let modifier = u16::from(a & 0x0f)
                | (u16::from(a & 0x20) << 1)
                | (u16::from(a & 0x40) << 1)
                | (u16::from(a & 0x80) << 1);
            cells.push(CellData {
                symbol: cell.grapheme,
                fg: cell.foreground.encoded()?,
                bg: cell.background.encoded()?,
                modifier,
                skip: cell.width == 0,
                hyperlink: None,
            });
        }
    }
    let shape = match (cursor.style, cursor.blink) {
        (CursorStyle::Block, true) => 1,
        (CursorStyle::Block, false) => 2,
        (CursorStyle::Underline, true) => 3,
        (CursorStyle::Underline, false) => 4,
        (CursorStyle::Bar, true) => 5,
        (CursorStyle::Bar, false) => 6,
    };
    Ok(FrameData {
        cells,
        width: cols,
        height: rows,
        cursor: Some(CursorState {
            x: cursor.x,
            y: cursor.y,
            visible: !cursor.hidden,
            shape,
        }),
        hyperlinks: vec![],
        graphics: vec![],
    })
}
