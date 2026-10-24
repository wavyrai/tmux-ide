#![allow(clippy::unwrap_used)]
use super::*;
use herdr_client::tmux_delivery::{Update, decode_compact};
fn snapshot() -> Snapshot {
    let bytes = br#"{"v":1,"k":"terminal-semantic-compact","f":"s","r":0,"s":[2,2,[[0,[[2,"a",1,0,0,0]]],[0,[[2,"b",1,0,0,0]]]],[],[1,1,0,"bar",0],[0,0,0,0,0,0,1,0,null,null,0],[],["authoritative-stream","observed-from-start"]]}"#;
    match decode_compact(bytes).unwrap() {
        Update::Seed { snapshot, .. } => snapshot,
        _ => panic!("expected seed"),
    }
}
fn region(id: &str, left: u16, top: u16) -> Region {
    Region {
        id: id.into(),
        left,
        top,
        width: 2,
        height: 2,
    }
}
#[test]
fn offsets_cursor_and_blank_gaps_share_canvas_coordinates() {
    let source = snapshot();
    let region = region("pane", 2, 1);
    let mut projection = DirectProjection::default();
    let result = projection
        .project(
            5,
            4,
            &[PaneSurface {
                region: &region,
                snapshot: &source,
            }],
            "pane",
        )
        .unwrap();
    assert_eq!(result.frame.rows[1][2].symbol, "a");
    assert_eq!(result.frame.rows[2][2].symbol, "b");
    assert_eq!(result.frame.rows[1][1].symbol, " ");
    assert_eq!(
        result.frame.cursor,
        Some(CursorState {
            x: 3,
            y: 2,
            visible: true,
            shape: 6
        })
    );
    assert_eq!(result.regions[0].left, 2);
    assert_eq!(
        result.work,
        ProjectionWork {
            converted_rows: 2,
            converted_cells: 4,
            copied_cells: 4
        }
    );
}
#[test]
fn unchanged_rows_skip_conversion_and_identical_publication_reuses_frame() {
    let mut source = snapshot();
    let region = region("pane", 0, 0);
    let mut projection = DirectProjection::default();
    let first = projection
        .project(
            2,
            2,
            &[PaneSurface {
                region: &region,
                snapshot: &source,
            }],
            "pane",
        )
        .unwrap();
    let first_row = Arc::clone(projection.cached_row("pane", 0).unwrap());
    let same = projection
        .project(
            2,
            2,
            &[PaneSurface {
                region: &region,
                snapshot: &source,
            }],
            "pane",
        )
        .unwrap();
    assert!(Arc::ptr_eq(&first.frame, &same.frame));
    assert_eq!(same.work, ProjectionWork::default());
    assert!(same.changed_rows.is_empty());
    source.grid[1] = Arc::clone(&snapshot().grid[0]);
    let next = projection
        .project(
            2,
            2,
            &[PaneSurface {
                region: &region,
                snapshot: &source,
            }],
            "pane",
        )
        .unwrap();
    assert!(Arc::ptr_eq(
        &first_row,
        projection.cached_row("pane", 0).unwrap()
    ));
    assert_eq!(next.changed_rows, vec![1]);
    assert_eq!(
        next.work,
        ProjectionWork {
            converted_rows: 1,
            converted_cells: 2,
            copied_cells: 0
        }
    );
    assert_eq!(next.frame.rows[1][0].symbol, "a");
    assert_eq!(first.frame.rows[1][0].symbol, "b");
}
#[test]
fn cursor_only_change_converts_no_rows_and_copies_no_cells() {
    let mut source = snapshot();
    let region = region("pane", 0, 0);
    let mut projection = DirectProjection::default();
    projection
        .project(
            2,
            2,
            &[PaneSurface {
                region: &region,
                snapshot: &source,
            }],
            "pane",
        )
        .unwrap();
    source.cursor.x = 0;
    let next = projection
        .project(
            2,
            2,
            &[PaneSurface {
                region: &region,
                snapshot: &source,
            }],
            "pane",
        )
        .unwrap();
    assert!(next.changed_rows.is_empty());
    assert_eq!(
        next.work,
        ProjectionWork {
            converted_rows: 0,
            converted_cells: 0,
            copied_cells: 0
        }
    );
    assert_eq!(next.frame.cursor.as_ref().unwrap().x, 0);
}
#[test]
fn bad_layout_does_not_replace_coherent_cache() {
    let source = snapshot();
    let a = region("a", 0, 0);
    let b = region("b", 1, 0);
    let mut projection = DirectProjection::default();
    let first = projection
        .project(
            4,
            2,
            &[PaneSurface {
                region: &a,
                snapshot: &source,
            }],
            "a",
        )
        .unwrap();
    assert!(
        projection
            .project(
                4,
                2,
                &[
                    PaneSurface {
                        region: &a,
                        snapshot: &source
                    },
                    PaneSurface {
                        region: &b,
                        snapshot: &source
                    }
                ],
                "a"
            )
            .is_err()
    );
    let retry = projection
        .project(
            4,
            2,
            &[PaneSurface {
                region: &a,
                snapshot: &source,
            }],
            "a",
        )
        .unwrap();
    assert!(Arc::ptr_eq(&first.frame, &retry.frame));
    assert!(
        projection
            .project(
                1,
                2,
                &[PaneSurface {
                    region: &a,
                    snapshot: &source
                }],
                "a"
            )
            .is_err()
    );
    assert!(
        projection
            .project(
                4,
                2,
                &[PaneSurface {
                    region: &a,
                    snapshot: &source
                }],
                "absent"
            )
            .is_err()
    );
}
#[test]
fn styles_wide_continuations_and_placeholder_semantics_match_legacy_painter() {
    let cell = Cell {
        grapheme: Arc::from("界"),
        width: 2,
        foreground: Color::Indexed { index: 17 },
        background: Color::Rgb { value: 0x123456 },
        attributes: 0xff,
    };
    let paint = painter_cell(&cell).unwrap();
    assert_eq!(paint.symbol, "界");
    assert_eq!(paint.fg, 0x01000011);
    assert_eq!(paint.bg, 0x02123456);
    assert_eq!(paint.modifier, 0x1cf);
    assert!(!paint.skip);
    let continuation = Cell {
        grapheme: Arc::from(""),
        width: 0,
        ..cell.clone()
    };
    assert!(painter_cell(&continuation).unwrap().skip);
    let placeholder = Cell {
        grapheme: Arc::from("\u{10eeee}"),
        ..cell
    };
    assert_eq!(painter_cell(&placeholder).unwrap().symbol, " ");
}

#[test]
fn changed_pane_row_only_recomposes_its_canvas_row() {
    let mut left = snapshot();
    let right = snapshot();
    let a = region("a", 0, 1);
    let b = region("b", 3, 1);
    let mut projection = DirectProjection::default();
    let first = projection
        .project(
            6,
            4,
            &[
                PaneSurface {
                    region: &a,
                    snapshot: &left,
                },
                PaneSurface {
                    region: &b,
                    snapshot: &right,
                },
            ],
            "a",
        )
        .unwrap();
    left.grid[0] = Arc::clone(&snapshot().grid[1]);
    let next = projection
        .project(
            6,
            4,
            &[
                PaneSurface {
                    region: &a,
                    snapshot: &left,
                },
                PaneSurface {
                    region: &b,
                    snapshot: &right,
                },
            ],
            "a",
        )
        .unwrap();
    assert_eq!(next.changed_rows, vec![1]);
    assert_eq!(
        next.work,
        ProjectionWork {
            converted_rows: 1,
            converted_cells: 2,
            copied_cells: 4
        }
    );
    for y in [0, 2, 3] {
        assert!(Arc::ptr_eq(&first.frame.rows[y], &next.frame.rows[y]));
    }
    assert!(!Arc::ptr_eq(&first.frame.rows[1], &next.frame.rows[1]));
    assert_eq!(next.frame.cell(0, 1).unwrap().symbol, "b");
    assert_eq!(next.frame.cell(3, 1).unwrap().symbol, "a");
    assert_eq!(next.frame.cell(2, 1).unwrap().symbol, " ");
}

#[test]
fn moving_a_pane_rebuilds_old_and_new_canvas_rows_only() {
    let source = snapshot();
    let old = region("a", 1, 1);
    let moved = region("a", 1, 3);
    let mut projection = DirectProjection::default();
    let first = projection
        .project(
            4,
            6,
            &[PaneSurface {
                region: &old,
                snapshot: &source,
            }],
            "a",
        )
        .unwrap();
    let next = projection
        .project(
            4,
            6,
            &[PaneSurface {
                region: &moved,
                snapshot: &source,
            }],
            "a",
        )
        .unwrap();
    assert_eq!(next.changed_rows, vec![1, 2, 3, 4]);
    assert_eq!(next.work.converted_cells, 0);
    assert_eq!(next.work.copied_cells, 4);
    assert!(Arc::ptr_eq(&first.frame.rows[0], &next.frame.rows[0]));
    assert!(Arc::ptr_eq(&first.frame.rows[5], &next.frame.rows[5]));
    assert_eq!(next.frame.cell(1, 1).unwrap().symbol, " ");
    assert_eq!(next.frame.cell(1, 3).unwrap().symbol, "a");
    assert_eq!(next.frame.cursor.as_ref().unwrap().y, 4);
}

#[test]
fn selecting_another_pane_retains_every_canvas_row() {
    let source = snapshot();
    let a = region("a", 0, 0);
    let b = region("b", 2, 0);
    let mut projection = DirectProjection::default();
    let first = projection
        .project(
            4,
            2,
            &[
                PaneSurface {
                    region: &a,
                    snapshot: &source,
                },
                PaneSurface {
                    region: &b,
                    snapshot: &source,
                },
            ],
            "a",
        )
        .unwrap();
    let next = projection
        .project(
            4,
            2,
            &[
                PaneSurface {
                    region: &b,
                    snapshot: &source,
                },
                PaneSurface {
                    region: &a,
                    snapshot: &source,
                },
            ],
            "b",
        )
        .unwrap();
    assert_eq!(next.work, ProjectionWork::default());
    assert!(next.changed_rows.is_empty());
    for y in 0..2 {
        assert!(Arc::ptr_eq(&first.frame.rows[y], &next.frame.rows[y]));
    }
    assert_eq!(next.frame.cursor.as_ref().unwrap().x, 3);
}
