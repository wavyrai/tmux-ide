use super::types::*;
use serde_json::{Value, json};
const PRIME: u64 = 0x100000001b3;
struct Fnv(u64);
impl Fnv {
    fn new() -> Self {
        Self(0xcbf29ce484222325)
    }
    fn bytes(&mut self, b: &[u8]) {
        for v in b {
            self.0 = (self.0 ^ u64::from(*v)).wrapping_mul(PRIME);
        }
    }
    fn text(&mut self, s: &str) {
        self.bytes(s.as_bytes());
    }
    fn string(&mut self, s: &str) {
        self.text(&format!("s{}:", s.len()));
        self.text(s);
        self.text(";");
    }
    fn number(&mut self, n: u64) {
        let s = n.to_string();
        self.text(&format!("d{}:{s};", s.len()));
    }
    fn boolean(&mut self, b: bool) {
        self.text(if b { "b1;" } else { "b0;" });
    }
    fn value(&mut self, v: &Value) {
        match v {
            Value::Null => self.text("n;"),
            Value::Bool(b) => self.boolean(*b),
            Value::Number(n) => {
                let s = n.to_string();
                self.text(&format!("d{}:{s};", s.len()));
            }
            Value::String(s) => self.string(s),
            Value::Array(a) => {
                self.text(&format!("a{}:", a.len()));
                for v in a {
                    self.value(v);
                }
                self.text(";");
            }
            Value::Object(o) => {
                self.text(&format!("o{}:", o.len()));
                let mut keys: Vec<_> = o.keys().collect();
                keys.sort();
                for k in keys {
                    self.string(k);
                    self.value(&o[k]);
                }
                self.text(";");
            }
        }
    }
    fn color(&mut self, c: &Color) {
        match c {
            Color::Default => self.text("o1:s4:kind;s7:default;;"),
            Color::Indexed { index } => {
                self.text("o2:s5:index;");
                self.number(u64::from(*index));
                self.text("s4:kind;s7:indexed;;");
            }
            Color::Rgb { value } => {
                self.text("o2:s4:kind;s3:rgb;s5:value;");
                self.number(u64::from(*value));
                self.text(";");
            }
        }
    }
}
pub(super) fn hash_row(cells: &[Cell], wrapped: bool) -> u64 {
    let mut h = Fnv::new();
    h.text("a2:");
    h.boolean(wrapped);
    h.text(&format!("a{}:", cells.len()));
    for c in cells {
        h.text("a5:");
        h.string(&c.grapheme);
        h.number(u64::from(c.width));
        h.color(&c.foreground);
        h.color(&c.background);
        h.number(u64::from(c.attributes));
        h.text(";");
    }
    h.text(";;");
    h.0
}
pub(super) fn rows_hash(rows: &[std::sync::Arc<Row>]) -> String {
    let hash = rows
        .iter()
        .fold(0u64, |h, r| h.wrapping_mul(PRIME).wrapping_add(r.digest()));
    format!("{hash:016x}")
}
/// Only cached row digests and small metadata are visited, never retained cells.
pub fn hash_snapshot(s: &Snapshot) -> String {
    let v = json!([
        "terminal-replica-v1",
        s.cols,
        s.rows,
        rows_hash(&s.grid),
        match &s.history {
            History::Complete(rows) => rows_hash(rows),
            History::Deferred(h) => h.digest.clone(),
        },
        s.cursor,
        s.modes,
        s.placements,
        s.bootstrap
    ]);
    let mut h = Fnv::new();
    h.value(&v);
    format!("{:016x}", h.0)
}
pub fn hash_tombstone(reason: &str) -> String {
    let mut h = Fnv::new();
    h.value(&json!(["tombstone", reason]));
    format!("{:016x}", h.0)
}
pub fn hash_representation(bytes: &[u8]) -> String {
    let (mut high, mut low) = (0x811c9dc5u32, 0x9e3779b9u32);
    for b in bytes {
        high = (high ^ u32::from(*b)).wrapping_mul(0x01000193);
        low = (low ^ u32::from(*b)).wrapping_mul(0x85ebca6b);
    }
    format!("{high:08x}{low:08x}")
}

pub fn hash_projection(s: &Snapshot) -> super::Result<String> {
    let History::Deferred(history) = &s.history else {
        return Err(super::Error::Invalid("projection history"));
    };
    let value = json!([
        "terminal-projection-v1",
        s.cols,
        s.rows,
        rows_hash(&s.grid),
        s.cursor,
        s.modes,
        s.placements,
        s.bootstrap,
        [history.rows, history.digest]
    ]);
    let mut hash = Fnv::new();
    hash.value(&value);
    Ok(format!("{:016x}", hash.0))
}

pub fn hash_projection_tombstone(reason: &str) -> String {
    let mut hash = Fnv::new();
    hash.value(&json!(["terminal-projection-tombstone-v1", reason]));
    format!("{:016x}", hash.0)
}
