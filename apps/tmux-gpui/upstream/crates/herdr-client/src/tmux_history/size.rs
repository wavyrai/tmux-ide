use crate::tmux_delivery::{Cell, Row};
use serde::Serialize;
use std::{
    collections::HashMap,
    io,
    sync::{Arc, Weak},
};
#[derive(Default)]
pub(super) struct Sizes(HashMap<usize, (Weak<Row>, usize)>);
impl Sizes {
    pub fn row(&mut self, row: &Arc<Row>) -> usize {
        let key = Arc::as_ptr(row) as usize;
        if let Some((weak, size)) = self.0.get(&key)
            && weak.ptr_eq(&Arc::downgrade(row))
            && weak.strong_count() != 0
        {
            return *size;
        }
        let size = row_size(row);
        if self.0.len() >= 4000 {
            self.0.clear();
        }
        self.0.insert(key, (Arc::downgrade(row), size));
        size
    }
    pub fn prune(&mut self) {
        self.0.retain(|_, (row, _)| row.strong_count() > 0);
    }
}
#[derive(Serialize)]
struct JsonCell<'a> {
    grapheme: &'a str,
    width: u8,
    foreground: &'a crate::tmux_delivery::Color,
    background: &'a crate::tmux_delivery::Color,
    attributes: u8,
}
impl<'a> From<&'a Cell> for JsonCell<'a> {
    fn from(c: &'a Cell) -> Self {
        Self {
            grapheme: &c.grapheme,
            width: c.width,
            foreground: &c.foreground,
            background: &c.background,
            attributes: c.attributes,
        }
    }
}
#[derive(Default)]
struct Count(usize);
impl io::Write for Count {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0 = self.0.saturating_add(bytes.len());
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
/// Exact UTF-8 legacy JSON byte budget, without allocating serialized strings.
fn row_size(row: &Row) -> usize {
    let mut n = Count::default();
    for cell in row.cells() {
        if serde_json::to_writer(&mut n, &JsonCell::from(cell)).is_err() {
            return usize::MAX;
        }
    }
    n.0.saturating_add(if row.wrapped() { 27 } else { 28 })
        .saturating_add(row.cells().len().saturating_sub(1))
}
