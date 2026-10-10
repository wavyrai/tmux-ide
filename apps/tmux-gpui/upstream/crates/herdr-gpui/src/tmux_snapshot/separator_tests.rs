use super::*;
fn frame(width: u16, height: u16) -> FrameData {
    FrameData {
        width,
        height,
        cells: vec![
            herdr_client::protocol::CellData {
                symbol: " ".into(),
                fg: 0,
                bg: 0,
                modifier: 0,
                skip: false,
                hyperlink: None,
            };
            usize::from(width) * usize::from(height)
        ],
        cursor: None,
        hyperlinks: vec![],
        graphics: vec![],
    }
}
fn region(id: &str, left: u16, top: u16, width: u16, height: u16) -> Region {
    Region {
        id: id.into(),
        left,
        top,
        width,
        height,
    }
}
fn choices(regions: &[Region]) -> Vec<Choice> {
    regions
        .iter()
        .map(|r| Choice {
            id: r.id.clone(),
            label: "same title".into(),
            pane_count: None,
            window_id: None,
            window_label: None,
        })
        .collect()
}
fn checked(selected: &str, regions: &[Region], frame: &FrameData) -> Vec<SeparatorCell> {
    let cells = separator_cells(selected, regions, frame, &choices(regions));
    for c in &cells {
        assert!(c.col < frame.width && c.row < frame.height);
        assert!(!regions.iter().any(|r| c.col >= r.left
            && u32::from(c.col) < u32::from(r.left) + u32::from(r.width)
            && c.row >= r.top
            && u32::from(c.row) < u32::from(r.top) + u32::from(r.height)));
    }
    cells
}
#[test]
fn exact_identity_marks_only_the_existing_separator_not_content_or_outer_edges() {
    let regions = [region("left", 0, 0, 2, 3), region("right", 3, 0, 2, 3)];
    let expected = (0..3)
        .map(|row| SeparatorCell {
            col: 2,
            row,
            vertical: true,
        })
        .collect::<Vec<_>>();
    assert_eq!(checked("left", &regions, &frame(5, 3)), expected);
    assert_eq!(checked("right", &regions, &frame(5, 3)), expected);
    assert!(checked("same title", &regions, &frame(5, 3)).is_empty());
    assert!(checked("unknown", &regions, &frame(5, 3)).is_empty());
}
#[test]
fn irregular_split_candidates_are_carved_against_every_pane() {
    // Left lower candidate row is partly occupied by the large lower pane.
    let regions = [
        region("selected", 0, 0, 3, 2),
        region("right", 4, 0, 3, 3),
        region("lower", 0, 3, 7, 2),
    ];
    let cells = checked("selected", &regions, &frame(7, 5));
    assert_eq!(
        cells,
        vec![
            SeparatorCell {
                col: 3,
                row: 0,
                vertical: true
            },
            SeparatorCell {
                col: 3,
                row: 1,
                vertical: true
            },
            SeparatorCell {
                col: 0,
                row: 2,
                vertical: false
            },
            SeparatorCell {
                col: 1,
                row: 2,
                vertical: false
            },
            SeparatorCell {
                col: 2,
                row: 2,
                vertical: false
            }
        ]
    );
    let touching = [
        region("selected", 0, 0, 3, 2),
        region("neighbour", 3, 0, 4, 3),
        region("lower", 0, 2, 3, 3),
    ];
    assert!(checked("selected", &touching, &frame(7, 5)).is_empty());
}
#[test]
fn single_pane_narrow_and_invalid_rectangles_never_manufacture_a_border() {
    for (width, height) in [(1, 1), (1, 3), (3, 1)] {
        assert!(
            checked(
                "a",
                &[region("a", 0, 0, width, height)],
                &frame(width, height)
            )
            .is_empty()
        );
    }
    for regions in [
        vec![region("a", 0, 0, 0, 1)],
        vec![region("a", 0, 0, 3, 1)],
        vec![region("a", u16::MAX, 0, 1, 1)],
        vec![region("a", 0, 0, 1, 1), region("b", 0, 0, 1, 1)],
    ] {
        assert!(checked("a", &regions, &frame(2, 2)).is_empty());
    }
    assert!(separator_cells("a", &[region("a", 0, 0, 1, 1)], &frame(2, 2), &[]).is_empty());
}
#[test]
fn visible_or_styled_gap_cells_are_never_painted_over() {
    let regions = [region("a", 0, 0, 1, 3), region("b", 2, 0, 1, 3)];
    let mut source = frame(3, 3);
    source.cells[1].symbol = "X".into();
    source.cells[4].skip = true;
    source.cells[7].modifier = 1;
    assert!(checked("a", &regions, &source).is_empty());
    source.cells.clear();
    assert!(checked("a", &regions, &source).is_empty());
}

#[test]
fn colored_blank_gap_cells_are_not_unused_separators() {
    let regions = [region("a", 0, 0, 1, 2), region("b", 2, 0, 1, 2)];
    let mut source = frame(3, 2);
    assert_eq!(checked("a", &regions, &source).len(), 2);
    source.cells[1].fg = 0x01000001;
    source.cells[4].bg = 0x02123456;
    assert!(checked("a", &regions, &source).is_empty());
    source.cells[1].fg = 0;
    assert_eq!(
        checked("a", &regions, &source),
        vec![SeparatorCell {
            col: 1,
            row: 0,
            vertical: true
        }]
    );
    source.cells[4].bg = 0;
    assert_eq!(checked("a", &regions, &source).len(), 2);
}
