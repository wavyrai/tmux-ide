//! The sidebar builds only the rows near its visible part, and nothing a
//! user sees or does changes for it: the list keeps its length and every
//! row its place, the selected and the keyboard's rows stay built, rows
//! never measured are built, and an assistive client reads every row.
use super::*;

/// A workspace sidebar of `count` sessions, drawn twice: the first frame
/// measures every row, the second is planned from those sizes.
fn open(
    cx: &mut TestAppContext,
    count: usize,
) -> (
    Entity<SnapshotView>,
    &mut VisualTestContext,
    mpsc::Receiver<browser::Command>,
) {
    let (sender, receiver) = mpsc::sync_channel(256);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    cx.simulate_resize(size(px(1000.), px(700.)));
    cx.update(|_, cx| {
        view.update(cx, |view, _| {
            // No pane rows under the open session: row `i` is session `i`.
            view.browser_state.panes.clear();
            view.browser_state.sessions = (0..count)
                .map(|i| choice(&format!("s{i}"), &format!("project-{i}")))
                .collect();
            view.browser_state.selected_session = Some("s0".into());
        });
    });
    fresh(cx);
    fresh(cx);
    receiver.try_iter().for_each(drop);
    (view, cx, receiver)
}

/// A frame drawn uncached, as a refresh draws it.
fn fresh(cx: &mut VisualTestContext) {
    cx.update(|window, cx| {
        window.refresh();
        window.draw(cx).clear(cx);
    });
}

fn built(cx: &mut VisualTestContext, row: usize) -> bool {
    cx.debug_bounds(Box::leak(
        format!("tmux-sidebar-row-{row}").into_boxed_str(),
    ))
    .is_some()
}

/// Every child of the list as last laid out: the Home row, then each row.
fn layout(view: &Entity<SnapshotView>, cx: &mut VisualTestContext) -> Vec<Bounds<Pixels>> {
    view.read_with(cx, |view, _| {
        let scroll = &view.sidebar_keyboard.scroll;
        (0..scroll.children_count())
            .map_while(|index| scroll.bounds_for_item(index))
            .collect()
    })
}

fn with_assistive_client(cx: &mut VisualTestContext, on: bool) {
    cx.update(|window, cx| {
        window.set_a11y_active_for_test(on);
        window.refresh();
        window.draw(cx).clear(cx);
    });
}

/// Rows far below the visible part are placeholders, and each one is laid
/// out exactly where and as tall as its row was: the list keeps its length.
#[gpui::test]
fn far_rows_are_placeholders_of_their_measured_height(cx: &mut TestAppContext) {
    let (view, cx, _receiver) = open(cx, 100);
    assert!(built(cx, 0), "the first rows are on screen");
    assert!(built(cx, 10));
    assert!(
        !built(cx, 90),
        "row 90 is far below the list's visible part"
    );
    let windowed = layout(&view, cx);
    with_assistive_client(cx, true);
    let every = layout(&view, cx);
    assert_eq!(every.len(), 101, "the Home row and 100 rows");
    assert_eq!(windowed, every, "each placeholder sits where its row sits");
}

/// The list is exactly as long, and scrolls as far, as with every row built.
#[gpui::test]
fn the_list_is_as_long_with_placeholders(cx: &mut TestAppContext) {
    let (view, cx, _receiver) = open(cx, 100);
    let extent = |view: &Entity<SnapshotView>, cx: &mut VisualTestContext| {
        view.read_with(cx, |view, _| view.sidebar_keyboard.scroll.max_offset().y)
    };
    let windowed = extent(&view, cx);
    with_assistive_client(cx, true);
    assert!(windowed > px(0.), "100 rows overflow the list");
    assert_eq!(extent(&view, cx), windowed);
}

/// Rows near the visible part are built, and so is a row never measured,
/// wherever it is; it becomes a placeholder once it has been measured.
#[gpui::test]
fn near_rows_and_rows_never_measured_are_built(cx: &mut TestAppContext) {
    let (view, cx, _receiver) = open(cx, 100);
    // A quarter of the visible height below the bottom edge is still built.
    let list = cx.debug_bounds("session-list").unwrap();
    let last_built = (0..100).rev().find(|row| built(cx, *row)).unwrap();
    let edge = cx
        .debug_bounds(Box::leak(
            format!("tmux-sidebar-row-{last_built}").into_boxed_str(),
        ))
        .unwrap();
    assert!(edge.bottom() >= list.bottom() + list.size.height / 4. - px(40.));
    // Changed and drawn in one update: a notify alone would draw (and
    // measure) before the test looks.
    cx.update(|window, cx| {
        view.update(cx, |view, _| {
            view.browser_state
                .sessions
                .push(choice("s100", "never measured"));
        });
        window.refresh();
        window.draw(cx).clear(cx);
    });
    assert!(!built(cx, 90));
    assert!(built(cx, 100), "a new row is built before it is measured");
    fresh(cx);
    assert!(!built(cx, 100), "and is a placeholder once measured");
}

/// A row whose content changes is built and measured again, far or not.
#[gpui::test]
fn a_row_whose_content_changes_is_built_again(cx: &mut TestAppContext) {
    let (view, cx, _receiver) = open(cx, 100);
    assert!(!built(cx, 80));
    cx.update(|window, cx| {
        view.update(cx, |view, _| {
            view.browser_state.sessions[80].label = "renamed".into();
            view.browser_state.sessions[80].pane_count = Some(3);
        });
        window.refresh();
        window.draw(cx).clear(cx);
    });
    assert!(
        built(cx, 80),
        "its remembered size may no longer be its size"
    );
    // Rows above it keep their places; rows after it are built on this
    // frame, since where they sit now is not known.
    assert!(!built(cx, 70));
    fresh(cx);
    assert!(!built(cx, 80), "measured again, it is a placeholder again");
}

/// VoiceOver must reach every row: while an assistive client reads the
/// window every row is built; once it leaves the list is windowed again.
#[gpui::test]
fn an_assistive_client_reads_every_row(cx: &mut TestAppContext) {
    let (_view, cx, _receiver) = open(cx, 100);
    assert!(!built(cx, 90));
    with_assistive_client(cx, true);
    let missing: Vec<usize> = (0..100).filter(|row| !built(cx, *row)).collect();
    assert!(missing.is_empty(), "rows not built: {missing:?}");
    with_assistive_client(cx, false);
    assert!(built(cx, 0));
    assert!(!built(cx, 90), "windowed again once the client leaves");
}

/// The keyboard moving to a far row reveals it: the row is built, on screen,
/// and stays built while it is the keyboard's.
#[gpui::test]
fn the_keyboard_reveals_a_far_row_and_it_is_built(cx: &mut TestAppContext) {
    let (view, cx, receiver) = open(cx, 100);
    view.update(cx, |view, _| view.input_interrupted = true);
    crate::tmux_snapshot::fit_test_support::settle(&view, cx, &receiver);
    assert!(!built(cx, 99));
    cx.simulate_keystrokes("ctrl-g end");
    for _ in 0..3 {
        cx.update(|window, cx| window.draw(cx).clear(cx));
    }
    let list = cx.debug_bounds("session-list").unwrap();
    assert!(built(cx, 99), "the keyboard's row is built");
    let row = cx.debug_bounds("tmux-sidebar-row-99").unwrap();
    assert!(row.top() >= list.top() && row.bottom() <= list.bottom() + px(1.));
    fresh(cx);
    assert!(built(cx, 99), "and stays built while it is the keyboard's");
}
