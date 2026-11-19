#![allow(clippy::unwrap_used)]
use super::*;
use crate::tmux_delivery::types::{Cell, Color};

fn row(n: usize, cols: usize) -> Arc<Row> {
    Arc::new(Row::new(
        (0..cols)
            .map(|i| Cell {
                grapheme: if (n + i).is_multiple_of(5) {
                    "é".into()
                } else {
                    "a".into()
                },
                width: 1,
                foreground: Color::Indexed {
                    index: (n % 7) as u8,
                },
                background: Color::Default,
                attributes: 0,
            })
            .collect(),
        n.is_multiple_of(3),
    ))
}
/// `rows` as the model: a plain list, its fold, memory and width computed
/// from scratch.
fn check(rows: &Rows, model: &[Arc<Row>]) {
    assert_eq!(rows.len(), model.len());
    assert_eq!(rows.is_empty(), model.is_empty());
    for (i, expected) in model.iter().enumerate() {
        assert!(Arc::ptr_eq(&rows[i], expected), "row {i}");
    }
    assert!(rows.get(model.len()).is_none());
    match (rows.last(), model.last()) {
        (Some(a), Some(b)) => assert!(Arc::ptr_eq(a, b)),
        (a, b) => assert_eq!(a.is_none(), b.is_none()),
    }
    for start in [
        0,
        1,
        CHUNK - 1,
        CHUNK,
        CHUNK + 1,
        model.len() / 2,
        model.len(),
    ] {
        let start = start.min(model.len());
        let forward: Vec<_> = rows.iter_from(start).collect();
        assert_eq!(forward.len(), model.len() - start);
        assert!(
            forward
                .iter()
                .zip(&model[start..])
                .all(|(a, b)| Arc::ptr_eq(a, b))
        );
        let backward: Vec<_> = rows.iter_from(start).rev().collect();
        assert!(
            backward
                .iter()
                .zip(model[start..].iter().rev())
                .all(|(a, b)| Arc::ptr_eq(a, b))
        );
    }
    let fold = model
        .iter()
        .fold(0u64, |h, r| h.wrapping_mul(PRIME).wrapping_add(r.digest()));
    assert_eq!(rows.fold(), fold);
    assert_eq!(
        rows.heap_bytes(),
        model.iter().map(|r| r.heap_bytes()).sum::<usize>()
    );
    let width = model
        .first()
        .map(|r| r.len())
        .filter(|w| model.iter().all(|r| r.len() == *w));
    assert_eq!(rows.width(), width);
}

/// Trims and appends of every size around the chunk boundaries keep the
/// rows, their order, digest fold, memory and width exactly as a plain list.
#[test]
fn trims_appends_and_prepends_match_a_plain_list() {
    let mut state = 0x2545_f491_4f6c_dd1d_u64;
    let mut next = move |n: usize| {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        state as usize % n
    };
    let sizes = [
        0,
        1,
        2,
        CHUNK - 1,
        CHUNK,
        CHUNK + 1,
        2 * CHUNK,
        3 * CHUNK + 7,
    ];
    let mut counter = 0;
    let mut fresh = |count: usize, cols: usize| {
        (0..count)
            .map(|_| {
                counter += 1;
                row(counter, cols)
            })
            .collect::<Vec<_>>()
    };
    for _ in 0..40 {
        let mut rows = Rows::default();
        let mut model: Vec<Arc<Row>> = Vec::new();
        for _ in 0..30 {
            match next(4) {
                0 => {
                    let new = fresh(sizes[next(sizes.len())], 4);
                    model.splice(0..0, new.iter().cloned());
                    rows = rows.prepend(new);
                }
                1 => {
                    let new = fresh(1, 4);
                    model.extend(new.iter().cloned());
                    rows.push(new[0].clone());
                }
                _ => {
                    let trim = sizes[next(sizes.len())].min(model.len() + 1);
                    let new = fresh(sizes[next(sizes.len())], 4);
                    model.drain(..trim.min(model.len()));
                    model.extend(new.iter().cloned());
                    rows = rows.trim_append(trim, new);
                }
            }
            check(&rows, &model);
        }
        // Until 10,000 rows, the cap's size, with a busy pane's patches.
        let new = fresh(10_000 - model.len().min(10_000), 4);
        model.extend(new.iter().cloned());
        rows = rows.trim_append(0, new);
        for _ in 0..3 {
            let new = fresh(1 + next(3), 4);
            model.drain(..new.len());
            model.extend(new.iter().cloned());
            rows = rows.trim_append(new.len(), new);
        }
        check(&rows, &model);
    }
}

/// A trim or an append shares the untouched chunks; a trim never keeps more
/// than a chunk of trimmed rows allocated.
#[test]
fn a_patch_copies_chunk_handles_not_rows() {
    let all: Vec<_> = (0..10 * CHUNK).map(|n| row(n, 2)).collect();
    let rows = Rows::from(all.clone());
    let next = rows.trim_append(1, vec![row(99_999, 2)]);
    assert!(Arc::ptr_eq(&rows.chunks[1], &next.chunks[1]));
    assert!(Arc::ptr_eq(&rows.chunks[8], &next.chunks[8]));
    assert_eq!(next.chunks.len(), 11);
    let trimmed = rows.trim_append(CHUNK + 3, Vec::new());
    assert_eq!(trimmed.chunks.len(), 9);
    assert_eq!(trimmed.skip, 3);
    assert!(Arc::ptr_eq(&trimmed[0], &all[CHUNK + 3]));
    // Everything trimmed holds nothing.
    let empty = rows.trim_append(usize::MAX, Vec::new());
    assert_eq!(empty.chunks.len(), 0);
    assert_eq!(
        (empty.len(), empty.fold(), empty.heap_bytes(), empty.width()),
        (0, 0, 0, None)
    );
}

/// A width that differs makes the rows mixed; trimming the odd row away makes
/// them uniform again.
#[test]
fn mixed_widths_are_found_and_lost() {
    let rows = Rows::from(vec![row(1, 3), row(2, 4), row(3, 4)]);
    assert_eq!(rows.width(), None);
    assert_eq!(rows.trim_append(1, Vec::new()).width(), Some(4));
    assert_eq!(rows.trim_append(1, vec![row(4, 5)]).width(), None);
    assert_eq!(Rows::default().width(), None);
}
