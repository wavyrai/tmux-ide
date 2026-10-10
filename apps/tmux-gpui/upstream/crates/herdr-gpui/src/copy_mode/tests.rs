use super::*;
use herdr_client::protocol::{PaneSurfaceScrollMetrics, SurfaceRect};

/// A 20x10 pane with 50 rows of history, scrolled `offset` up.
fn pane(offset: u64) -> PaneSurfacePane {
    let rect = SurfaceRect {
        x: 2,
        y: 1,
        width: 20,
        height: 10,
    };
    PaneSurfacePane {
        pane_id: "p".into(),
        content_revision: 4,
        rect,
        inner_rect: rect,
        scrollbar_rect: None,
        scroll: Some(PaneSurfaceScrollMetrics {
            offset_from_bottom: offset,
            max_offset_from_bottom: 50,
            viewport_rows: 10,
        }),
        focused: true,
        mouse_reporting: false,
        sgr_pixel_mouse: false,
        alternate_screen_active: false,
        pixel_width: 200,
        pixel_height: 100,
    }
}

fn point(row: u32, col: u16) -> TextPoint {
    TextPoint { row, col }
}

#[test]
fn keys_parse_as_herdr_copy_mode_defines_them() {
    use CopyMotion::*;
    let key = |key, shift| Command::from_key(key, shift, false);
    assert_eq!(key("w", false), Some(Command::Motion(NextWordStart)));
    assert_eq!(key("w", true), Some(Command::Motion(NextBigWordStart)));
    assert_eq!(key("b", true), Some(Command::Motion(PreviousBigWordStart)));
    assert_eq!(key("e", true), Some(Command::Motion(NextBigWordEnd)));
    assert_eq!(key("4", true), Some(Command::Motion(LineEnd)));
    assert_eq!(key("6", true), Some(Command::Motion(FirstNonBlank)));
    assert_eq!(key("[", true), Some(Command::Motion(PreviousParagraph)));
    assert_eq!(key("g", true), Some(Command::History { top: false }));
    assert_eq!(key("v", true), Some(Command::Mark { lines: true }));
    assert_eq!(key("x", false), None);
    assert_eq!(
        Command::from_key("u", false, true),
        Some(Command::Page {
            down: false,
            half: true
        })
    );
    assert_eq!(Command::from_key("w", false, true), None);
    // Characters an input method commits read the same way.
    assert_eq!(
        Command::from_char('W'),
        Some(Command::Motion(NextBigWordStart))
    );
    assert_eq!(Command::from_char('$'), Some(Command::Motion(LineEnd)));
    assert_eq!(
        Command::from_char('}'),
        Some(Command::Motion(NextParagraph))
    );
    assert_eq!(
        Command::from_char(' '),
        Some(Command::Mark { lines: false })
    );
    assert_eq!(Command::from_char('界'), None);
}

#[test]
fn starts_at_the_terminal_cursor_or_the_last_row() {
    let shown = pane(5);
    // Rows 45..55 show; the cursor at grid (7, 4) is row 48, column 5.
    let mode = CopyMode::new(&shown, Some((7, 4)));
    assert_eq!(mode.cursor, point(48, 5));
    assert_eq!(mode.entry_offset(), Some(5));
    let mode = CopyMode::new(&shown, Some((0, 0)));
    assert_eq!(mode.cursor, point(54, 0), "a cursor outside the pane");
    assert_eq!(CopyMode::new(&shown, None).cursor, point(54, 0));
}

#[test]
fn local_steps_clamp_to_the_pane_and_its_history() {
    let shown = pane(0);
    let mut mode = CopyMode::new(&shown, None);
    assert_eq!(mode.cursor, point(59, 0));
    let mut run = |command| mode.command(command, &shown);
    assert_eq!(run(Command::Step { rows: 1, cols: -1 }), Outcome::Moved);
    run(Command::Step { rows: 0, cols: 40 });
    run(Command::Page {
        down: false,
        half: true,
    });
    assert_eq!(mode.cursor, point(54, 19));
    mode.command(
        Command::Page {
            down: false,
            half: false,
        },
        &shown,
    );
    assert_eq!(mode.cursor, point(46, 19));
    mode.command(Command::History { top: true }, &shown);
    assert_eq!(mode.cursor, point(0, 0));
    mode.command(Command::Step { rows: -3, cols: -3 }, &shown);
    assert_eq!(mode.cursor, point(0, 0));
    mode.command(Command::History { top: false }, &shown);
    assert_eq!(mode.cursor, point(59, 0));
}

#[test]
fn motions_go_to_the_daemon_one_at_a_time_and_keys_wait_in_order() {
    let shown = pane(0);
    let mut mode = CopyMode::new(&shown, None);
    let Outcome::Motion(params) =
        mode.command(Command::Motion(CopyMotion::PreviousWordStart), &shown)
    else {
        panic!("a word motion asks the daemon");
    };
    assert_eq!(params.cursor, point(59, 0));
    assert_eq!(params.content_revision, Some(4));
    mode.sent("1".into(), &params);
    assert_eq!(
        mode.command(Command::Step { rows: 0, cols: 1 }, &shown),
        Outcome::Nothing
    );
    assert_eq!(mode.next_queued(), None, "still in flight");
    let landed = CopyMotionResult {
        pane_id: "p".into(),
        cursor: point(58, 12),
        content_revision: 4,
    };
    assert!(!mode.answer("other", Ok(landed.clone())).unwrap());
    assert!(mode.answer("1", Ok(landed)).unwrap());
    assert_eq!(mode.cursor, point(58, 12));
    let next = mode.next_queued().unwrap();
    assert_eq!(mode.command(next, &shown), Outcome::Moved);
    assert_eq!(mode.cursor, point(58, 13));
    // A held key stops queueing at the bound.
    let params = mode.motion_params(CopyMotion::NextWordEnd, 4);
    mode.sent("2".into(), &params);
    for _ in 0..100 {
        mode.command(Command::Step { rows: 1, cols: 0 }, &shown);
    }
    assert_eq!(mode.queued.len(), MAX_QUEUED);
}

#[test]
fn a_stale_motion_retries_on_newer_settled_content() {
    let mut shown = pane(0);
    let mut mode = CopyMode::new(&shown, None);
    let params = mode.motion_params(CopyMotion::NextParagraph, 4);
    mode.sent("1".into(), &params);
    let stale = herdr_client::Error::Endpoint {
        code: EndpointErrorCode::StaleContent,
        message: "pane content changed".into(),
    };
    assert!(!mode.answer("1", Err(stale)).unwrap());
    mode.command(Command::Step { rows: -1, cols: 0 }, &shown);
    assert!(mode.due_retry(&shown).is_none(), "same revision");
    shown.content_revision = 5;
    assert!(mode.due_retry(&shown).is_none(), "mid-write");
    shown.content_revision = 6;
    let retry = mode.due_retry(&shown).unwrap();
    assert_eq!(retry.motion, CopyMotion::NextParagraph);
    assert_eq!(retry.content_revision, Some(6));
    mode.sent("2".into(), &retry);
    // Any other failure drops what waited behind it.
    let failure = herdr_client::Error::Endpoint {
        code: EndpointErrorCode::Other("copy_motion_unavailable".into()),
        message: "terminal row is unavailable".into(),
    };
    assert!(mode.answer("2", Err(failure)).is_err());
    assert_eq!(mode.next_queued(), None);
}

#[test]
fn marks_select_by_cell_or_line_and_copy_or_cancel() {
    let shown = pane(0);
    let mut mode = CopyMode::new(&shown, Some((5, 9)));
    assert_eq!(
        mode.command(Command::Copy, &shown),
        Outcome::Exit,
        "nothing marked"
    );
    mode.command(Command::Mark { lines: false }, &shown);
    mode.command(Command::Step { rows: -2, cols: -1 }, &shown);
    assert_eq!(
        mode.command(Command::Copy, &shown),
        Outcome::Copy(TextRange {
            start: point(56, 2),
            end: point(58, 3),
        })
    );
    mode.command(Command::Mark { lines: true }, &shown);
    mode.command(Command::Step { rows: 3, cols: 0 }, &shown);
    assert_eq!(
        mode.command(Command::Copy, &shown),
        Outcome::Copy(TextRange {
            start: point(56, 0),
            end: point(59, 19),
        })
    );
    // Escape clears a selection first, then leaves.
    assert_eq!(mode.command(Command::Cancel, &shown), Outcome::Moved);
    assert_eq!(mode.command(Command::Cancel, &shown), Outcome::Exit);
    assert_eq!(mode.command(Command::Exit, &shown), Outcome::Exit);
}

#[test]
fn the_cursor_is_kept_on_screen_with_the_least_scrolling() {
    let mut shown = pane(0);
    let mut mode = CopyMode::new(&shown, None);
    assert_eq!(mode.reveal(&shown), None);
    mode.command(Command::Step { rows: -12, cols: 0 }, &shown);
    // Row 47 is above rows 50..60: it becomes the top row.
    assert_eq!(mode.reveal(&shown), Some(3));
    assert_eq!(mode.reveal(&shown), None, "asked once");
    shown.scroll.as_mut().unwrap().offset_from_bottom = 3;
    assert_eq!(mode.reveal(&shown), None);
    mode.command(Command::History { top: false }, &shown);
    // Row 59 below rows 47..57: it becomes the bottom row.
    assert_eq!(mode.reveal(&shown), Some(0));
}

#[test]
fn highlights_show_the_selection_and_the_cursor() {
    let shown = pane(0);
    let mut mode = CopyMode::new(&shown, Some((5, 9)));
    assert_eq!(
        mode.highlights(&shown),
        vec![Highlight {
            row: 9,
            columns: 5..6,
            tint: Tint::CopyCursor,
        }]
    );
    mode.command(Command::Mark { lines: true }, &shown);
    let highlights = mode.highlights(&shown);
    assert_eq!(highlights[0].columns, 2..22);
    assert_eq!(highlights[0].tint, Tint::Selection);
    let mut other = shown.clone();
    other.pane_id = "q".into();
    assert!(mode.highlights(&other).is_empty());
}
