//! The allocation-free row hash must feed FNV exactly the bytes the
//! string-building one did: digests are compared with the daemon's.
use super::*;
use std::time::Instant;

/// The row hash as it was before it stopped allocating, kept as the oracle.
fn reference_hash_row(cells: &[Cell], wrapped: bool) -> u64 {
    const PRIME: u64 = 0x100000001b3;
    let mut h = 0xcbf29ce484222325_u64;
    let mut text = |s: &str| {
        for v in s.as_bytes() {
            h = (h ^ u64::from(*v)).wrapping_mul(PRIME);
        }
    };
    let number = |n: u64| {
        let s = n.to_string();
        format!("d{}:{s};", s.len())
    };
    let string = |s: &str| format!("s{}:{s};", s.len());
    let color = |c: &Color| match c {
        Color::Default => "o1:s4:kind;s7:default;;".to_string(),
        Color::Indexed { index } => {
            format!(
                "o2:s5:index;{}s4:kind;s7:indexed;;",
                number(u64::from(*index))
            )
        }
        Color::Rgb { value } => {
            format!("o2:s4:kind;s3:rgb;s5:value;{};", number(u64::from(*value)))
        }
    };
    text("a2:");
    text(if wrapped { "b1;" } else { "b0;" });
    text(&format!("a{}:", cells.len()));
    for c in cells {
        text("a5:");
        text(&string(&c.grapheme));
        text(&number(u64::from(c.width)));
        text(&color(&c.foreground));
        text(&color(&c.background));
        text(&number(u64::from(c.attributes)));
        text(";");
    }
    text(";;");
    h
}

/// Deterministic rows covering every digit count each field can take.
fn corpus(rows: usize) -> Vec<(Vec<Cell>, bool)> {
    let graphemes = [
        "",
        " ",
        "a",
        "Z",
        "é",
        "界",
        "👩‍💻",
        "\u{10eeee}",
        "\\",
        ";",
        ":",
        "s1:",
        "d2:10;",
        "────────────",
        "🇳🇱",
    ];
    let numbers = [
        0, 1, 9, 10, 99, 100, 255, 999, 1000, 65_535, 1_000_000, 0xff_ffff,
    ];
    let mut state = 0x9e37_79b9_7f4a_7c15_u64;
    let mut next = move || {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        state
    };
    let color = |r: u64| match r % 3 {
        0 => Color::Default,
        1 => Color::Indexed {
            index: (r >> 8) as u8,
        },
        _ => Color::Rgb {
            value: numbers[(r >> 8) as usize % numbers.len()].min(0xff_ffff),
        },
    };
    (0..rows)
        .map(|row| {
            let width = [0, 1, 2, 9, 10, 99, 100, 101, 999, 1000, 1001][row % 11];
            let cells = (0..width)
                .map(|_| {
                    let r = next();
                    Cell {
                        grapheme: graphemes[r as usize % graphemes.len()].into(),
                        width: (r >> 4) as u8 % 3,
                        foreground: color(next()),
                        background: color(next()),
                        attributes: (r >> 16) as u8,
                    }
                })
                .collect();
            (cells, row % 2 == 0)
        })
        .collect()
}

#[test]
fn row_digests_are_byte_identical_to_the_string_building_hash() {
    let rows = corpus(2_000);
    let cells: usize = rows.iter().map(|(c, _)| c.len()).sum();
    assert!(cells > 500_000, "corpus too small: {cells} cells");
    for (index, (cells, wrapped)) in rows.iter().enumerate() {
        assert_eq!(
            hash::hash_row(cells, *wrapped),
            reference_hash_row(cells, *wrapped),
            "row {index}"
        );
    }
}

#[test]
fn every_colour_index_and_attribute_hashes_as_before() {
    for n in 0..=255_u8 {
        let cell = Cell {
            grapheme: "x".into(),
            width: n,
            foreground: Color::Indexed { index: n },
            background: Color::Rgb {
                value: u32::from(n) * 0x1_0101,
            },
            attributes: n,
        };
        let row = [cell];
        assert_eq!(hash::hash_row(&row, false), reference_hash_row(&row, false));
    }
}

/// Not run by CI: `cargo test --release -p herdr-client --lib row_hash_bench -- --ignored --nocapture`.
#[test]
#[ignore = "benchmark"]
fn row_hash_bench() {
    let rows = corpus(4_000);
    let cells: usize = rows.iter().map(|(c, _)| c.len()).sum();
    for _ in 0..5 {
        let start = Instant::now();
        for (c, w) in &rows {
            std::hint::black_box(reference_hash_row(c, *w));
        }
        let before = start.elapsed().as_nanos() as f64 / cells as f64;
        let start = Instant::now();
        for (c, w) in &rows {
            std::hint::black_box(hash::hash_row(c, *w));
        }
        let after = start.elapsed().as_nanos() as f64 / cells as f64;
        eprintln!(
            "row hash: string-building {before:.1} ns/cell, allocation-free {after:.1} ns/cell ({cells} cells)"
        );
    }
}
