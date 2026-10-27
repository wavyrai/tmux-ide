//! Bounded binary transport primitives, selected only after capability negotiation.
use super::Error;
const HEADER: usize = 12;
const MAX_JSON: usize = 8 * 1024 * 1024;
const MAX_IMAGE: usize = 4 + 4096 + 512 * 1024;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(in crate::tmux_snapshot) enum Kind {
    Json,
    Cells,
    Image,
}
#[derive(Default)]
pub(in crate::tmux_snapshot) struct Parser {
    header: [u8; HEADER],
    header_len: usize,
    payload: Vec<u8>,
    expected: usize,
    kind: Option<Kind>,
    failed: bool,
}
#[derive(Debug, PartialEq, Eq)]
pub(in crate::tmux_snapshot) struct Progress {
    pub consumed: usize,
    pub blocked: bool,
}
impl Parser {
    /// A false callback accepts this complete frame, then stops before consuming the next byte.
    pub fn push(
        &mut self,
        bytes: &[u8],
        mut accept: impl FnMut(Kind, &[u8]) -> Result<bool, Error>,
    ) -> Result<Progress, Error> {
        if self.failed {
            return Err(Error::Invalid("binary parser retired"));
        }
        let result = self.push_inner(bytes, &mut accept);
        if result.is_err() {
            self.failed = true;
            self.payload.clear();
        }
        result
    }
    fn push_inner(
        &mut self,
        bytes: &[u8],
        accept: &mut impl FnMut(Kind, &[u8]) -> Result<bool, Error>,
    ) -> Result<Progress, Error> {
        let mut consumed = 0;
        while consumed < bytes.len() || self.kind.is_some() && self.payload.len() == self.expected {
            if self.kind.is_none() {
                let count = (HEADER - self.header_len).min(bytes.len() - consumed);
                self.header[self.header_len..self.header_len + count]
                    .copy_from_slice(&bytes[consumed..consumed + count]);
                self.header_len += count;
                consumed += count;
                if self.header_len < HEADER {
                    break;
                }
                if &self.header[..4] != b"TIGF"
                    || self.header[4] != 1
                    || self.header[6..8] != [0, 0]
                {
                    return Err(Error::Invalid("invalid binary frame header"));
                }
                let kind = match self.header[5] {
                    1 => Kind::Json,
                    2 => Kind::Cells,
                    3 => Kind::Image,
                    _ => return Err(Error::Invalid("invalid binary frame type")),
                };
                self.expected = u32::from_be_bytes([
                    self.header[8],
                    self.header[9],
                    self.header[10],
                    self.header[11],
                ]) as usize;
                if self.expected == 0
                    || self.expected
                        > if kind == Kind::Image {
                            MAX_IMAGE
                        } else {
                            MAX_JSON
                        }
                {
                    return Err(Error::Invalid("binary frame exceeds limit"));
                }
                self.kind = Some(kind);
                self.payload = Vec::with_capacity(self.expected);
            }
            let count = (self.expected - self.payload.len()).min(bytes.len() - consumed);
            self.payload
                .extend_from_slice(&bytes[consumed..consumed + count]);
            consumed += count;
            if self.payload.len() < self.expected {
                break;
            }
            let Some(kind) = self.kind.take() else {
                return Err(Error::Invalid("missing binary frame type"));
            };
            let ready = accept(kind, &self.payload)?;
            self.header_len = 0;
            self.payload.clear();
            if !ready {
                return Ok(Progress {
                    consumed,
                    blocked: true,
                });
            }
        }
        Ok(Progress {
            consumed,
            blocked: false,
        })
    }
    pub fn finish(&self) -> Result<(), Error> {
        if self.failed || self.header_len != 0 || self.kind.is_some() {
            return Err(Error::Invalid("truncated binary frame"));
        }
        Ok(())
    }
}

// Legacy binary-cell fixtures remain diagnostic tests; the live broker admits JSON only.
#[cfg(test)]
pub(in crate::tmux_snapshot) mod cells;
#[cfg(test)]
mod tests;
