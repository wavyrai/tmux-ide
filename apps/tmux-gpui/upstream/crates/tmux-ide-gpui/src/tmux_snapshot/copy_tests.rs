use super::*;
use herdr_client::protocol::CellData;
fn cell(symbol: &str, skip: bool) -> CellData {
    CellData {
        symbol: symbol.into(),
        skip,
        fg: 0,
        bg: 0,
        modifier: 0,
        hyperlink: None,
    }
}
fn fixture() -> (FrameData, Region) {
    (
        FrameData {
            width: 6,
            height: 2,
            cursor: None,
            hyperlinks: vec![],
            graphics: vec![],
            cells: vec![
                cell("X", false),
                cell("界", false),
                cell("", true),
                cell("e\u{301}", false),
                cell(" ", false),
                cell("Y", false),
                cell("X", false),
                cell("t", false),
                cell("a", false),
                cell("i", false),
                cell("l", false),
                cell("Y", false),
            ],
        },
        Region {
            id: "pane".into(),
            left: 1,
            top: 0,
            width: 4,
            height: 2,
            wrapped: vec![false, true],
        },
    )
}
#[test]
fn pane_copy_preserves_wide_combining_and_soft_wrap_without_neighbor_cells() -> anyhow::Result<()> {
    let (frame, mut region) = fixture();
    assert_eq!(region.text(&frame)?, "界e\u{301} tail");
    region.wrapped[1] = false;
    assert_eq!(region.text(&frame)?, "界e\u{301}\ntail");
    Ok(())
}
#[test]
fn invalid_metadata_hidden_text_and_bounded_copy() -> anyhow::Result<()> {
    let (mut frame, mut region) = fixture();
    assert!(!region.valid(&frame, Some("other")));
    region.wrapped.pop();
    assert!(!region.valid(&frame, Some("pane")));
    region.wrapped.push(false);
    frame.cells[1].modifier = crate::terminal::HIDDEN;
    assert!(!region.text(&frame)?.contains('界'));
    frame.cells[7].symbol = "a".repeat(crate::terminal::MAX_SELECTION_BYTES);
    assert!(region.text(&frame).is_err());
    region.left = u16::MAX;
    assert!(region.text(&frame).is_err());
    Ok(())
}

#[test]
fn drag_boundaries_preserve_graphemes_and_both_directions() -> anyhow::Result<()> {
    let (frame, region) = fixture();
    assert_eq!(region.text_between(&frame, (0, 1), (0, 3))?, "界e\u{301}");
    assert_eq!(region.text_between(&frame, (0, 3), (0, 1))?, "界e\u{301}");
    assert_eq!(region.text_between(&frame, (0, 0), (0, 1))?, "界");
    assert_eq!(region.text_between(&frame, (1, 1), (1, 3))?, "ai");
    assert_eq!(region.text_between(&frame, (0, 1), (0, 1))?, "");
    assert!(region.text_between(&frame, (2, 0), (0, 0)).is_err());
    assert!(region.text_between(&frame, (0, 5), (0, 0)).is_err());
    Ok(())
}
#[test]
fn partial_multiline_selection_obeys_source_wraps() -> anyhow::Result<()> {
    let (frame, mut region) = fixture();
    assert_eq!(region.text_between(&frame, (0, 2), (1, 2))?, "e\u{301} ta");
    region.wrapped[1] = false;
    assert_eq!(region.text_between(&frame, (0, 2), (1, 2))?, "e\u{301}\nta");
    assert_eq!(region.text_between(&frame, (0, 4), (1, 0))?, "\n");
    Ok(())
}

#[test]
fn continuation_row_does_not_join_a_following_hard_line_or_trim_soft_wrap_spaces()
-> anyhow::Result<()> {
    let mut frame = FrameData {
        width: 4,
        height: 3,
        cursor: None,
        hyperlinks: vec![],
        graphics: vec![],
        cells: ["A", " ", " ", " ", "B", " ", " ", " ", "C", " ", "D", " "]
            .into_iter()
            .map(|symbol| cell(symbol, false))
            .collect(),
    };
    let mut region = Region {
        id: "pane".into(),
        left: 0,
        top: 0,
        width: 4,
        height: 3,
        wrapped: vec![false, true, false],
    };
    assert_eq!(region.text(&frame)?, "A   B\nC D");
    assert_eq!(region.text_between(&frame, (0, 1), (2, 2))?, "   B\nC ");
    assert_eq!(region.text_between(&frame, (2, 2), (0, 1))?, "   B\nC ");
    // Beginning a selection at a continuation does not join its following hard line.
    assert_eq!(region.text_between(&frame, (1, 0), (2, 3))?, "B\nC D");
    region.wrapped[0] = true; // The preceding row is outside this viewport.
    assert_eq!(region.text(&frame)?, "A   B\nC D");
    region.wrapped[2] = true;
    assert_eq!(region.text(&frame)?, "A   B   C D");
    frame.cells[8].symbol = "界".into();
    frame.cells[9] = cell("", true);
    assert_eq!(region.text(&frame)?, "A   B   界D");
    Ok(())
}
