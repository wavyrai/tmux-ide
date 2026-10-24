//! TCB1 typed run tuples, parsed directly into immutable canonical rows.
mod projection;
use super::{Error, Result, types::*};
pub use projection::decode_projection;
use std::sync::Arc;
const MAX_SAFE: u64 = (1_u64 << 53) - 1;
struct Decoder<'a> {
    bytes: &'a [u8],
    rows: usize,
    runs: usize,
    cells: usize,
    max_cells: usize,
    nodes: usize,
}
impl<'a> Decoder<'a> {
    fn byte(&mut self) -> Result<u8> {
        let (first, rest) = self
            .bytes
            .split_first()
            .ok_or(Error::Invalid("binary truncation"))?;
        self.bytes = rest;
        Ok(*first)
    }
    fn tag(&mut self, tag: u8) -> Result<()> {
        self.nodes += 1;
        if self.nodes > 8_000_000 {
            return Err(Error::Invalid("binary node budget"));
        }
        if self.byte()? != tag {
            return Err(Error::Invalid("binary tag"));
        }
        Ok(())
    }
    fn varint(&mut self, max: u64) -> Result<u64> {
        let mut value = 0_u64;
        for index in 0..8 {
            let byte = self.byte()?;
            let low = u64::from(byte & 127);
            value |= low << (index * 7);
            if byte & 128 == 0 {
                if (index != 0 && low == 0) || value > max || value > MAX_SAFE {
                    return Err(Error::Invalid("binary integer bound"));
                }
                return Ok(value);
            }
        }
        Err(Error::Invalid("binary integer bound"))
    }
    fn int(&mut self, min: u64, max: u64) -> Result<u64> {
        self.tag(1)?;
        let value = self.varint(max)?;
        if value < min {
            return Err(Error::Invalid("binary integer bound"));
        }
        Ok(value)
    }
    fn size(&mut self, min: u64, max: u64) -> Result<usize> {
        Ok(self.int(min, max)? as usize)
    }
    fn bit(&mut self) -> Result<bool> {
        Ok(self.int(0, 1)? == 1)
    }
    fn list(&mut self, max: u64) -> Result<usize> {
        self.tag(3)?;
        Ok(self.varint(max)? as usize)
    }
    fn tuple(&mut self, length: usize) -> Result<()> {
        if self.list(length as u64)? != length {
            return Err(Error::Invalid("binary tuple length"));
        }
        Ok(())
    }
    fn string(&mut self, nonempty: bool) -> Result<&'a str> {
        self.tag(2)?;
        let length = self.varint(4096)? as usize;
        if (nonempty && length == 0) || length > self.bytes.len() {
            return Err(Error::Invalid("binary string bound"));
        }
        let (bytes, rest) = self.bytes.split_at(length);
        self.bytes = rest;
        std::str::from_utf8(bytes).map_err(|_| Error::Invalid("binary UTF-8"))
    }
    fn optional<T>(&mut self, read: impl FnOnce(&mut Self) -> Result<T>) -> Result<Option<T>> {
        if self.bytes.first() == Some(&0) {
            self.tag(0)?;
            Ok(None)
        } else {
            read(self).map(Some)
        }
    }
    fn color(&mut self) -> Result<Color> {
        if self.bytes.first() == Some(&1) {
            self.int(0, 0)?;
            return Ok(Color::Default);
        }
        self.tuple(2)?;
        match self.int(1, 2)? {
            1 => Ok(Color::Indexed {
                index: self.int(0, 255)? as u8,
            }),
            _ => Ok(Color::Rgb {
                value: self.int(0, 0xffffff)? as u32,
            }),
        }
    }
    fn row(&mut self, cols: Option<usize>) -> Result<Arc<Row>> {
        self.rows += 1;
        if self.rows > 10000 {
            return Err(Error::Invalid("row budget"));
        }
        self.tuple(2)?;
        let wrapped = self.bit()?;
        let runs = self.list(1_000_000)?;
        self.runs += runs;
        if self.runs > 1_000_000 {
            return Err(Error::Invalid("run budget"));
        }
        let mut cells = Vec::new();
        for _ in 0..runs {
            self.tuple(6)?;
            let count = self.size(1, 4096)?;
            self.cells += count;
            if self.cells > self.max_cells || cells.len() + count > 4096 {
                return Err(Error::Invalid("cell budget"));
            }
            let cell = Cell {
                grapheme: Arc::from(self.string(false)?),
                width: self.int(0, 2)? as u8,
                foreground: self.color()?,
                background: self.color()?,
                attributes: self.int(0, 255)? as u8,
            };
            cells.extend(std::iter::repeat_n(cell, count));
        }
        if cells.is_empty() || cols.is_some_and(|n| n != cells.len()) {
            return Err(Error::Invalid("row width"));
        }
        for (i, cell) in cells.iter().enumerate() {
            if (cell.width == 2 && cells.get(i + 1).map(|c| c.width) != Some(0))
                || (cell.width == 0 && (i == 0 || cells[i - 1].width != 2))
            {
                return Err(Error::Invalid("wide cell pairing"));
            }
        }
        Ok(Arc::new(Row::new(cells, wrapped)))
    }
    fn rows(&mut self, cols: Option<usize>, max: u64) -> Result<Vec<Arc<Row>>> {
        let count = self.list(max)?;
        // No reservation from an untrusted count; each row validates before allocation.
        (0..count).map(|_| self.row(cols)).collect()
    }
    fn cursor(&mut self) -> Result<Cursor> {
        self.tuple(5)?;
        Ok(Cursor {
            x: self.size(0, 4095)?,
            y: self.size(0, 4095)?,
            hidden: self.bit()?,
            style: match self.string(true)? {
                "block" => CursorStyle::Block,
                "underline" => CursorStyle::Underline,
                "bar" => CursorStyle::Bar,
                _ => return Err(Error::Invalid("cursor style")),
            },
            blink: self.bit()?,
        })
    }
    fn modes(&mut self) -> Result<Modes> {
        self.tuple(11)?;
        Ok(Modes {
            alternate_screen: self.bit()?,
            application_cursor: self.bit()?,
            application_keypad: self.bit()?,
            bracketed_paste: self.bit()?,
            insert: self.bit()?,
            origin: self.bit()?,
            wraparound: self.bit()?,
            mouse_tracking: self.bit()?,
            mouse_protocol: self.optional(|d| {
                Ok(match d.string(true)? {
                    "none" => MouseProtocol::None,
                    "x10" => MouseProtocol::X10,
                    "vt200" => MouseProtocol::Vt200,
                    "drag" => MouseProtocol::Drag,
                    "any" => MouseProtocol::Any,
                    _ => return Err(Error::Invalid("mouse protocol")),
                })
            })?,
            mouse_encoding: self.optional(|d| {
                Ok(match d.string(true)? {
                    "default" => MouseEncoding::Default,
                    "utf8" => MouseEncoding::Utf8,
                    "sgr" => MouseEncoding::Sgr,
                    "sgr-pixels" => MouseEncoding::SgrPixels,
                    _ => return Err(Error::Invalid("mouse encoding")),
                })
            })?,
            synchronized_output: self.bit()?,
        })
    }
    fn placements(&mut self) -> Result<Vec<Placement>> {
        let count = self.list(4096)?;
        (0..count)
            .map(|_| {
                self.tuple(7)?;
                Ok(Placement {
                    id: self.string(true)?.into(),
                    kind: self.string(true)?.into(),
                    row: self.size(0, 4095)?,
                    column: self.size(0, 4095)?,
                    columns: self.size(1, 4096)?,
                    rows: self.size(1, 4096)?,
                    content_digest: self.string(true)?.into(),
                })
            })
            .collect()
    }
    fn bootstrap(&mut self) -> Result<Bootstrap> {
        self.tuple(2)?;
        Ok(Bootstrap {
            kind: match self.string(true)? {
                "painted-capture" => BootstrapKind::PaintedCapture,
                "authoritative-stream" => BootstrapKind::AuthoritativeStream,
                _ => return Err(Error::Invalid("bootstrap kind")),
            },
            hidden_state: match self.string(true)? {
                "unknown" => HiddenState::Unknown,
                "observed-from-start" => HiddenState::ObservedFromStart,
                _ => return Err(Error::Invalid("bootstrap hidden state")),
            },
        })
    }
    fn dimensions(&mut self) -> Result<(usize, usize)> {
        self.tuple(2)?;
        Ok((self.size(1, 4096)?, self.size(1, 4096)?))
    }
    fn snapshot(&mut self) -> Result<Snapshot> {
        self.tuple(8)?;
        let cols = self.size(1, 4096)?;
        let rows = self.size(1, 4096)?;
        let snapshot = Snapshot {
            cols,
            rows,
            grid: self.rows(Some(cols), rows as u64)?,
            history: self.rows(Some(cols), 10000)?.into(),
            cursor: self.cursor()?,
            modes: self.modes()?,
            placements: self.placements()?,
            bootstrap: self.bootstrap()?,
        };
        super::store::validate(&snapshot)?;
        Ok(snapshot)
    }
    fn patch(&mut self) -> Result<Patch> {
        self.tuple(8)?;
        let dimensions = self.optional(Self::dimensions)?;
        let count = self.list(4096)?;
        let rows = (0..count)
            .map(|_| {
                self.tuple(2)?;
                Ok((self.size(0, 4095)?, self.row(dimensions.map(|d| d.0))?))
            })
            .collect::<Result<_>>()?;
        let history = self.optional(|d| d.rows(None, 10000))?;
        let history_delta = self.optional(|d| {
            d.tuple(2)?;
            Ok((d.size(0, 10000)?, d.rows(None, 10000)?))
        })?;
        if history.is_some() && history_delta.is_some() {
            return Err(Error::Invalid("conflicting history"));
        }
        Ok(Patch {
            dimensions,
            rows,
            history,
            history_delta,
            cursor: self.optional(Self::cursor)?,
            modes: self.optional(Self::modes)?,
            placements: self.optional(Self::placements)?,
            bootstrap: self.optional(Self::bootstrap)?,
        })
    }
}
/// Decode semantic-binary-v1 without a JSON tree or terminal-cell reserialization.
pub fn decode_binary(bytes: &[u8]) -> Result<Update> {
    if bytes.len() > 16 * 1024 * 1024 || !bytes.starts_with(b"TCB1") {
        return Err(Error::Invalid("binary representation"));
    }
    let mut d = Decoder {
        bytes: &bytes[4..],
        rows: 0,
        runs: 0,
        cells: 0,
        max_cells: 1_000_000,
        nodes: 0,
    };
    let frame = d.byte()?;
    let revision = d.varint(MAX_SAFE)?;
    let update = if frame == 0 {
        Update::Seed {
            revision,
            snapshot: d.snapshot()?,
        }
    } else {
        let base_revision = d.varint(MAX_SAFE)?;
        if revision <= base_revision {
            return Err(Error::Revision);
        }
        match frame {
            1 => Update::Patch {
                revision,
                base_revision,
                patch: d.patch()?,
            },
            2 => {
                let reason = d.string(true)?;
                if !["pane-closed", "session-restarted", "runtime-disposed"].contains(&reason) {
                    return Err(Error::Invalid("tombstone"));
                }
                Update::Tombstone {
                    revision,
                    base_revision,
                    reason: reason.into(),
                }
            }
            _ => return Err(Error::Invalid("binary frame")),
        }
    };
    if !d.bytes.is_empty() {
        return Err(Error::Invalid("binary trailing bytes"));
    }
    Ok(update)
}
