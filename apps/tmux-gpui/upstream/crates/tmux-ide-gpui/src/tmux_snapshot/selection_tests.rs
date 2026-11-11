#![allow(clippy::unwrap_used)]
use super::*;
use std::sync::Arc;
fn state() -> anyhow::Result<browser::State> {
    let mut frame =
        super::super::decode::frame(include_bytes!("../../../../../fixtures/snapshot.json"))?;
    frame.cells[0].symbol = "A".into();
    frame.cells[1].symbol = "B".into();
    let region = copy::Region {
        id: "pane".into(),
        left: 0,
        top: 0,
        width: frame.width,
        height: frame.height,
        wrapped: vec![false; usize::from(frame.height)],
    };
    Ok(browser::State {
        frame: Some(Arc::new(frame).into()),
        copy_region: Some(region),
        selected_pane: Some("pane".into()),
        ..Default::default()
    })
}
#[test]
fn captured_text_and_highlight_survive_new_output() -> anyhow::Result<()> {
    let mut state = state()?;
    let mut selection =
        Capture::begin(&state, 0., 0.).ok_or_else(|| anyhow::anyhow!("selection"))?;
    selection.update(2., 0.)?;
    assert_eq!(selection.text()?, "AB");
    assert_eq!(selection.highlights[0].columns, 0..2);
    let mut next =
        super::super::decode::frame(include_bytes!("../../../../../fixtures/snapshot.json"))?;
    next.cells[0].symbol = "Z".into();
    state.frame = Some(Arc::new(next).into());
    assert!(selection.compatible(&state));
    assert_eq!(selection.text()?, "AB");
    state.frame = None;
    assert!(!selection.compatible(&state));
    Ok(())
}
#[test]
fn selection_rejects_new_target_or_geometry_and_clamps_drag() -> anyhow::Result<()> {
    let mut state = state()?;
    assert!(Capture::begin(&state, -1., 0.).is_none());
    assert!(Capture::begin(&state, f32::NAN, 0.).is_none());
    let mut selection =
        Capture::begin(&state, 0., 0.).ok_or_else(|| anyhow::anyhow!("selection"))?;
    assert!(selection.empty());
    selection.update(10000., 10000.)?;
    assert_eq!(selection.head, (19, 60));
    selection.update(0., -1.)?;
    assert!(selection.empty());
    state.selected_pane = Some("other".into());
    assert!(!selection.compatible(&state));
    state.selected_pane = Some("pane".into());
    if let Some(region) = &mut state.copy_region {
        region.left = 1;
    }
    assert!(!selection.compatible(&state));
    Ok(())
}

#[test]
fn retained_coordinates_require_original_exact_viewport_identity() -> anyhow::Result<()> {
    let mut state = state()?;
    state.selection_identity = Some("a".repeat(64));
    let mut capture = Capture::begin(&state, 0., 0.).unwrap();
    capture.update(2., 0.)?;
    assert!(capture.save().is_none(), "never retain an unfinished drag");
    capture.dragging = false;
    let restored = capture.save().unwrap().restore(&state).unwrap();
    assert_eq!(restored.text()?, "AB");
    assert!(!restored.dragging);
    state.selection_identity = Some("b".repeat(64));
    assert!(capture.save().unwrap().restore(&state).is_none());
    // Output after capture must not relabel the captured span with a newer proof.
    assert_eq!(capture.identity, Some("a".repeat(64)));
    state.selection_identity = Some("a".repeat(64));
    state.retained_preview = true;
    assert!(capture.save().unwrap().restore(&state).is_none());
    state.retained_preview = false;
    state.copy_region.as_mut().unwrap().width -= 1;
    assert!(capture.save().unwrap().restore(&state).is_none());
    state.selection_identity = None;
    assert!(capture.save().unwrap().restore(&state).is_none());
    Ok(())
}

/// A pane of `lines` (padded to the widest), with soft-wrap flags.
fn lines(text: &[&str], wrapped: Vec<bool>) -> browser::State {
    use herdr_client::protocol::{CellData, FrameData};
    let width = text.iter().map(|l| l.chars().count()).max().unwrap() as u16;
    let cells = text
        .iter()
        .flat_map(|l| {
            l.chars()
                .chain(std::iter::repeat(' '))
                .take(usize::from(width))
        })
        .map(|c| CellData {
            symbol: c.to_string(),
            fg: 0,
            bg: 0,
            modifier: 0,
            skip: false,
            hyperlink: None,
        })
        .collect();
    let frame = FrameData {
        width,
        height: text.len() as u16,
        cells,
        cursor: None,
        hyperlinks: vec![],
        graphics: vec![],
    };
    browser::State {
        frame: Some(Arc::new(frame).into()),
        copy_region: Some(copy::Region {
            id: "pane".into(),
            left: 0,
            top: 0,
            width,
            height: text.len() as u16,
            wrapped,
        }),
        selected_pane: Some("pane".into()),
        ..Default::default()
    }
}

fn unit(state: &browser::State, unit: Unit, x: f32, y: f32) -> String {
    let mut selection = Capture::begin(state, x, y).unwrap();
    selection.select(unit, x, y).unwrap();
    selection.text().unwrap()
}

/// Card 9: double-click selects a word, as the terminal app does: letters,
/// digits and `_` run together; a run of spaces or of punctuation is its own
/// unit; soft-wrapped rows join.
#[test]
fn double_click_selects_the_word_under_the_pointer() {
    let state = lines(&["cargo test_all --lib  ok"], vec![false]);
    assert_eq!(unit(&state, Unit::Word, 2.5, 0.5), "cargo");
    assert_eq!(unit(&state, Unit::Word, 8.5, 0.5), "test_all");
    assert_eq!(unit(&state, Unit::Word, 15.5, 0.5), "--");
    assert_eq!(unit(&state, Unit::Word, 20.5, 0.5), "  ");
    let state = lines(&["say hel", "lo now"], vec![false, true]);
    assert_eq!(unit(&state, Unit::Word, 5.5, 0.5), "hello");
    assert_eq!(unit(&state, Unit::Word, 0.5, 1.5), "hello");
}

/// Card 9: triple-click selects the whole logical line, across soft wraps.
#[test]
fn triple_click_selects_the_line_across_soft_wraps() {
    let state = lines(&["one", "two", "three"], vec![false, false, false]);
    assert_eq!(unit(&state, Unit::Line, 1.5, 1.5), "two");
    let state = lines(&["abcd", "ef", "gh"], vec![false, true, false]);
    assert_eq!(unit(&state, Unit::Line, 0.5, 1.5), "abcdef");
}

/// Dragging after a double-click keeps the first word and grows by words.
#[test]
fn dragging_after_a_double_click_extends_by_words() {
    let state = lines(&["alpha beta gamma"], vec![false]);
    let mut selection = Capture::begin(&state, 7.5, 0.5).unwrap();
    selection.select(Unit::Word, 7.5, 0.5).unwrap();
    selection.update(12., 0.5).unwrap();
    assert_eq!(selection.text().unwrap(), "beta gamma");
    selection.update(1., 0.5).unwrap();
    assert_eq!(selection.text().unwrap(), "alpha beta");
}
