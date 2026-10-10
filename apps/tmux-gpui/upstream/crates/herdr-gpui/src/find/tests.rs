use super::*;
use crate::scrollback::reveal_offset;
use herdr_client::protocol::{PaneSurfaceScrollMetrics, SurfaceRect};

mod memory;

fn pane(content_revision: u64, offset: u64, max: u64) -> PaneSurfacePane {
    let rect = SurfaceRect {
        x: 2,
        y: 1,
        width: 20,
        height: 10,
    };
    PaneSurfacePane {
        pane_id: "p".into(),
        content_revision,
        rect,
        inner_rect: rect,
        scrollbar_rect: None,
        scroll: Some(PaneSurfaceScrollMetrics {
            offset_from_bottom: offset,
            max_offset_from_bottom: max,
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

fn range(row: u32, start: u16, end: u16) -> TextRange {
    TextRange {
        start: point(row, start),
        end: point(row, end),
    }
}

fn result(revision: u64, matches: Vec<TextRange>, current: u32, global: u64) -> CopySearchResult {
    CopySearchResult {
        pane_id: "p".into(),
        content_revision: revision,
        total: matches.len() as u64,
        matches,
        current: Some(current),
        current_global: Some(global),
    }
}

fn send(search: &mut Search, pane: &PaneSurfacePane, id: &str, now: Instant) -> CopySearchParams {
    let (step, params) = search.next_request(pane).expect("a request is due");
    search.sent(id.into(), &params, step, now);
    params
}

#[test]
fn a_query_searches_upward_from_where_the_bar_opened() {
    // 100 history rows, scrolled up 30: rows 70..80 show.
    let shown = pane(4, 30, 100);
    let mut search = Search::new(&shown);
    assert!(
        search.next_request(&shown).is_none(),
        "an empty query asks nothing"
    );
    search.set_query("needle");
    let params = send(&mut search, &shown, "1", Instant::now());
    assert_eq!(params.direction, SearchDirection::Backward);
    assert_eq!(params.cursor, point(80, 0));
    assert_eq!(params.previous, None);
    assert_eq!(params.content_revision, 4);
    assert_eq!(params.pane_id, "p");
}

#[test]
fn one_search_in_flight_and_steps_coalesce_to_the_latest() {
    let shown = pane(2, 0, 50);
    let mut search = Search::new(&shown);
    let now = Instant::now();
    search.set_query("a");
    send(&mut search, &shown, "1", now);
    search.set_query("ab");
    assert!(
        search.next_request(&shown).is_none(),
        "the first is still in flight"
    );
    assert_eq!(search.in_flight(), Some("1"));
    // The edited query's answer arrives for the old one and is dropped.
    let stale = result(2, vec![range(3, 0, 0)], 0, 0);
    assert_eq!(search.answer("1", Ok(stale)), None);
    assert_eq!(search.label(), "");
    let params = send(&mut search, &shown, "2", now);
    assert_eq!(params.query, "ab");
    // An answer to some other request is not this search's.
    assert_eq!(search.answer("9", Ok(result(2, vec![], 0, 0))), None);
    assert_eq!(search.in_flight(), Some("2"));
}

#[test]
fn older_and_newer_move_from_the_current_match_and_reveal_it() {
    let shown = pane(2, 0, 50);
    let mut search = Search::new(&shown);
    let now = Instant::now();
    search.set_query("x");
    // A step before any answer is absorbed by the pending query.
    search.step(Step::Older);
    send(&mut search, &shown, "1", now);
    let matches = vec![range(5, 1, 2), range(20, 0, 1), range(55, 3, 4)];
    let reveal = search.answer("1", Ok(result(2, matches.clone(), 1, 1)));
    assert_eq!(reveal, Some(matches[1]));
    assert_eq!(search.label(), "2 of 3");
    assert!(search.has_matches());

    search.step(Step::Older);
    let params = send(&mut search, &shown, "2", now);
    assert_eq!(params.direction, SearchDirection::Backward);
    assert_eq!(params.previous, Some(matches[1]));
    assert_eq!(
        search.answer("2", Ok(result(2, matches.clone(), 0, 0))),
        Some(matches[0])
    );
    search.step(Step::Newer);
    let params = send(&mut search, &shown, "3", now);
    assert_eq!(params.direction, SearchDirection::Forward);
    assert_eq!(params.previous, Some(matches[0]));
}

#[test]
fn stale_content_waits_for_a_newer_surface_then_retries() {
    let mut shown = pane(2, 0, 50);
    let mut search = Search::new(&shown);
    let now = Instant::now();
    search.set_query("x");
    send(&mut search, &shown, "1", now);
    let refused = herdr_client::Error::Endpoint {
        code: EndpointErrorCode::StaleContent,
        message: "pane content changed".into(),
    };
    assert_eq!(search.answer("1", Err(refused)), None);
    assert!(search.error().is_none(), "a stale answer is not a failure");
    assert!(search.next_request(&shown).is_none(), "same revision: wait");
    shown.content_revision = 3;
    assert!(
        search.next_request(&shown).is_none(),
        "odd revision: mid-write"
    );
    shown.content_revision = 4;
    let params = send(&mut search, &shown, "2", now);
    assert_eq!(params.content_revision, 4);
    assert!(
        search
            .answer("2", Ok(result(4, vec![range(1, 0, 0)], 0, 0)))
            .is_some()
    );
}

#[test]
fn other_errors_are_reported_and_cleared_by_the_next_edit() {
    let shown = pane(2, 0, 50);
    let mut search = Search::new(&shown);
    search.set_query("x");
    send(&mut search, &shown, "1", Instant::now());
    let error = herdr_client::Error::Endpoint {
        code: EndpointErrorCode::PaneNotFound,
        message: "pane not found: p".into(),
    };
    assert_eq!(search.answer("1", Err(error)), None);
    assert_eq!(search.error(), Some("pane not found: p"));
    assert!(search.next_request(&shown).is_none(), "no retry loop");
    search.set_query("xy");
    assert!(search.error().is_none());
    search.send_failed(&herdr_client::Error::Full);
    assert_eq!(search.error(), Some("client command queue is full"));
    assert!(search.next_request(&shown).is_none());
}

#[test]
fn changed_content_refreshes_in_place_at_a_bounded_rate() {
    let mut shown = pane(2, 0, 50);
    let mut search = Search::new(&shown);
    let start = Instant::now();
    search.set_query("x");
    send(&mut search, &shown, "1", start);
    // Rows 50..60 show; the match is on screen.
    let current = range(55, 4, 6);
    search.answer("1", Ok(result(2, vec![current], 0, 0)));

    shown.content_revision = 4;
    search.content_changed(&shown, start + REFRESH_INTERVAL / 2);
    assert!(
        search.next_request(&shown).is_none(),
        "too soon after the last search"
    );
    search.content_changed(&shown, start + REFRESH_INTERVAL);
    let params = send(&mut search, &shown, "2", start + REFRESH_INTERVAL);
    assert_eq!(params.direction, SearchDirection::Forward);
    assert_eq!(params.cursor, point(55, 3));
    assert_eq!(params.previous, None);
    // The old highlights stay up until the refresh lands, which does not
    // move the view.
    assert_eq!(search.highlights(&shown).len(), 1);
    assert_eq!(search.answer("2", Ok(result(4, vec![current], 0, 0))), None);
    search.content_changed(&shown, start + REFRESH_INTERVAL * 3);
    assert!(
        search.next_request(&shown).is_none(),
        "nothing changed since"
    );
}

#[test]
fn a_refresh_from_the_start_of_a_row_looks_from_the_previous_row() {
    assert_eq!(before(point(7, 0)), point(6, u16::MAX));
    assert_eq!(before(point(7, 5)), point(7, 4));
    assert_eq!(before(point(0, 0)), point(0, u16::MAX));
}

#[test]
fn highlights_map_through_the_scroll_and_clip_to_the_pane() {
    // Rows 40..50 show (max 50, offset 10); the pane sits at x 2, y 1.
    let shown = pane(2, 10, 50);
    let mut search = Search::new(&shown);
    search.set_query("x");
    send(&mut search, &shown, "1", Instant::now());
    let wrapped = TextRange {
        start: point(39, 18),
        end: point(41, 3),
    };
    let matches = vec![range(10, 0, 3), wrapped, range(45, 5, 7), range(49, 19, 30)];
    search.answer("1", Ok(result(2, matches, 2, 7)));
    let highlights = search.highlights(&shown);
    assert_eq!(
        highlights,
        vec![
            Highlight {
                row: 1,
                columns: 2..22,
                tint: Tint::Match
            },
            Highlight {
                row: 2,
                columns: 2..6,
                tint: Tint::Match
            },
            Highlight {
                row: 6,
                columns: 7..10,
                tint: Tint::CurrentMatch
            },
            Highlight {
                row: 10,
                columns: 21..22,
                tint: Tint::Match
            },
        ]
    );
    let mut other = shown.clone();
    other.pane_id = "q".into();
    assert!(search.highlights(&other).is_empty());
    search.set_query("");
    assert!(search.highlights(&shown).is_empty());
    assert_eq!(search.label(), "");
}

#[test]
fn reveal_centers_a_match_out_of_view_and_leaves_one_in_view() {
    let shown = pane(2, 10, 50);
    assert_eq!(reveal_offset(&shown, range(45, 0, 1)), None);
    // Row 12 centered in 10 rows puts row 7 on top: offset 50 - 7.
    assert_eq!(reveal_offset(&shown, range(12, 0, 1)), Some(43));
    // Near the top of history the offset stops at its maximum.
    assert_eq!(reveal_offset(&shown, range(2, 0, 1)), Some(50));
    let mut alternate = shown.clone();
    alternate.scroll = None;
    assert_eq!(reveal_offset(&alternate, range(12, 0, 1)), None);
}

#[test]
fn labels_follow_the_answer() {
    let shown = pane(2, 0, 50);
    let mut search = Search::new(&shown);
    search.set_query("x");
    send(&mut search, &shown, "1", Instant::now());
    search.answer(
        "1",
        Ok(CopySearchResult {
            pane_id: "p".into(),
            content_revision: 2,
            matches: vec![],
            total: 0,
            current: None,
            current_global: None,
        }),
    );
    assert_eq!(search.label(), "No results");
    assert!(!search.has_matches());
    search.step(Step::Older);
    // Moving with no current match starts over from the anchor.
    let params = search.next_request(&shown).unwrap().1;
    assert_eq!(params.previous, None);
    assert_eq!(params.direction, SearchDirection::Backward);
}
