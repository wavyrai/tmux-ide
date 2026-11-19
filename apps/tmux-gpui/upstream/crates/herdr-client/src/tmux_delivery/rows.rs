//! History rows, oldest first, shared in chunks. A pane holds up to 10,000
//! history rows and a busy pane trims the oldest and appends new ones on
//! almost every patch, so a patch copies a few chunk handles, not a handle
//! per row, and the rows' digest fold, memory and width are kept up to date
//! as they change, so hashing and checking a snapshot visits only the rows
//! that changed.
use super::row::Row;
use std::{ops::Index, sync::Arc};

/// Rows per chunk.
const CHUNK: usize = 256;
type Chunk = Arc<[Arc<Row>]>;
const PRIME: u64 = 0x100000001b3;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Width {
    Empty,
    Uniform(usize),
    Mixed,
}
impl Width {
    fn with(self, row: &Row) -> Self {
        match self {
            Self::Empty => Self::Uniform(row.len()),
            Self::Uniform(w) if w == row.len() => self,
            _ => Self::Mixed,
        }
    }
}

#[derive(Clone, Debug)]
pub struct Rows {
    /// Every chunk but the last holds `CHUNK` rows.
    chunks: Arc<[Chunk]>,
    /// Rows at the start of the first chunk that were trimmed. They stay
    /// allocated until their whole chunk is trimmed: at most `CHUNK - 1`.
    skip: usize,
    len: usize,
    /// `fold(0, rows)`: `h -> h * PRIME + digest`, the rows digest.
    fold: u64,
    /// The rows' [`Row::heap_bytes`].
    bytes: usize,
    width: Width,
}
impl Default for Rows {
    fn default() -> Self {
        Self {
            chunks: Arc::new([]),
            skip: 0,
            len: 0,
            fold: 0,
            bytes: 0,
            width: Width::Empty,
        }
    }
}
impl PartialEq for Rows {
    /// The same rows by identity, in the same order.
    fn eq(&self, other: &Self) -> bool {
        self.len == other.len
            && self
                .iter()
                .zip(other.iter())
                .all(|(a, b)| Arc::ptr_eq(a, b))
    }
}
impl From<Vec<Arc<Row>>> for Rows {
    fn from(rows: Vec<Arc<Row>>) -> Self {
        Self::default().append(rows)
    }
}
impl Index<usize> for Rows {
    type Output = Arc<Row>;
    fn index(&self, index: usize) -> &Arc<Row> {
        match self.get(index) {
            Some(row) => row,
            None => panic!("row {index} of {}", self.len),
        }
    }
}
impl Rows {
    pub fn len(&self) -> usize {
        self.len
    }
    pub fn is_empty(&self) -> bool {
        self.len == 0
    }
    pub fn get(&self, index: usize) -> Option<&Arc<Row>> {
        if index >= self.len {
            return None;
        }
        let at = self.skip + index;
        self.chunks.get(at / CHUNK)?.get(at % CHUNK)
    }
    pub fn last(&self) -> Option<&Arc<Row>> {
        self.len.checked_sub(1).and_then(|i| self.get(i))
    }
    /// The rows from `start` on, oldest first.
    pub fn iter_from(
        &self,
        start: usize,
    ) -> impl DoubleEndedIterator<Item = &Arc<Row>> + Clone + '_ {
        let at = self.skip + start.min(self.len);
        let first = at / CHUNK;
        let (head, rest): (&[Arc<Row>], &[Chunk]) = match self.chunks.get(first) {
            Some(chunk) => (&chunk[at % CHUNK..], &self.chunks[first + 1..]),
            None => (&[], &[]),
        };
        head.iter()
            .chain(rest.iter().flat_map(|chunk| chunk.iter()))
    }
    pub fn iter(&self) -> impl DoubleEndedIterator<Item = &Arc<Row>> + Clone + '_ {
        self.iter_from(0)
    }
    pub fn to_vec(&self) -> Vec<Arc<Row>> {
        self.iter().cloned().collect()
    }
    /// The rows digest: `fold(0, rows)`.
    pub fn fold(&self) -> u64 {
        self.fold
    }
    /// The rows' memory, [`Row::heap_bytes`] summed.
    pub fn heap_bytes(&self) -> usize {
        self.bytes
    }
    /// Every row's cell count, when there are rows and they all agree.
    pub fn width(&self) -> Option<usize> {
        match self.width {
            Width::Uniform(w) => Some(w),
            Width::Empty | Width::Mixed => None,
        }
    }
    /// These rows without the oldest `trim` (at most `len`), then `append`.
    /// Copies chunk handles and the last chunk, and visits only the trimmed
    /// and appended rows.
    pub fn trim_append(&self, trim: usize, append: Vec<Arc<Row>>) -> Self {
        let trim = trim.min(self.len);
        let mut next = self.clone();
        if trim > 0 {
            let mut gone = 0u64;
            let mut bytes = 0usize;
            for row in self.iter().take(trim) {
                gone = gone.wrapping_mul(PRIME).wrapping_add(row.digest());
                bytes += row.heap_bytes();
            }
            let kept = self.len - trim;
            // fold(A ++ B) = fold(A) * PRIME^|B| + fold(B).
            next.fold = self.fold.wrapping_sub(gone.wrapping_mul(power(kept)));
            next.bytes = self.bytes - bytes;
            next.len = kept;
            let at = self.skip + trim;
            next.chunks = self.chunks[at / CHUNK..].into();
            next.skip = at % CHUNK;
            next.width = match self.width {
                _ if kept == 0 => Width::Empty,
                Width::Mixed => next.iter().fold(Width::Empty, |w, row| w.with(row)),
                width => width,
            };
            if kept == 0 {
                next.chunks = Arc::new([]);
                next.skip = 0;
            }
        }
        next.append(append)
    }
    fn append(mut self, rows: Vec<Arc<Row>>) -> Self {
        if rows.is_empty() {
            return self;
        }
        for row in &rows {
            self.fold = self.fold.wrapping_mul(PRIME).wrapping_add(row.digest());
            self.bytes = self.bytes.saturating_add(row.heap_bytes());
            self.width = self.width.with(row);
        }
        self.len += rows.len();
        let mut chunks: Vec<Chunk> = self.chunks.to_vec();
        let mut pending: Vec<Arc<Row>> = match chunks.pop() {
            // The first chunk may also be the last: keep its trimmed rows'
            // places, so every chunk but the last stays full.
            Some(last) if last.len() < CHUNK => last.to_vec(),
            Some(last) => {
                chunks.push(last);
                Vec::new()
            }
            None => Vec::new(),
        };
        for row in rows {
            pending.push(row);
            if pending.len() == CHUNK {
                chunks.push(std::mem::take(&mut pending).into());
            }
        }
        if !pending.is_empty() {
            chunks.push(pending.into());
        }
        self.chunks = chunks.into();
        self
    }
    /// `rows`, then these rows. Repacks every row (a history chunk on demand
    /// comes rarely and its rows are new).
    pub fn prepend(&self, rows: Vec<Arc<Row>>) -> Self {
        let mut all = rows;
        all.reserve(self.len);
        all.extend(self.iter().cloned());
        Self::from(all)
    }
    /// `self` with `row` appended, in place.
    pub fn push(&mut self, row: Arc<Row>) {
        *self = self.trim_append(0, vec![row]);
    }
}
/// `PRIME^n`, wrapping.
pub(super) fn power(mut n: usize) -> u64 {
    let (mut result, mut base) = (1u64, PRIME);
    while n > 0 {
        if n & 1 == 1 {
            result = result.wrapping_mul(base);
        }
        base = base.wrapping_mul(base);
        n >>= 1;
    }
    result
}

#[cfg(test)]
#[path = "rows_tests.rs"]
mod tests;
