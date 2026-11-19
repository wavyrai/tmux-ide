#![allow(clippy::unwrap_used)]
use super::*;

fn cell(grapheme: &str, width: u8, foreground: Color, attributes: u8) -> Cell {
    Cell {
        grapheme: grapheme.into(),
        width,
        foreground,
        background: Color::Default,
        attributes,
    }
}
fn cells(row: &Row) -> Vec<Cell> {
    row.cells().map(|c| c.to_cell()).collect()
}

/// Any cells come back as they went in, in order: graphemes of any length,
/// any width, every colour shape.
#[test]
fn a_row_gives_back_exactly_its_cells() {
    let graphemes = [
        "",
        " ",
        "a",
        "é",
        "界",
        "👩‍💻",
        "e\u{301}",
        "\u{10eeee}",
        "──",
    ];
    let colors = [
        Color::Default,
        Color::Indexed { index: 0 },
        Color::Indexed { index: 255 },
        Color::Rgb { value: 0 },
        Color::Rgb { value: 0xff_ffff },
    ];
    let mut state = 0x9e37_79b9_7f4a_7c15_u64;
    let mut next = move || {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        state as usize
    };
    for len in [1, 2, 3, 80, 200, 4096] {
        for _ in 0..20 {
            // Mostly repeated cells, so runs merge, and some of each kind.
            let mut input = Vec::new();
            while input.len() < len {
                let c = Cell {
                    grapheme: graphemes[next() % graphemes.len()].into(),
                    width: (next() % 4) as u8,
                    foreground: colors[next() % colors.len()],
                    background: colors[next() % colors.len()],
                    attributes: next() as u8,
                };
                let repeat = 1 + next() % 4;
                for _ in 0..repeat.min(len - input.len()) {
                    input.push(c.clone());
                }
            }
            let row = Row::new(input.clone(), len % 2 == 0);
            assert_eq!(row.len(), len);
            assert_eq!(row.cells().len(), len);
            assert_eq!(cells(&row), input);
            assert_eq!(row.wrapped(), len % 2 == 0);
        }
    }
}

/// Plain text costs one byte a character and one run a style: no per-cell
/// grapheme ends, and wide pairs (width 2, then an empty width 0) stay plain.
#[test]
fn plain_text_is_stored_as_text_and_style_runs() {
    let fixed = size_of::<Row>() + 2 * size_of::<usize>();
    let plain = Row::new(vec![cell("a", 1, Color::Default, 0); 80], false);
    assert!(plain.ends.is_none());
    assert_eq!(plain.runs.len(), 1);
    assert_eq!(plain.heap_bytes(), fixed + 80 + size_of::<Run>());
    assert_eq!(size_of::<Run>(), 12);

    let mut wide = vec![cell("x", 1, Color::Default, 0); 2];
    wide.push(cell("界", 2, Color::Default, 0));
    wide.push(cell("", 0, Color::Default, 0));
    let wide_row = Row::new(wide.clone(), false);
    assert!(wide_row.ends.is_none());
    assert_eq!(wide_row.runs.len(), 3);
    assert_eq!(cells(&wide_row), wide);

    // A style change starts a run; the same style again merges into it.
    let styled: Vec<_> = (0..80)
        .map(|i| {
            cell(
                "b",
                1,
                Color::Indexed {
                    index: (i / 8) as u8,
                },
                0,
            )
        })
        .collect();
    let styled_row = Row::new(styled.clone(), false);
    assert_eq!(styled_row.runs.len(), 10);
    assert_eq!(cells(&styled_row), styled);
}

/// A cell that is not one char (a combining sequence, an empty cell of width
/// 1) switches the row to grapheme ends, filled in for the cells before it.
#[test]
fn a_cell_that_is_not_one_char_keeps_every_grapheme_boundary() {
    let input = vec![
        cell("a", 1, Color::Default, 0),
        cell("界", 2, Color::Default, 0),
        cell("", 0, Color::Default, 0),
        cell("é", 1, Color::Default, 0),
        cell("e\u{301}", 1, Color::Default, 0),
        cell("", 1, Color::Default, 0),
        cell("z", 1, Color::Default, 0),
    ];
    let row = Row::new(input.clone(), false);
    assert_eq!(row.ends.as_deref(), Some(&[1, 4, 4, 6, 9, 9, 10][..]));
    assert_eq!(cells(&row), input);
    // Equal cells make equal rows, whichever way they were pushed.
    let mut builder = Builder::default();
    builder.push(1, "a", 1, &Color::Default, &Color::Default, 0);
    builder.push(1, "a", 1, &Color::Default, &Color::Default, 0);
    assert_eq!(
        builder.finish(false),
        Row::new(vec![cell("a", 1, Color::Default, 0); 2], false)
    );
}

#[test]
fn wide_cells_must_pair() {
    let paired = |widths: &[(usize, u8)]| {
        let mut builder = Builder::default();
        for (count, width) in widths {
            let grapheme = if *width == 0 { "" } else { "x" };
            builder.push(
                *count,
                grapheme,
                *width,
                &Color::Default,
                &Color::Default,
                0,
            );
        }
        builder.paired()
    };
    assert!(paired(&[(1, 1)]));
    assert!(paired(&[(1, 2), (1, 0)]));
    assert!(paired(&[(1, 1), (1, 2), (1, 0), (1, 2), (1, 0), (3, 1)]));
    assert!(!paired(&[(1, 2)]));
    assert!(!paired(&[(1, 1), (1, 2)]));
    assert!(!paired(&[(1, 0)]));
    assert!(!paired(&[(1, 1), (1, 0)]));
    assert!(!paired(&[(2, 2), (1, 0)]));
    assert!(!paired(&[(1, 2), (2, 0)]));
    assert!(!paired(&[(1, 2), (1, 1)]));
}
