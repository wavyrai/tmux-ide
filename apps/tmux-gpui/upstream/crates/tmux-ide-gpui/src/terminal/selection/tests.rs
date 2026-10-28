use super::*;
use crate::error::Error;
use herdr_client::protocol::{
    CellData, ClientShellPopupSurface, FrameData, PaneSurfacePane, SurfaceRect,
};

const CELL_WIDTH: f32 = 10.;
const CELL_HEIGHT: f32 = 20.;

fn frame(text: &str, width: u16, height: u16) -> FrameData {
    let mut symbols = text.chars();
    FrameData {
        width,
        height,
        cells: (0..usize::from(width) * usize::from(height))
            .map(|_| CellData {
                symbol: symbols.next().unwrap_or(' ').to_string(),
                fg: 0,
                bg: 0,
                modifier: 0,
                skip: false,
                hyperlink: None,
            })
            .collect(),
        cursor: None,
        hyperlinks: vec![],
        graphics: vec![],
    }
}

fn surface(text: &str) -> PaneSurfaceFrame {
    let rect = SurfaceRect {
        x: 0,
        y: 0,
        width: 10,
        height: 3,
    };
    PaneSurfaceFrame {
        boot_id: "boot".into(),
        projection_revision: 1,
        surface_revision: 1,
        frame: frame(text, 10, 3),
        splits: vec![],
        popup: None,
        graphics: Default::default(),
        panes: vec![PaneSurfacePane {
            pane_id: "pane".into(),
            content_revision: 1,
            rect,
            inner_rect: rect,
            scrollbar_rect: None,
            scroll: None,
            focused: true,
            mouse_reporting: false,
            sgr_pixel_mouse: false,
            alternate_screen_active: false,
            pixel_width: 100,
            pixel_height: 60,
        }],
    }
}

fn drag(surface: &PaneSurfaceFrame, from: (f32, f32), to: (f32, f32)) -> Selection {
    let mut selection =
        Selection::begin(surface, from.0, from.1, CELL_WIDTH, CELL_HEIGHT, 1).unwrap();
    selection.extend(surface, to.0, to.1, CELL_WIDTH, CELL_HEIGHT);
    selection
}

fn text(surface: &PaneSurfaceFrame, selection: &Selection) -> String {
    selection.text(surface, CELL_WIDTH, CELL_HEIGHT).unwrap()
}

#[test]
fn a_press_without_a_drag_selects_nothing_and_half_a_cell_selects_it() {
    let s = surface("abcdefghij");
    for (from, to) in [
        ((1., 1.), (1., 1.)),
        ((1., 1.), (4., 9.)),
        ((6., 1.), (9., 19.)),
    ] {
        let selection = drag(&s, from, to);
        assert_eq!(selection.rows(&s, CELL_WIDTH, CELL_HEIGHT).count(), 0);
        assert_eq!(text(&s, &selection), "");
    }
    // Crossing the middle of the first cell takes that cell, whichever way
    // the drag was made.
    for (from, to) in [((1., 1.), (6., 1.)), ((6., 1.), (1., 1.))] {
        let selection = drag(&s, from, to);
        assert_eq!(
            selection
                .rows(&s, CELL_WIDTH, CELL_HEIGHT)
                .collect::<Vec<_>>(),
            vec![(0, 0..1)]
        );
        assert_eq!(text(&s, &selection), "a");
    }
    assert_eq!(text(&s, &drag(&s, (1., 1.), (26., 1.))), "abc");
    assert_eq!(text(&s, &drag(&s, (26., 1.), (1., 1.))), "abc");
}

#[test]
fn multi_row_selections_span_the_region_and_trim_only_padded_rows() {
    let mut s = surface("hi");
    for (index, symbol) in [(10, "x"), (11, "y"), (12, "z")] {
        s.frame.cells[index].symbol = symbol.into();
    }
    // Rows carried through to the right edge lose the terminal's padding;
    // the row where the pointer stopped keeps the blanks it selected.
    assert_eq!(text(&s, &drag(&s, (1., 1.), (36., 21.))), "hi\nxyz ");
    assert_eq!(
        drag(&s, (1., 1.), (36., 21.))
            .rows(&s, CELL_WIDTH, CELL_HEIGHT)
            .collect::<Vec<_>>(),
        vec![(0, 0..10), (1, 0..4)]
    );
    // A blank row was still selected, so it is still copied.
    assert_eq!(text(&s, &drag(&s, (1., 1.), (96., 41.))), "hi\nxyz\n");
    // Dragging above or below the region reaches its first and last cell.
    assert_eq!(text(&s, &drag(&s, (1., 1.), (36., 1e6))), "hi\nxyz\n");
    assert_eq!(text(&s, &drag(&s, (36., 21.), (1., -1e6))), "hi\nxyz ");
    // Dragging past a side clamps to the row's own bounds, not the next row.
    assert_eq!(text(&s, &drag(&s, (1., 1.), (1e6, 1.))), "hi");
    assert_eq!(text(&s, &drag(&s, (96., 21.), (-1e6, 21.))), "xyz");
}

#[test]
fn selections_stay_inside_the_pane_that_owns_them() {
    let mut s = surface("abcdefghij");
    let mut right = s.panes[0].clone();
    right.pane_id = "right".into();
    right.rect.x = 5;
    right.inner_rect.x = 5;
    right.inner_rect.width = 5;
    s.panes[0].inner_rect.width = 5;
    s.panes.push(right);
    // A drag that leaves the pane stops at its edge instead of reading the
    // neighbor's cells out of the shared composite frame.
    let selection = drag(&s, (1., 1.), (1e6, 1.));
    assert_eq!(text(&s, &selection), "abcde");
    let selection = drag(&s, (51., 1.), (1e6, 41.));
    assert_eq!(
        selection
            .rows(&s, CELL_WIDTH, CELL_HEIGHT)
            .collect::<Vec<_>>(),
        vec![(0, 5..10), (1, 5..10), (2, 5..10)]
    );
    // The two blank rows below were selected too, so they are copied.
    assert_eq!(text(&s, &selection), "fghij\n\n");
    // A pane that closed, shrank away, or hid behind a popup copies nothing.
    let selection = drag(&s, (1., 1.), (36., 1.));
    for hidden in [true, false] {
        let mut s = s.clone();
        if hidden {
            s.popup = Some(Box::new(ClientShellPopupSurface {
                terminal_id: "popup".into(),
                title: String::new(),
                width: None,
                height: None,
                frame: frame("popup", 5, 2),
                mouse_reporting: false,
                sgr_pixel_mouse: false,
                pixel_width: 50,
                pixel_height: 40,
            }));
        } else {
            s.panes.remove(0);
        }
        assert!(matches!(
            selection.text(&s, CELL_WIDTH, CELL_HEIGHT),
            Err(Error::SelectionStale)
        ));
        assert_eq!(selection.rows(&s, CELL_WIDTH, CELL_HEIGHT).count(), 0);
        assert!(
            !selection
                .clone()
                .extend(&s, 56., 1., CELL_WIDTH, CELL_HEIGHT)
        );
    }
    assert_eq!(text(&s, &selection), "abcd");
}

#[test]
fn a_popup_is_selected_in_its_own_grid_and_the_panes_under_it_are_not() {
    let mut s = surface("abcdefghij");
    s.popup = Some(Box::new(ClientShellPopupSurface {
        terminal_id: "popup".into(),
        title: String::new(),
        width: None,
        height: None,
        frame: frame("popup", 4, 2),
        mouse_reporting: false,
        sgr_pixel_mouse: false,
        pixel_width: 40,
        pixel_height: 40,
    }));
    // The popup is centered: three columns and half a row of offset.
    assert!(Selection::begin(&s, 1., 1., CELL_WIDTH, CELL_HEIGHT, 1).is_none());
    let selection = drag(&s, (31., 11.), (66., 31.));
    assert!(selection.in_popup("popup") && !selection.in_panes());
    assert!(!selection.in_popup("other"));
    assert_eq!(
        selection
            .rows(&s, CELL_WIDTH, CELL_HEIGHT)
            .collect::<Vec<_>>(),
        vec![(0, 0..4), (1, 0..4)]
    );
    assert_eq!(text(&s, &selection), "popu\np");
    // The popup's terminal changing identity leaves nothing to copy.
    let mut replaced = s.clone();
    replaced.popup.as_mut().unwrap().terminal_id = "other".into();
    assert!(matches!(
        selection.text(&replaced, CELL_WIDTH, CELL_HEIGHT),
        Err(Error::SelectionStale)
    ));
}

#[test]
fn chinese_continuations_without_skip_do_not_become_spaces() {
    let mut s = surface("你 好 世 界 ");
    for (from, to) in [((1., 1.), (76., 1.)), ((76., 1.), (1., 1.))] {
        assert_eq!(text(&s, &drag(&s, from, to)), "你好世界");
    }
    // Real spaces after a wide glyph must survive a partial-row selection.
    assert_eq!(text(&s, &drag(&s, (1., 1.), (86., 1.))), "你好世界 ");
    // A selection starting on a continuation needs the preceding lead cell
    // to identify it, but must not copy that unselected lead cell.
    assert_eq!(text(&s, &drag(&s, (11., 1.), (36., 1.))), "好");
    assert_eq!(text(&s, &drag(&s, (1., 1.), (6., 1.))), "你");
    for i in [1, 3, 5, 7] {
        s.frame.cells[i].symbol.clear();
    }
    assert_eq!(text(&s, &drag(&s, (1., 1.), (76., 1.))), "你好世界");
}

#[test]
fn wide_symbols_preserve_real_spaces_graphemes_and_row_boundaries() {
    let mut s = surface("A你  B     好  x");
    s.frame.cells[5].symbol = "👩‍💻".into();
    s.frame.cells[7].symbol = "e\u{301}".into();
    assert_eq!(text(&s, &drag(&s, (1., 1.), (86., 1.))), "A你 B👩‍💻e\u{301} ");
    assert_eq!(
        text(&s, &drag(&s, (1., 1.), (36., 21.))),
        "A你 B👩‍💻e\u{301}\n好 x"
    );
    s.frame.cells[1].modifier = HIDDEN;
    assert_eq!(text(&s, &drag(&s, (1., 1.), (46., 1.))), "A  B");

    // A wide glyph in the neighboring pane cannot consume our first cell.
    s.panes[0].inner_rect.x = 2;
    s.panes[0].inner_rect.width = 8;
    assert_eq!(text(&s, &drag(&s, (21., 1.), (46., 1.))), "  B");
}

#[test]
fn popup_wide_continuations_are_not_copied() {
    let mut s = surface("abcdefghij");
    s.popup = Some(Box::new(ClientShellPopupSurface {
        terminal_id: "popup".into(),
        title: String::new(),
        width: None,
        height: None,
        frame: frame("你 好 世 界 ", 8, 1),
        mouse_reporting: false,
        sgr_pixel_mouse: false,
        pixel_width: 80,
        pixel_height: 20,
    }));
    assert_eq!(text(&s, &drag(&s, (11., 21.), (86., 21.))), "你好世界");
}

#[test]
fn copied_text_hides_concealed_cells_joins_wide_ones_and_stays_bounded() {
    let mut s = surface("ab\u{754c}");
    s.frame.cells[3].skip = true;
    s.frame.cells[1].modifier = HIDDEN;
    let selection = drag(&s, (1., 1.), (36., 1.));
    assert_eq!(text(&s, &selection), "a \u{754c}");
    s.frame.cells[0].symbol = String::new();
    assert_eq!(text(&s, &selection), "  \u{754c}");
    s.frame.cells[2].symbol = "a".repeat(MAX_SELECTION_BYTES + 1);
    assert!(matches!(
        selection.text(&s, CELL_WIDTH, CELL_HEIGHT),
        Err(Error::SelectionSize)
    ));
}

#[test]
fn invalid_geometry_and_a_dragged_release_are_rejected() {
    let s = surface("abcdefghij");
    for invalid in [0., -1., f32::NAN, f32::INFINITY] {
        assert!(Selection::begin(&s, 1., 1., invalid, CELL_HEIGHT, 1).is_none());
        assert!(Selection::begin(&s, 1., 1., CELL_WIDTH, invalid, 1).is_none());
    }
    for outside in [-1., f32::NAN, f32::INFINITY] {
        assert!(Selection::begin(&s, outside, 1., CELL_WIDTH, CELL_HEIGHT, 1).is_none());
        assert!(Selection::begin(&s, 1., outside, CELL_WIDTH, CELL_HEIGHT, 1).is_none());
    }
    let mut selection = Selection::begin(&s, 1., 1., CELL_WIDTH, CELL_HEIGHT, 1).unwrap();
    for invalid in [f32::NAN, f32::INFINITY] {
        assert!(!selection.extend(&s, invalid, 1., CELL_WIDTH, CELL_HEIGHT));
        assert!(!selection.extend(&s, 1., invalid, CELL_WIDTH, CELL_HEIGHT));
    }
    assert!(selection.dragging());
    assert!(selection.release());
    assert!(!selection.dragging());
    assert!(!selection.release());
    // A finished selection still describes the same cells.
    assert!(selection.extend(&s, 46., 1., CELL_WIDTH, CELL_HEIGHT));
    assert_eq!(text(&s, &selection), "abcde");
}

/// One pane of a single row as wide as `text` plus some padding.
fn row(text: &str) -> PaneSurfaceFrame {
    let width = text.chars().count() as u16 + 4;
    let mut s = surface("");
    s.frame = frame(text, width, 1);
    s.panes[0].rect.width = width;
    s.panes[0].rect.height = 1;
    s.panes[0].inner_rect = s.panes[0].rect;
    s
}

/// What a press of `clicks` at `column` of the one row chooses.
fn pick(s: &PaneSurfaceFrame, column: f32, clicks: usize) -> String {
    let x = column * CELL_WIDTH + 1.;
    text(
        s,
        &Selection::begin(s, x, 1., CELL_WIDTH, CELL_HEIGHT, clicks).unwrap(),
    )
}

#[test]
fn a_double_click_takes_the_word_path_or_url_under_it() {
    let s = row("ls src/main.rs:12. (see https://example.com/a_(b)). done");
    assert_eq!(pick(&s, 0., 2), "ls");
    assert_eq!(pick(&s, 5., 2), "src/main.rs:12");
    // Punctuation that ends a sentence stays out unless it was clicked.
    assert_eq!(pick(&s, 17., 2), "src/main.rs:12.");
    assert_eq!(pick(&s, 20., 2), "see");
    for column in [24., 35., 45.] {
        assert_eq!(pick(&s, column, 2), "https://example.com/a_(b)");
    }
    // A separator or a blank is a word of its own cell.
    assert_eq!(pick(&s, 19., 2), "(");
    assert_eq!(pick(&s, 2., 2), " ");
    // A single click still starts an empty drag.
    assert_eq!(pick(&s, 5., 1), "");
}

#[test]
fn a_double_click_takes_a_whole_hyperlink_and_wide_characters() {
    let mut s = row("go here now 界 界  x");
    s.frame.hyperlinks = vec!["https://example.com".into()];
    for column in 3..7 {
        s.frame.cells[column].hyperlink = Some(0);
    }
    assert_eq!(pick(&s, 4., 2), "here");
    s.frame.cells[13].skip = true;
    s.frame.cells[15].skip = true;
    assert_eq!(pick(&s, 13., 2), "界界");
    // Hidden text is never a word.
    s.frame.cells[17].modifier = HIDDEN;
    assert_eq!(pick(&s, 17., 2), " ");
}

#[test]
fn a_triple_click_takes_the_row_and_drags_grow_by_the_unit() {
    let s = surface("one two   three four");
    let y = CELL_HEIGHT + 1.;
    let line = Selection::begin(&s, 41., y, CELL_WIDTH, CELL_HEIGHT, 3).unwrap();
    assert_eq!(text(&s, &line), "three four");

    let mut words = Selection::begin(&s, 41., 1., CELL_WIDTH, CELL_HEIGHT, 2).unwrap();
    assert_eq!(text(&s, &words), "two");
    // Forward to the middle of the next row's first word takes all of it.
    assert!(words.extend(&s, 11., y, CELL_WIDTH, CELL_HEIGHT));
    assert_eq!(text(&s, &words), "two\nthree");
    // Back before the press keeps the word the press chose.
    assert!(words.extend(&s, 11., 1., CELL_WIDTH, CELL_HEIGHT));
    assert_eq!(text(&s, &words), "one two");
    assert!(!words.extend(&s, 1., 1., CELL_WIDTH, CELL_HEIGHT));

    let mut lines = Selection::begin(&s, 1., 1., CELL_WIDTH, CELL_HEIGHT, 3).unwrap();
    assert!(lines.extend(&s, 1., y, CELL_WIDTH, CELL_HEIGHT));
    assert_eq!(text(&s, &lines), "one two\nthree four");
}

/// `surface` scrolled to show content rows `top..top + 3` of a pane with
/// ten rows of history.
fn scrolled(text: &str, top: u32) -> PaneSurfaceFrame {
    let mut s = surface(text);
    s.panes[0].scroll = Some(herdr_client::protocol::PaneSurfaceScrollMetrics {
        offset_from_bottom: u64::from(10 - top),
        max_offset_from_bottom: 10,
        viewport_rows: 3,
    });
    s
}

#[test]
fn a_selection_keeps_its_text_rows_while_the_pane_scrolls() {
    // Rows 10..13 show; the drag takes row 10 from column 1 to row 12
    // through column 3.
    let at_bottom = scrolled("abcdefghij", 10);
    let selection = drag(&at_bottom, (11., 1.), (36., 41.));
    assert_eq!(
        selection
            .rows(&at_bottom, CELL_WIDTH, CELL_HEIGHT)
            .collect::<Vec<_>>(),
        vec![(0, 1..10), (1, 0..10), (2, 0..4)]
    );
    assert!(
        selection
            .offscreen_range(&at_bottom, CELL_WIDTH, CELL_HEIGHT)
            .is_none(),
        "every row is painted, so the painted cells are copied"
    );
    // Scrolled up two rows, row 10 paints on the last grid row and the
    // rest of the selection is below the screen.
    let up = scrolled("abcdefghij", 8);
    assert_eq!(
        selection
            .rows(&up, CELL_WIDTH, CELL_HEIGHT)
            .collect::<Vec<_>>(),
        vec![(2, 1..10)]
    );
    assert!(matches!(
        selection.text(&up, CELL_WIDTH, CELL_HEIGHT),
        Err(Error::SelectionOffscreen)
    ));
    let (pane, range) = selection
        .offscreen_range(&up, CELL_WIDTH, CELL_HEIGHT)
        .unwrap();
    assert_eq!(pane, "pane");
    assert_eq!(
        range,
        TextRange {
            start: TextPoint { row: 10, col: 1 },
            end: TextPoint { row: 12, col: 3 },
        }
    );
}

#[test]
fn a_selection_dragged_past_the_screen_follows_the_scroll() {
    let at_bottom = scrolled("abcdefghij", 10);
    let mut selection = drag(&at_bottom, (51., 41.), (51., 41.));
    // The pointer above the pane reaches the first painted cell; as the
    // pane scrolls up under it, the selection grows into the history.
    let up = scrolled("abcdefghij", 5);
    assert!(selection.extend(&up, 51., -40., CELL_WIDTH, CELL_HEIGHT));
    let (_, range) = selection
        .offscreen_range(&up, CELL_WIDTH, CELL_HEIGHT)
        .unwrap();
    assert_eq!(
        range,
        TextRange {
            start: TextPoint { row: 5, col: 0 },
            end: TextPoint { row: 12, col: 4 },
        }
    );
    // An edge on the right of a row's last cell starts on the next row.
    let mut tail = drag(&up, (96., 1.), (96., 1.));
    assert!(tail.extend(&at_bottom, 1., 1e6, CELL_WIDTH, CELL_HEIGHT));
    let (_, range) = tail
        .offscreen_range(&at_bottom, CELL_WIDTH, CELL_HEIGHT)
        .unwrap();
    assert_eq!(range.start, TextPoint { row: 6, col: 0 });
    assert_eq!(range.end, TextPoint { row: 12, col: 9 });
    // A press that chose no cell has nothing to read, wherever it is.
    assert!(
        Selection::begin(&at_bottom, 1., 1., CELL_WIDTH, CELL_HEIGHT, 1)
            .unwrap()
            .offscreen_range(&up, CELL_WIDTH, CELL_HEIGHT)
            .is_none()
    );
}
