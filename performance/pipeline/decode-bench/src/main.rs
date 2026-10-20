//! GUI-side decode cost of one bridge publication, three ways:
//!  - `value+reencode+typed`: the 2.9.7 path (publication -> serde_json::Value,
//!    snapshot re-serialized, then decoded into typed rows; see stream.rs/browser.rs)
//!  - `raw+typed`: decode once through RawValue (the pane-latency branch)
//!  - `binary`: the run-length binary prototype written by encoding-sim.mjs
//! Every path ends in the same painter-shaped Vec<Cell> (one String per cell,
//! like herdr_client::protocol::CellData), so the numbers compare like for like.
//!
//! usage: pipeline-decode-bench PUBLICATION.json [FRAME.bin] [ITERATIONS]
use serde::Deserialize;
use serde_json::value::RawValue;
use std::time::Instant;

#[allow(dead_code)]
struct Cell {
    symbol: String,
    fg: u32,
    bg: u32,
    modifier: u16,
    skip: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Snapshot {
    cols: u16,
    rows: u16,
    grid: Vec<Row>,
    history: Vec<Row>,
    #[allow(dead_code)]
    cursor: serde::de::IgnoredAny,
    #[allow(dead_code)]
    modes: serde::de::IgnoredAny,
    #[allow(dead_code)]
    placements: serde::de::IgnoredAny,
    #[allow(dead_code)]
    bootstrap: serde::de::IgnoredAny,
}
#[derive(Deserialize)]
struct Row {
    cells: Vec<JsonCell>,
    #[allow(dead_code)]
    wrapped: bool,
}
#[derive(Deserialize)]
struct JsonCell {
    grapheme: String,
    width: u8,
    foreground: Color,
    background: Color,
    attributes: u8,
}
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum Color {
    Default,
    Indexed { index: u8 },
    Rgb { value: u32 },
}
impl Color {
    fn encoded(&self) -> u32 {
        match *self {
            Self::Default => 0,
            Self::Indexed { index } => 0x0100_0000 | u32::from(index),
            Self::Rgb { value } => 0x0200_0000 | value,
        }
    }
}

#[derive(Deserialize)]
struct ValuePublication {
    snapshot: Option<serde_json::Value>,
}
#[derive(Deserialize)]
struct RawPublication<'a> {
    #[serde(borrow)]
    snapshot: Option<&'a RawValue>,
}

fn cells_from(snapshot: Snapshot) -> Vec<Cell> {
    assert_eq!(snapshot.grid.len(), usize::from(snapshot.rows));
    let mut out = Vec::with_capacity(usize::from(snapshot.cols) * usize::from(snapshot.rows));
    for row in snapshot.grid.into_iter().chain(snapshot.history) {
        for c in row.cells {
            if c.grapheme.chars().any(char::is_control) {
                panic!("control");
            }
            out.push(Cell {
                symbol: c.grapheme,
                fg: c.foreground.encoded(),
                bg: c.background.encoded(),
                modifier: u16::from(c.attributes),
                skip: c.width == 0,
            });
        }
    }
    out
}

fn value_path(line: &[u8]) -> usize {
    let p: ValuePublication = serde_json::from_slice(line).unwrap();
    let v = p.snapshot.unwrap();
    // pointer_modes() clones the modes subtree; included for fidelity.
    let _modes = v["modes"].clone();
    let bytes = serde_json::to_vec(&v).unwrap();
    let s: Snapshot = serde_json::from_slice(&bytes).unwrap();
    cells_from(s).len()
}

fn raw_path(line: &[u8]) -> usize {
    let p: RawPublication = serde_json::from_slice(line).unwrap();
    let s: Snapshot = serde_json::from_str(p.snapshot.unwrap().get()).unwrap();
    cells_from(s).len()
}

fn binary_path(frame: &[u8]) -> usize {
    let u16at = |o: usize| u16::from_le_bytes([frame[o], frame[o + 1]]);
    let u32at = |o: usize| u32::from_le_bytes([frame[o], frame[o + 1], frame[o + 2], frame[o + 3]]);
    let rows = usize::from(u16at(4));
    let mut o = 6;
    let mut out: Vec<Cell> = Vec::with_capacity(rows * 256);
    for _ in 0..rows {
        let _index = u16at(o);
        let runs = u16at(o + 2);
        o += 4;
        for _ in 0..runs {
            let repeat = u16at(o);
            let width = frame[o + 2];
            let attrs = frame[o + 3];
            let fg = u32at(o + 4);
            let bg = u32at(o + 8);
            let len = usize::from(frame[o + 12]);
            let symbol = std::str::from_utf8(&frame[o + 13..o + 13 + len]).unwrap();
            if symbol.chars().any(char::is_control) {
                panic!("control");
            }
            o += 13 + len;
            for _ in 0..repeat {
                out.push(Cell { symbol: symbol.to_owned(), fg, bg, modifier: u16::from(attrs), skip: width == 0 });
            }
        }
    }
    out.len()
}

fn bench(name: &str, iterations: usize, bytes: usize, mut f: impl FnMut() -> usize) {
    let cells = f();
    let mut times: Vec<f64> = (0..iterations)
        .map(|_| {
            let t = Instant::now();
            std::hint::black_box(f());
            t.elapsed().as_secs_f64() * 1e3
        })
        .collect();
    times.sort_by(|a, b| a.partial_cmp(b).unwrap());
    println!(
        "{name:24} {:>9} bytes {cells:>7} cells  p50 {:>7.2} ms  p90 {:>7.2} ms",
        bytes,
        times[times.len() / 2],
        times[times.len() * 9 / 10]
    );
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let line = std::fs::read(&args[1]).unwrap();
    let line = line.strip_suffix(b"\n").unwrap_or(&line).to_vec();
    let iterations = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(50);
    bench("value+reencode+typed", iterations, line.len(), || value_path(&line));
    bench("raw+typed", iterations, line.len(), || raw_path(&line));
    if let Some(path) = args.get(2) {
        let frame = std::fs::read(path).unwrap();
        bench("binary RLE", iterations, frame.len(), || binary_path(&frame));
    }
}
