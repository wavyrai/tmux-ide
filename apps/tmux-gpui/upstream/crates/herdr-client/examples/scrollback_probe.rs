//! Dev-only: the heap 10,000 history rows hold (dense coloured text, and a
//! colour per cell, at 80 and 200 columns) and the per-update CPU of the
//! store and the scrollback at a given history depth. Not run by CI.
//! `cargo run --release -p herdr-client --example scrollback_probe`
#![allow(clippy::unwrap_used, clippy::expect_used)]
use herdr_client::tmux_delivery::{Store, Update, decode_compact, hash_snapshot};
use herdr_client::tmux_history::{Scope, Scroll, Viewport};
use serde_json::{Value, json};
use std::{
    alloc::{GlobalAlloc, Layout, System},
    sync::{
        Arc,
        atomic::{AtomicIsize, Ordering::Relaxed},
    },
    time::Instant,
};
/// Counts the bytes allocated and not yet freed, then defers to the system.
struct Counting;
static LIVE: AtomicIsize = AtomicIsize::new(0);
// SAFETY: every method forwards its arguments unchanged to `System`, which
// upholds `GlobalAlloc`'s contract; the counter is a plain atomic.
#[allow(unsafe_code)] // A counting allocator must implement the unsafe trait.
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        LIVE.fetch_add(l.size() as isize, Relaxed);
        // SAFETY: the caller's contract for `alloc` is passed through.
        unsafe { System.alloc(l) }
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        LIVE.fetch_sub(l.size() as isize, Relaxed);
        // SAFETY: the caller's contract for `dealloc` is passed through.
        unsafe { System.dealloc(p, l) }
    }
    unsafe fn realloc(&self, p: *mut u8, l: Layout, n: usize) -> *mut u8 {
        LIVE.fetch_add(n as isize - l.size() as isize, Relaxed);
        // SAFETY: the caller's contract for `realloc` is passed through.
        unsafe { System.realloc(p, l, n) }
    }
}
#[global_allocator]
static A: Counting = Counting;

const WORDS: [&str; 20] = [
    "Compiling",
    "tmux-ide-gpui",
    "v0.1.16",
    "warning:",
    "unused",
    "variable",
    "`frame`",
    "-->",
    "src/lib.rs:42:9",
    "error[E0308]:",
    "mismatched",
    "types",
    "note:",
    "expected",
    "Finished",
    "release",
    "│",
    "─",
    "✓",
    "界",
];
fn color(c: u32) -> Value {
    match c >> 24 {
        0 => json!(0),
        1 => json!([1, c & 0xff]),
        _ => json!([2, c & 0xffffff]),
    }
}
/// One wire row: dense coloured words (as the perf bench), or every cell its
/// own colour (`rainbow`).
fn wire_row(n: usize, cols: usize, rainbow: bool) -> Value {
    let mut cells: Vec<(String, u8, u32, u8)> = Vec::new();
    let mut word = 0;
    while cells.len() < cols {
        let text = WORDS[(n * 7 + word) % WORDS.len()];
        word += 1;
        let fg = match word {
            w if w % 3 == 0 => 0x0100_0000 | ((n + w) % 16) as u32,
            w if w % 5 == 0 => 0x0240_a0ff,
            _ => 0,
        };
        let attrs = u8::from(word % 7 == 0);
        for ch in text.chars().chain(std::iter::once(' ')) {
            let wide = unicode_width(ch);
            if cells.len() + wide > cols {
                break;
            }
            let fg = if rainbow {
                0x0200_0000 | ((n * 131 + cells.len() * 7919) as u32 & 0xffffff)
            } else {
                fg
            };
            cells.push((ch.to_string(), wide as u8, fg, attrs));
            if wide == 2 {
                cells.push((String::new(), 0, fg, attrs));
            }
        }
        if word > 1000 {
            break;
        }
    }
    while cells.len() < cols {
        cells.push((" ".into(), 1, 0, 0));
    }
    let mut runs: Vec<Value> = Vec::new();
    let mut i = 0;
    while i < cells.len() {
        let mut j = i + 1;
        while j < cells.len() && cells[j] == cells[i] {
            j += 1;
        }
        let (g, w, fg, a) = &cells[i];
        runs.push(json!([j - i, g, w, color(*fg), 0, a]));
        i = j;
    }
    json!([0, runs])
}
fn unicode_width(ch: char) -> usize {
    if ch == '界' { 2 } else { 1 }
}
fn seed(cols: usize, rows: usize, history: &[Value], revision: u64) -> Vec<u8> {
    let grid: Vec<Value> = (0..rows)
        .map(|i| wire_row(100_000 + i, cols, false))
        .collect();
    serde_json::to_vec(&json!({"v":1,"k":"terminal-semantic-compact","f":"s","r":revision,
        "s":[cols,rows,grid,history,[0,0,0,"block",0],[0,0,0,0,0,0,1,0,null,null,0],[],["authoritative-stream","observed-from-start"]]})).unwrap()
}
fn snapshot(bytes: &[u8]) -> herdr_client::tmux_delivery::Snapshot {
    match decode_compact(bytes).unwrap() {
        Update::Seed { snapshot, .. } => snapshot,
        _ => panic!("seed"),
    }
}
/// Heap held by `count` history rows at `cols`, decoded as the app decodes them.
fn memory(cols: usize, count: usize, rainbow: bool) -> isize {
    let chunk = (900_000 / cols).clamp(1, 1000);
    let mut held = Vec::new();
    let before = LIVE.load(Relaxed);
    let mut n = 0;
    while n < count {
        let take = chunk.min(count - n);
        let history: Vec<Value> = (n..n + take).map(|i| wire_row(i, cols, rainbow)).collect();
        let bytes = seed(cols, 1, &history, 0);
        drop(history);
        let s = snapshot(&bytes);
        drop(bytes);
        held.extend(s.history.materialized().unwrap().iter().cloned());
        n += take;
    }
    held.shrink_to_fit();
    let after = LIVE.load(Relaxed);
    std::hint::black_box(&held);
    after - before
}
fn time<T>(n: usize, mut f: impl FnMut() -> T) -> f64 {
    let mut v = Vec::with_capacity(n);
    for _ in 0..n {
        let t = Instant::now();
        std::hint::black_box(f());
        v.push(t.elapsed().as_secs_f64() * 1e6);
    }
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v[n / 2]
}
fn scope() -> Scope {
    Scope {
        lifetime: 1,
        workspace_name: "w".into(),
        pane: "p".into(),
        generation: "g".into(),
        incarnation: "i".into(),
    }
}
fn speed(cols: usize, rows: usize, depth: usize) {
    let history: Vec<Value> = (0..depth).map(|i| wire_row(i, cols, false)).collect();
    let bytes = seed(cols, rows, &history, 1);
    let s = snapshot(&bytes);
    let hash = hash_snapshot(&s);
    let mut store = Store::default();
    store
        .apply(
            Update::Seed {
                revision: 1,
                snapshot: s,
            },
            &hash,
        )
        .unwrap();
    let base = store.snapshot().unwrap().clone();
    // A busy pane at its history limit: one new history row, the oldest
    // trimmed, the bottom grid row rewritten.
    let patch = serde_json::to_vec(&json!({"v":1,"k":"terminal-semantic-compact","f":"p","b":1,"r":2,
        "p":[null,[[rows-1, wire_row(7, cols, false)]],null,[1,[wire_row(8, cols, false)]],null,null,null,null]})).unwrap();
    let apply = time(200, || {
        let u = decode_compact(&patch).unwrap();
        // The hash differs, so the store stays at revision 1: all the work but the publish.
        store.apply(u, "0000000000000000").is_err()
    });
    let mut shifted = (*base).clone();
    let h = shifted.history.materialized_mut().unwrap();
    *h = h.trim_append(1, vec![base.grid[0].clone()]);
    let shifted = Arc::new(shifted);
    let mut v = Viewport::default();
    v.update(scope(), base.clone());
    let mut flip = false;
    let update = time(200, || {
        flip = !flip;
        v.update(scope(), if flip { shifted.clone() } else { base.clone() });
    });
    let shown = v.history_len();
    let home = time(200, || {
        v.scroll(Scroll::End);
        v.scroll(Scroll::Home);
        v.view().unwrap().grid.len()
    });
    let wheel = time(200, || {
        v.scroll(Scroll::Wheel(3));
        v.view().unwrap().grid.len()
    });
    println!(
        "speed cols={cols} depth={depth}: scrollback shows {shown} rows; patch apply p50 {apply:.1} us; viewport update p50 {update:.1} us; scroll Home+view p50 {home:.1} us; wheel+view p50 {wheel:.1} us"
    );
}
fn main() {
    for (cols, rainbow) in [(80, false), (200, false), (80, true), (200, true)] {
        let count = 10_000;
        let bytes = memory(cols, count, rainbow);
        println!(
            "memory cols={cols} {}: {count} rows hold {:.2} MiB, {} B/row; 40 panes {:.0} MiB",
            if rainbow { "rainbow" } else { "dense" },
            bytes as f64 / 1048576.0,
            bytes / count as isize,
            40.0 * bytes as f64 / 1048576.0
        );
    }
    for (cols, depth) in [(80, 1000), (80, 2000), (80, 9900), (200, 3000)] {
        speed(cols, 50, depth);
    }
}
