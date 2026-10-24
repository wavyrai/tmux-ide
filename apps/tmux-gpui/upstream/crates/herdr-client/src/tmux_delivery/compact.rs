use super::{Error, Result, types::*};
use serde_json::Value;
use std::sync::Arc;
const MAX_BYTES: usize = 16 * 1024 * 1024;
fn invalid<T>(s: &'static str) -> Result<T> {
    Err(Error::Invalid(s))
}
fn array(v: &Value, n: usize) -> Result<&[Value]> {
    let a = list(v, n)?;
    if a.len() != n {
        return invalid("tuple length");
    }
    Ok(a)
}
fn list(v: &Value, max: usize) -> Result<&[Value]> {
    match v.as_array() {
        Some(a) if a.len() <= max => Ok(a),
        _ => invalid("array bound"),
    }
}
fn int(v: &Value, min: u64, max: u64) -> Result<u64> {
    // JSON numbers such as 1.0, 1e0 and -0 are integers in the TS contract.
    if let Some(n) = v.as_u64() {
        return if n >= min && n <= max {
            Ok(n)
        } else {
            invalid("integer bound")
        };
    }
    match v.as_f64() {
        Some(n) if n.is_finite() && n.fract() == 0.0 && n >= min as f64 && n <= max as f64 => {
            Ok(n as u64)
        }
        _ => invalid("integer bound"),
    }
}
fn size(v: &Value, min: u64, max: u64) -> Result<usize> {
    Ok(int(v, min, max)? as usize)
}
fn bit(v: &Value) -> Result<bool> {
    Ok(int(v, 0, 1)? == 1)
}
fn string(v: &Value, nonempty: bool) -> Result<&str> {
    match v.as_str() {
        Some(s) if s.len() <= 4096 && (!nonempty || !s.is_empty()) => Ok(s),
        _ => invalid("string bound"),
    }
}
fn optional<T>(v: &Value, f: impl FnOnce(&Value) -> Result<T>) -> Result<Option<T>> {
    if v.is_null() {
        Ok(None)
    } else {
        f(v).map(Some)
    }
}
struct Budget {
    rows: usize,
    runs: usize,
    cells: usize,
    max_cells: usize,
}
impl Budget {
    fn row(&mut self, v: &Value, cols: Option<usize>) -> Result<Arc<Row>> {
        self.rows += 1;
        if self.rows > 10000 {
            return invalid("row budget");
        }
        let a = array(v, 2)?;
        let wrapped = bit(&a[0])?;
        let mut cells = Vec::new();
        for r in list(&a[1], 1_000_000)? {
            self.runs += 1;
            if self.runs > 1_000_000 {
                return invalid("run budget");
            }
            let r = array(r, 6)?;
            let count = size(&r[0], 1, 4096)?;
            self.cells += count;
            if self.cells > self.max_cells || cells.len() + count > 4096 {
                return invalid("cell budget");
            }
            let c = Cell {
                grapheme: Arc::from(string(&r[1], false)?),
                width: int(&r[2], 0, 2)? as u8,
                foreground: color(&r[3])?,
                background: color(&r[4])?,
                attributes: int(&r[5], 0, 255)? as u8,
            };
            cells.extend(std::iter::repeat_n(c, count));
        }
        if cells.is_empty() || cols.is_some_and(|n| n != cells.len()) {
            return invalid("row width");
        }
        for (i, c) in cells.iter().enumerate() {
            if (c.width == 2 && cells.get(i + 1).map(|c| c.width) != Some(0))
                || (c.width == 0 && (i == 0 || cells[i - 1].width != 2))
            {
                return invalid("wide cell pairing");
            }
        }
        Ok(Arc::new(Row::new(cells, wrapped)))
    }
    fn rows(&mut self, v: &Value, cols: Option<usize>, max: usize) -> Result<Vec<Arc<Row>>> {
        list(v, max)?.iter().map(|v| self.row(v, cols)).collect()
    }
}
fn color(v: &Value) -> Result<Color> {
    if int(v, 0, 0).is_ok() {
        return Ok(Color::Default);
    }
    let a = array(v, 2)?;
    match int(&a[0], 1, 2)? {
        1 => Ok(Color::Indexed {
            index: int(&a[1], 0, 255)? as u8,
        }),
        _ => Ok(Color::Rgb {
            value: int(&a[1], 0, 0xffffff)? as u32,
        }),
    }
}
fn cursor(v: &Value) -> Result<Cursor> {
    let a = array(v, 5)?;
    Ok(Cursor {
        x: size(&a[0], 0, 4095)?,
        y: size(&a[1], 0, 4095)?,
        hidden: bit(&a[2])?,
        style: match string(&a[3], true)? {
            "block" => CursorStyle::Block,
            "underline" => CursorStyle::Underline,
            "bar" => CursorStyle::Bar,
            _ => return invalid("cursor style"),
        },
        blink: bit(&a[4])?,
    })
}
fn modes(v: &Value) -> Result<Modes> {
    let a = array(v, 11)?;
    Ok(Modes {
        alternate_screen: bit(&a[0])?,
        application_cursor: bit(&a[1])?,
        application_keypad: bit(&a[2])?,
        bracketed_paste: bit(&a[3])?,
        insert: bit(&a[4])?,
        origin: bit(&a[5])?,
        wraparound: bit(&a[6])?,
        mouse_tracking: bit(&a[7])?,
        mouse_protocol: optional(&a[8], |v| {
            Ok(match string(v, true)? {
                "none" => MouseProtocol::None,
                "x10" => MouseProtocol::X10,
                "vt200" => MouseProtocol::Vt200,
                "drag" => MouseProtocol::Drag,
                "any" => MouseProtocol::Any,
                _ => return invalid("mouse protocol"),
            })
        })?,
        mouse_encoding: optional(&a[9], |v| {
            Ok(match string(v, true)? {
                "default" => MouseEncoding::Default,
                "utf8" => MouseEncoding::Utf8,
                "sgr" => MouseEncoding::Sgr,
                "sgr-pixels" => MouseEncoding::SgrPixels,
                _ => return invalid("mouse encoding"),
            })
        })?,
        synchronized_output: bit(&a[10])?,
    })
}
fn placements(v: &Value) -> Result<Vec<Placement>> {
    list(v, 4096)?
        .iter()
        .map(|v| {
            let a = array(v, 7)?;
            Ok(Placement {
                id: string(&a[0], true)?.into(),
                kind: string(&a[1], true)?.into(),
                row: size(&a[2], 0, 4095)?,
                column: size(&a[3], 0, 4095)?,
                columns: size(&a[4], 1, 4096)?,
                rows: size(&a[5], 1, 4096)?,
                content_digest: string(&a[6], true)?.into(),
            })
        })
        .collect()
}
fn bootstrap(v: &Value) -> Result<Bootstrap> {
    let a = array(v, 2)?;
    Ok(Bootstrap {
        kind: match string(&a[0], true)? {
            "painted-capture" => BootstrapKind::PaintedCapture,
            "authoritative-stream" => BootstrapKind::AuthoritativeStream,
            _ => return invalid("bootstrap kind"),
        },
        hidden_state: match string(&a[1], true)? {
            "unknown" => HiddenState::Unknown,
            "observed-from-start" => HiddenState::ObservedFromStart,
            _ => return invalid("bootstrap hidden state"),
        },
    })
}
fn snapshot(v: &Value, b: &mut Budget) -> Result<Snapshot> {
    let a = array(v, 8)?;
    let cols = size(&a[0], 1, 4096)?;
    let rows = size(&a[1], 1, 4096)?;
    let s = Snapshot {
        cols,
        rows,
        grid: b.rows(&a[2], Some(cols), rows)?,
        history: b.rows(&a[3], Some(cols), 10000)?.into(),
        cursor: cursor(&a[4])?,
        modes: modes(&a[5])?,
        placements: placements(&a[6])?,
        bootstrap: bootstrap(&a[7])?,
    };
    super::store::validate(&s)?;
    Ok(s)
}
fn patch(v: &Value, b: &mut Budget) -> Result<Patch> {
    let a = array(v, 8)?;
    let dimensions = optional(&a[0], |v| {
        let a = array(v, 2)?;
        Ok((size(&a[0], 1, 4096)?, size(&a[1], 1, 4096)?))
    })?;
    let rows = list(&a[1], 4096)?
        .iter()
        .map(|v| {
            let a = array(v, 2)?;
            Ok((
                size(&a[0], 0, 4095)?,
                b.row(&a[1], dimensions.map(|d| d.0))?,
            ))
        })
        .collect::<Result<_>>()?;
    let history = optional(&a[2], |v| b.rows(v, None, 10000))?;
    let history_delta = optional(&a[3], |v| {
        let a = array(v, 2)?;
        Ok((size(&a[0], 0, 10000)?, b.rows(&a[1], None, 10000)?))
    })?;
    if history.is_some() && history_delta.is_some() {
        return invalid("conflicting history");
    }
    Ok(Patch {
        dimensions,
        rows,
        history,
        history_delta,
        cursor: optional(&a[4], cursor)?,
        modes: optional(&a[5], modes)?,
        placements: optional(&a[6], placements)?,
        bootstrap: optional(&a[7], bootstrap)?,
    })
}
/// Decode only the daemon's semantic-compact-v1 format (not GUI bridge frames).
pub fn decode_compact(bytes: &[u8]) -> Result<Update> {
    if bytes.len() > MAX_BYTES {
        return invalid("representation bound");
    }
    let v: Value = serde_json::from_slice(bytes)?;
    let o = v.as_object().ok_or(Error::Invalid("envelope"))?;
    let f = o
        .get("f")
        .and_then(Value::as_str)
        .ok_or(Error::Invalid("frame"))?;
    let keys: &[&str] = match f {
        "s" => &["v", "k", "f", "r", "s"],
        "p" => &["v", "k", "f", "b", "r", "p"],
        "t" => &["v", "k", "f", "b", "r", "t"],
        _ => return invalid("frame"),
    };
    if o.len() != keys.len()
        || keys.iter().any(|k| !o.contains_key(*k))
        || int(&v["v"], 1, 1).is_err()
        || v["k"].as_str() != Some("terminal-semantic-compact")
    {
        return invalid("envelope schema");
    }
    let revision = int(&v["r"], 0, 9_007_199_254_740_991)?;
    let mut b = Budget {
        rows: 0,
        runs: 0,
        cells: 0,
        max_cells: 1_000_000.min(bytes.len() * 64),
    };
    if f == "s" {
        return Ok(Update::Seed {
            revision,
            snapshot: snapshot(&v["s"], &mut b)?,
        });
    }
    let base_revision = int(&v["b"], 0, 9_007_199_254_740_991)?;
    if revision <= base_revision {
        return Err(Error::Revision);
    }
    if f == "p" {
        return Ok(Update::Patch {
            base_revision,
            revision,
            patch: patch(&v["p"], &mut b)?,
        });
    }
    let reason = string(&v["t"], true)?;
    if !["pane-closed", "session-restarted", "runtime-disposed"].contains(&reason) {
        return invalid("tombstone");
    }
    Ok(Update::Tombstone {
        base_revision,
        revision,
        reason: reason.into(),
    })
}
