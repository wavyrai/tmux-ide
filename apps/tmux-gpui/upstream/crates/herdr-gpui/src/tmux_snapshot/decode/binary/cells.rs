//! Cell-body structural decoding. Typed rows pass to the existing snapshot/authority validators.
use super::super::compact::{Run, WireRow};
use super::{Error, MAX_JSON};
use serde_json::Value;

pub(in crate::tmux_snapshot) struct CellFrame {
    pub(in crate::tmux_snapshot::decode) metadata: Value,
    pub(in crate::tmux_snapshot::decode) changed_rows: Vec<(usize, WireRow)>,
    pub(in crate::tmux_snapshot::decode) history: Vec<WireRow>,
    pub(in crate::tmux_snapshot::decode) full: bool,
}
struct Cursor<'a> {
    bytes: &'a [u8],
    offset: usize,
}
impl<'a> Cursor<'a> {
    fn take(&mut self, count: usize) -> Result<&'a [u8], Error> {
        let end = self
            .offset
            .checked_add(count)
            .ok_or(Error::Invalid("binary length overflow"))?;
        let bytes = self
            .bytes
            .get(self.offset..end)
            .ok_or(Error::Invalid("truncated binary cells"))?;
        self.offset = end;
        Ok(bytes)
    }
    fn byte(&mut self) -> Result<u8, Error> {
        Ok(self.take(1)?[0])
    }
    fn u16(&mut self) -> Result<u16, Error> {
        let b = self.take(2)?;
        Ok(u16::from_be_bytes([b[0], b[1]]))
    }
    fn u32(&mut self) -> Result<u32, Error> {
        let b = self.take(4)?;
        Ok(u32::from_be_bytes([b[0], b[1], b[2], b[3]]))
    }
    fn row(&mut self, cols: usize, budget: &mut usize) -> Result<WireRow, Error> {
        let wrapped = match self.byte()? {
            0 => false,
            1 => true,
            _ => return Err(Error::Invalid("invalid binary wrapped flag")),
        };
        let run_count = self.u32()? as usize;
        if run_count == 0 || run_count > cols {
            return Err(Error::Invalid("invalid binary run count"));
        }
        let mut runs = Vec::with_capacity(run_count);
        let mut count = 0usize;
        let mut continuation = false;
        for _ in 0..run_count {
            let repeat = self.u32()?;
            if repeat == 0 || repeat as usize > cols - count {
                return Err(Error::Invalid("invalid binary run repeat"));
            }
            let text_len = self.u16()? as usize;
            if text_len > 256 {
                return Err(Error::Invalid("binary grapheme exceeds limit"));
            }
            let text = std::str::from_utf8(self.take(text_len)?)
                .map_err(|_| Error::Invalid("invalid binary UTF-8"))?;
            if text.chars().any(char::is_control) {
                return Err(Error::Invalid("binary control grapheme"));
            }
            *budget += text_len * repeat as usize;
            if *budget > 8 * 1024 * 1024 {
                return Err(Error::Invalid("binary expanded graphemes exceed limit"));
            }
            let width = self.byte()?;
            if continuation {
                if width != 0 || repeat != 1 || !text.is_empty() {
                    return Err(Error::Invalid("invalid binary wide continuation"));
                }
            } else if width == 0 {
                return Err(Error::Invalid("orphan binary continuation"));
            }
            if width > 2 || (width == 2 && repeat != 1) {
                return Err(Error::Invalid("invalid binary cell width"));
            }
            continuation = width == 2;
            let fg = self.u32()?;
            let bg = self.u32()?;
            for color in [fg, bg] {
                if !matches!(color,0|0x01000000..=0x010000ff|0x02000000..=0x02ffffff) {
                    return Err(Error::Invalid("invalid binary color"));
                }
            }
            let attrs = self.byte()?;
            runs.push(Run(repeat, text.to_owned(), width, fg, bg, attrs));
            count += repeat as usize;
        }
        if count != cols || continuation {
            return Err(Error::Invalid("incomplete binary row"));
        }
        Ok(WireRow::Compact((wrapped, runs)))
    }
}
pub(in crate::tmux_snapshot) fn decode(bytes: &[u8]) -> Result<CellFrame, Error> {
    if bytes.len() > MAX_JSON {
        return Err(Error::Invalid("binary cell body exceeds limit"));
    }
    let mut cursor = Cursor { bytes, offset: 0 };
    let metadata_len = cursor.u32()? as usize;
    let metadata: Value = serde_json::from_slice(cursor.take(metadata_len)?)?;
    let object = metadata
        .as_object()
        .ok_or(Error::Invalid("invalid binary metadata"))?;
    if ["grid", "history", "changedRows"]
        .iter()
        .any(|key| object.contains_key(*key))
    {
        return Err(Error::Invalid("binary metadata contains rows"));
    }
    let full = match metadata["encoding"].as_str() {
        Some("rle-v1") => true,
        Some("rle-delta-v1") => false,
        _ => return Err(Error::Invalid("invalid binary cell encoding")),
    };
    let cols = metadata["cols"]
        .as_u64()
        .filter(|v| *v > 0 && *v <= 65535)
        .ok_or(Error::Invalid("invalid binary columns"))? as usize;
    let rows = metadata["rows"]
        .as_u64()
        .filter(|v| *v > 0 && *v <= 65535)
        .ok_or(Error::Invalid("invalid binary rows"))? as usize;
    if rows * cols > 262144 {
        return Err(Error::Invalid("binary cell budget exceeded"));
    }
    let count = cursor.u32()? as usize;
    if count > rows || (full && count != rows) {
        return Err(Error::Invalid("invalid binary row count"));
    }
    let mut changed_rows = Vec::with_capacity(count);
    let mut previous = None;
    let mut budget = 0;
    for position in 0..count {
        let index = cursor.u32()? as usize;
        if index >= rows || previous.is_some_and(|p| index <= p) || (full && index != position) {
            return Err(Error::Invalid("invalid binary row index"));
        }
        previous = Some(index);
        changed_rows.push((index, cursor.row(cols, &mut budget)?));
    }
    let history_count = cursor.u32()? as usize;
    if history_count
        .checked_add(rows)
        .and_then(|count| count.checked_mul(cols))
        .is_none_or(|count| count > 262144)
    {
        return Err(Error::Invalid("binary history budget exceeded"));
    }
    let mut history = Vec::with_capacity(history_count);
    for _ in 0..history_count {
        history.push(cursor.row(cols, &mut budget)?);
    }
    if cursor.offset != bytes.len() {
        return Err(Error::Invalid("trailing binary cells"));
    }
    Ok(CellFrame {
        metadata,
        changed_rows,
        history,
        full,
    })
}
