use super::*;
use crate::terminal::HIDDEN;
use herdr_client::protocol::{CellData, PaneSurfacePane, SurfaceRect};

const CELL_WIDTH: f32 = 10.;
const CELL_HEIGHT: f32 = 20.;

fn cell(symbol: &str) -> CellData {
    CellData {
        symbol: symbol.into(),
        fg: 0,
        bg: 0,
        modifier: 0,
        skip: false,
        hyperlink: None,
    }
}

/// A frame whose rows are `rows`, one cell per character, padded with
/// blanks to `width`.
fn frame(rows: &[&str], width: u16) -> FrameData {
    let cells = rows
        .iter()
        .flat_map(|row| {
            let mut symbols: Vec<String> = row.chars().map(String::from).collect();
            symbols.resize(usize::from(width), " ".into());
            symbols
        })
        .map(|symbol| cell(&symbol))
        .collect();
    FrameData {
        width,
        height: rows.len() as u16,
        cells,
        cursor: None,
        hyperlinks: vec![],
        graphics: vec![],
    }
}

fn pane(id: &str, x: u16, width: u16, height: u16, focused: bool) -> PaneSurfacePane {
    let rect = SurfaceRect {
        x,
        y: 0,
        width,
        height,
    };
    PaneSurfacePane {
        pane_id: id.into(),
        content_revision: 1,
        rect,
        inner_rect: rect,
        scrollbar_rect: None,
        scroll: None,
        focused,
        mouse_reporting: false,
        sgr_pixel_mouse: false,
        alternate_screen_active: false,
        pixel_width: width.into(),
        pixel_height: height.into(),
    }
}

/// Two panes side by side, `left` focused, each five columns wide.
fn surface(rows: &[&str]) -> PaneSurfaceFrame {
    PaneSurfaceFrame {
        boot_id: "boot".into(),
        projection_revision: 1,
        surface_revision: 1,
        frame: frame(rows, 10),
        splits: vec![],
        popup: None,
        graphics: Default::default(),
        panes: vec![
            pane("left", 0, 5, rows.len() as u16, true),
            pane("right", 5, 5, rows.len() as u16, false),
        ],
    }
}

fn drag(surface: &PaneSurfaceFrame, from: (f32, f32), to: (f32, f32)) -> Selection {
    let mut selection =
        Selection::begin(surface, from.0, from.1, CELL_WIDTH, CELL_HEIGHT, 1).unwrap();
    selection.extend(surface, to.0, to.1, CELL_WIDTH, CELL_HEIGHT);
    selection.release();
    selection
}

fn read(surface: &PaneSurfaceFrame, selection: Option<&Selection>) -> Transcript {
    Transcript::read(surface, selection, CELL_WIDTH, CELL_HEIGHT).unwrap()
}

/// The text of every run, joined as a reader joins them.
fn text(transcript: &Transcript) -> String {
    transcript
        .runs((0., 0.), 1.)
        .map(|node| node.value().unwrap().to_owned())
        .collect()
}

/// The selected text, as a reader resolves the selection's carets.
fn selected(transcript: &Transcript) -> String {
    let (start, end) = transcript.selection.unwrap();
    let runs: Vec<Node> = transcript.runs((0., 0.), 1.).collect();
    let offset = |caret: Caret| {
        let before: usize = runs[..caret.line]
            .iter()
            .map(|node| node.value().unwrap().len())
            .sum();
        let within: usize = runs[caret.line].character_lengths()[..caret.character]
            .iter()
            .copied()
            .map(usize::from)
            .sum();
        before + within
    };
    let all: String = runs.iter().map(|node| node.value().unwrap()).collect();
    all[offset(start)..offset(end)].to_owned()
}

#[test]
fn without_a_selection_the_focused_pane_reads_without_padding() {
    let s = surface(&["ab   right", "  c  x"]);
    let transcript = read(&s, None);
    assert_eq!(text(&transcript), "ab\n  c");
    assert_eq!(transcript.selection, None);

    let mut s = s;
    s.panes[0].focused = false;
    s.panes[1].focused = true;
    assert_eq!(text(&read(&s, None)), "right\nx");
}

#[test]
fn a_selection_is_read_from_its_own_pane_and_matches_the_copy() {
    let s = surface(&["abcd right", "efgh other"]);
    // From the middle of "b" in the left pane to past "g" on the next row.
    let selection = drag(&s, (16., 1.), (39., 21.));
    let transcript = read(&s, Some(&selection));
    let copy = selection.text(&s, CELL_WIDTH, CELL_HEIGHT).unwrap();
    assert_eq!(copy, "cd\nefgh");
    assert_eq!(selected(&transcript), copy);

    // A selection in the unfocused pane is the one exposed.
    let selection = drag(&s, (56., 1.), (89., 1.));
    let transcript = read(&s, Some(&selection));
    assert_eq!(text(&transcript), "right\nother");
    assert_eq!(selected(&transcript), "igh");
}

#[test]
fn a_selection_that_chose_no_cell_exposes_the_focused_pane_unselected() {
    let s = surface(&["abcd right"]);
    let selection = drag(&s, (51., 1.), (52., 1.));
    let transcript = read(&s, Some(&selection));
    assert_eq!(text(&transcript), "abcd");
    assert_eq!(transcript.selection, None);
}

#[test]
fn a_selection_through_the_padding_stops_at_the_text() {
    let s = surface(&["ab   right", "cd"]);
    let selection = drag(&s, (1., 1.), (49., 1.));
    let transcript = read(&s, Some(&selection));
    assert_eq!(selected(&transcript), "ab");
    assert_eq!(
        transcript.selection.unwrap().1,
        Caret {
            line: 0,
            character: 2
        }
    );
}

#[test]
fn wide_concealed_and_overlong_cells_read_as_a_copy_does() {
    let mut s = surface(&["xxxxx"]);
    let cells = &mut s.frame.cells;
    cells[0] = cell("界");
    cells[1] = CellData {
        skip: true,
        ..cell(" ")
    };
    cells[2] = CellData {
        modifier: HIDDEN,
        ..cell("s")
    };
    cells[3] = cell(&"e\u{301}".repeat(200));
    cells[4] = cell("");
    let transcript = read(&s, None);
    let run = transcript.runs((0., 0.), 1.).next().unwrap();
    assert_eq!(run.value(), Some("界 \u{fffd}"));
    assert_eq!(run.character_lengths(), [3, 1, 3]);
    assert_eq!(run.character_positions(), Some(&[0., 20., 30.][..]));
    assert_eq!(run.character_widths(), Some(&[20., 10., 20.][..]));
}

#[test]
fn a_selection_starting_on_a_wide_continuation_leaves_the_grapheme_out() {
    let mut s = surface(&["xxyz"]);
    s.frame.cells[0] = cell("界");
    s.frame.cells[1] = cell(" ");
    let selection = drag(&s, (11., 1.), (39., 1.));
    let copy = selection.text(&s, CELL_WIDTH, CELL_HEIGHT).unwrap();
    assert_eq!(copy, "yz");
    assert_eq!(selected(&read(&s, Some(&selection))), copy);
}

#[test]
fn runs_are_placed_on_the_cells_in_device_pixels() {
    let s = surface(&["ab   cd", "e"]);
    let selection = drag(&s, (51., 1.), (69., 1.));
    let transcript = read(&s, Some(&selection));
    let runs: Vec<Node> = transcript.runs((100., 40.), 2.).collect();
    let bounds = runs[1].bounds().unwrap();
    // The right pane starts five cells in; the second row one cell down.
    assert_eq!((bounds.x0, bounds.y0), (300., 120.));
    assert_eq!((bounds.x1, bounds.y1), (400., 160.));
    // The first row's break sits after its text and paints nothing.
    assert_eq!(runs[0].value(), Some("cd\n"));
    assert_eq!(runs[0].character_positions(), Some(&[0., 20., 40.][..]));
    assert_eq!(runs[0].character_widths(), Some(&[20., 20., 0.][..]));
}

#[test]
fn a_popup_is_exposed_instead_of_the_panes_it_covers() {
    use herdr_client::protocol::ClientShellPopupSurface;
    let mut s = surface(&["under", "under"]);
    s.popup = Some(Box::new(ClientShellPopupSurface {
        terminal_id: "popup".into(),
        title: String::new(),
        width: None,
        height: None,
        frame: frame(&["top"], 4),
        mouse_reporting: false,
        sgr_pixel_mouse: false,
        pixel_width: 40,
        pixel_height: 20,
    }));
    assert_eq!(text(&read(&s, None)), "top");
}
