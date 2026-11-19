//! The bounds on what a snapshot may hold: 10,000 history rows at any width
//! up to the row and memory caps, paged in by history on demand.
use super::*;
use crate::tmux_history::{MAX_ROWS, Scope, Scroll, Viewport};

fn row(text: &str, cols: usize) -> Arc<Row> {
    Arc::new(Row::new(
        vec![
            Cell {
                grapheme: text.into(),
                width: 1,
                foreground: Color::Indexed { index: 2 },
                background: Color::Default,
                attributes: 0,
            };
            cols
        ],
        false,
    ))
}
/// A one-row screen of `cols` columns with `history`.
fn snapshot(cols: usize, history: Vec<Arc<Row>>) -> Snapshot {
    let wire = json!({"v":1,"k":"terminal-semantic-compact","f":"s","r":0,
        "s":[cols,1,[[0,[[cols," ",1,0,0,0]]]],[],[0,0,0,"block",0],[0,0,0,0,0,0,1,0,null,null,0],[],["authoritative-stream","observed-from-start"]]});
    let Update::Seed { mut snapshot, .. } =
        decode_compact(&serde_json::to_vec(&wire).unwrap()).unwrap()
    else {
        panic!("seed")
    };
    snapshot.history = History::from(history);
    snapshot
}

/// 10,000 rows at 200 columns are 2,000,000 cells, past the old 1,000,000
/// cell bound: they are accepted, as is `MAX_HISTORY_ROWS`, and one more row
/// is refused.
#[test]
fn history_rows_are_bounded_by_count_not_cells() {
    let wide = row("x", 200);
    assert!(store::validate(&snapshot(200, vec![wide; MAX_ROWS])).is_ok());
    let narrow = row("x", 1);
    assert!(store::validate(&snapshot(1, vec![narrow.clone(); MAX_HISTORY_ROWS])).is_ok());
    assert!(matches!(
        store::validate(&snapshot(1, vec![narrow.clone(); MAX_HISTORY_ROWS + 1])),
        Err(Error::Invalid("snapshot bounds"))
    ));
    // The loaded rows of a partial history alike.
    for (loaded, accepted) in [(MAX_HISTORY_ROWS, true), (MAX_HISTORY_ROWS + 1, false)] {
        let mut s = snapshot(1, Vec::new());
        s.history = History::Partial(PartialHistory {
            unloaded: DeferredHistory {
                rows: 1,
                digest: "0123456789abcdef".into(),
            },
            loaded: vec![narrow.clone(); loaded].into(),
        });
        assert_eq!(store::validate(&s).is_ok(), accepted, "{loaded} loaded");
    }
}

/// Row memory up to exactly `MAX_ROW_BYTES`, the screen's rows included, is
/// accepted; one more row is refused.
#[test]
fn row_memory_is_bounded_exactly() {
    let fixed = row("a", 1).heap_bytes() - 1;
    let cols = 4096 - fixed;
    let fat = row("a", cols);
    assert_eq!(fat.heap_bytes(), 4096);
    let mut s = snapshot(cols, Vec::new());
    s.grid = vec![fat.clone()];
    let fit = MAX_ROW_BYTES / 4096 - 1;
    assert!(fit < MAX_HISTORY_ROWS);
    s.history = History::from(vec![fat.clone(); fit]);
    assert!(store::validate(&s).is_ok());
    s.history = History::from(vec![fat; fit + 1]);
    assert!(matches!(
        store::validate(&s),
        Err(Error::Invalid("snapshot bounds"))
    ));
}

/// A history row of another width is refused, whether it came with the seed
/// or was appended by a patch.
#[test]
fn every_history_row_has_the_screen_width() {
    let s = snapshot(4, vec![row("a", 4), row("b", 5), row("c", 4)]);
    assert!(matches!(
        store::validate(&s),
        Err(Error::Invalid("snapshot row width"))
    ));
    let s = snapshot(4, vec![row("a", 4), row("b", 4)]);
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
    for (trim, width, accepted) in [(0, 5, false), (1, 3, false), (1, 4, true)] {
        let mut next = Snapshot::clone(store.snapshot().unwrap());
        let history = next.history.materialized().unwrap();
        next.history = History::Complete(history.trim_append(trim, vec![row("z", width)]));
        let patch = Patch {
            dimensions: None,
            rows: Vec::new(),
            history: None,
            history_delta: Some((trim, vec![row("z", width)])),
            cursor: None,
            modes: None,
            placements: None,
            bootstrap: None,
        };
        let revision = store.revision().unwrap();
        // The hash of the snapshot the patch makes, so only the bounds refuse.
        let result = store.apply(
            Update::Patch {
                base_revision: revision,
                revision: revision + 1,
                patch,
            },
            &hash_snapshot(&next),
        );
        assert_eq!(result.is_ok(), accepted, "trim {trim} width {width}");
    }
}

/// History on demand pages a 10,000-row history in from its 200-row tail,
/// 2000 rows at a time, until nothing is unloaded; the hash stays the whole
/// history's, and the scrollback scrolls to its oldest row.
#[test]
fn a_ten_thousand_row_history_pages_in_and_scrolls_to_its_top() {
    // A row each, so identity proves the order.
    let all: Vec<_> = (0..MAX_ROWS)
        .map(|i| row(&(i % 10).to_string(), 80))
        .collect();
    let whole = snapshot(80, all.clone());
    let hash = hash_snapshot(&whole);
    let commitment = |rows: usize| DeferredHistory {
        rows,
        digest: hash::concat_rows_hash("0000000000000000", &all[..rows]).unwrap(),
    };
    let mut seed = whole.clone();
    seed.history = History::from(all[MAX_ROWS - 200..].to_vec());
    let mut store = Store::default();
    store
        .apply_with(
            Update::Seed {
                revision: 3,
                snapshot: seed,
            },
            &hash,
            Some(commitment(MAX_ROWS - 200)),
        )
        .unwrap();
    let mut unloaded = MAX_ROWS - 200;
    let mut frames = 0;
    while unloaded > 0 {
        let take = unloaded.min(2000);
        let rows = all[unloaded - take..unloaded].to_vec();
        unloaded -= take;
        store
            .apply_with(
                Update::History { revision: 3, rows },
                &hash,
                Some(commitment(unloaded)),
            )
            .unwrap();
        frames += 1;
    }
    assert_eq!(frames, 5);
    let s = store.snapshot().unwrap().clone();
    assert!(s.history.is_complete());
    let held = s.history.materialized().unwrap();
    assert_eq!(held.len(), MAX_ROWS);
    assert!(held.iter().zip(&all).all(|(a, b)| Arc::ptr_eq(a, b)));
    let mut viewport = Viewport::default();
    viewport.update(
        Scope {
            lifetime: 1,
            workspace_name: "w".into(),
            pane: "p".into(),
            generation: "g".into(),
            incarnation: "i".into(),
        },
        s,
    );
    assert_eq!(viewport.history_len(), MAX_ROWS);
    viewport.scroll(Scroll::Home);
    assert!(Arc::ptr_eq(&viewport.view().unwrap().grid[0], &all[0]));
    assert_eq!(viewport.capture_index(), Some(0));
}

/// The screen is at most 1,000,000 cells, as before.
#[test]
fn the_screen_is_bounded_by_cells() {
    let wide = row(" ", 4096);
    for (rows, accepted) in [(244, true), (245, false)] {
        let mut s = snapshot(4096, Vec::new());
        s.rows = rows;
        s.grid = vec![wide.clone(); rows];
        assert_eq!(store::validate(&s).is_ok(), accepted, "{rows} rows");
    }
}
