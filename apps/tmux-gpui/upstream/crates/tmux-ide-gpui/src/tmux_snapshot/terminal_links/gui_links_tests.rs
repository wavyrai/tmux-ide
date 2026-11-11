//! Links cards 1, 2, 3 and 9: links open from any pane and on Shift-click
//! with a note, the hover cue, a remote machine's loopback links, and
//! double- or triple-click selection.
use super::*;

/// Two panes side by side, `pane-a` selected: a link in each.
fn two_panes(view: &mut SnapshotView) {
    historical_selection_tests::history(view);
    let mut frame = view.frame.as_ref().unwrap().legacy().as_ref().clone();
    let width = usize::from(frame.width);
    for cell in &mut frame.cells {
        cell.symbol = " ".into();
        cell.skip = false;
    }
    let mut put = |row: usize, column: usize, text: &str| {
        for (offset, c) in text.chars().enumerate() {
            frame.cells[row * width + column + offset].symbol = c.to_string();
        }
    };
    put(0, 0, "https://a.test/ x");
    put(1, 0, "cargo test_all ok");
    put(2, 30, "see http://b.test:8080/p");
    let frame = Arc::new(frame);
    for slot in [
        &mut view.frame,
        &mut view.browser_state.frame,
        &mut view.painted_frame,
    ] {
        *slot = Some(crate::tmux_snapshot::display_frame::DisplayFrame::Legacy(
            frame.clone(),
        ));
    }
    view.browser_state.regions = serde_json::from_str(
        r#"[{"id":"pane-a","left":0,"top":0,"width":30,"height":20},
            {"id":"pane-b","left":30,"top":0,"width":30,"height":20}]"#,
    )
    .unwrap();
    view.browser_state.native_content_regions = view.browser_state.regions.clone();
    view.browser_state.copy_region = Some(crate::tmux_snapshot::copy::Region {
        id: "pane-a".into(),
        left: 0,
        top: 0,
        width: 30,
        height: 20,
        wrapped: vec![false; 20],
    });
}

fn at(view: &SnapshotView, column: f32, row: f32) -> Point<Pixels> {
    view.test_cell_point(column + 0.5, row + 0.5)
}

fn press(position: Point<Pixels>, modifiers: Modifiers, clicks: usize) -> MouseDownEvent {
    MouseDownEvent {
        position,
        modifiers,
        click_count: clicks,
        ..Default::default()
    }
}

fn release(position: Point<Pixels>) -> MouseUpEvent {
    MouseUpEvent {
        position,
        button: MouseButton::Left,
        ..Default::default()
    }
}

fn toast(view: &SnapshotView) -> Option<String> {
    view.pointer
        .moving
        .toast
        .as_ref()
        .map(|t| t.text.to_string())
}

const CMD: Modifiers = Modifiers {
    control: false,
    alt: false,
    shift: false,
    platform: true,
    function: false,
};
const SHIFT: Modifiers = Modifiers {
    control: false,
    alt: false,
    shift: true,
    platform: false,
    function: false,
};

/// Card 1: a link in a pane that is not selected opens too, and a note
/// says what opened.
#[gpui::test]
fn a_link_in_another_pane_opens_with_a_note(cx: &mut TestAppContext) {
    let (sender, _receiver) = mpsc::sync_channel(32);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            two_panes(view);
            assert_eq!(view.browser_state.selected_pane.as_deref(), Some("pane-a"));
            let here = at(view, 36., 2.);
            view.terminal_click(&press(here, CMD, 1), window, cx);
            assert_eq!(
                toast(view).as_deref(),
                Some("Opened b.test:8080 in your browser")
            );
        })
    });
    assert_eq!(cx.opened_url().as_deref(), Some("http://b.test:8080/p"));
}

/// Card 1: Shift-click opens on release at the same cell; a Shift-drag
/// selects instead and opens nothing.
#[gpui::test]
fn shift_click_opens_on_release_and_shift_drag_does_not(cx: &mut TestAppContext) {
    let (sender, _receiver) = mpsc::sync_channel(32);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            two_panes(view);
            let here = at(view, 9., 0.);
            view.terminal_click(&press(here, SHIFT, 1), window, cx);
            let here = at(view, 12., 0.);
            view.terminal_release(&release(here), window, cx);
        })
    });
    assert!(cx.opened_url().is_none(), "a Shift-drag opened the link");
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            let here = at(view, 9., 0.);
            view.terminal_click(&press(here, SHIFT, 1), window, cx);
            let here = at(view, 9.2, 0.);
            view.terminal_release(&release(here), window, cx);
            assert!(view.selection.is_none());
        })
    });
    assert_eq!(cx.opened_url().as_deref(), Some("https://a.test/"));
}

/// Card 2: with Cmd held the cue marks exactly the link's cells; without
/// it, with a button held, or after the frame changes, there is none.
#[gpui::test]
fn the_hover_cue_marks_the_link_only_while_cmd_is_held(cx: &mut TestAppContext) {
    let (sender, _receiver) = mpsc::sync_channel(32);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    cx.update(|_, cx| {
        view.update(cx, |view, cx| {
            two_panes(view);
            let here = at(view, 36., 2.);
            view.update_link_hover(here, CMD, false, cx);
            let link = view.link_hover_shown(here).cloned().unwrap();
            assert_eq!(link.url, "http://b.test:8080/p");
            assert_eq!(link.cells, vec![(2, 34..54)]);
            assert!(view.link_underline(here).is_some());
            let away = at(view, 10., 5.);
            assert!(
                view.link_hover_shown(away).is_none(),
                "the pointer left the link"
            );
            let here = at(view, 36., 2.);
            view.update_link_hover(here, Modifiers::default(), false, cx);
            assert!(view.link_hover_shown(here).is_none());
            let here = at(view, 36., 2.);
            view.update_link_hover(here, CMD, true, cx);
            assert!(view.link_hover_shown(here).is_none());
            let here = at(view, 31., 2.);
            view.update_link_hover(here, CMD, false, cx);
            assert!(view.link_hover_shown(here).is_none(), "not over the link");
            let here = at(view, 36., 2.);
            view.update_link_hover(here, CMD, false, cx);
            let mut next = view.frame.as_ref().unwrap().legacy().as_ref().clone();
            next.cells[0].symbol = "Z".into();
            view.frame = Some(crate::tmux_snapshot::display_frame::DisplayFrame::Legacy(
                Arc::new(next),
            ));
            assert!(
                view.link_hover_shown(here).is_none(),
                "stale after a new frame"
            );
            assert!(view.link_underline(here).is_none());
        })
    });
}

/// Card 3: on a pane from another machine, a link to that machine's own
/// loopback address is refused with a note; other links still open.
#[gpui::test]
fn a_remote_machines_loopback_link_is_refused(cx: &mut TestAppContext) {
    let (sender, _receiver) = mpsc::sync_channel(32);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    cx.update(|_, cx| {
        view.update(cx, |view, cx| {
            two_panes(view);
            view.browser_state.remote_machine = Some(browser::RemoteMachine {
                label: "spark".into(),
                ssh_target: "me@spark".into(),
            });
            view.open_link("http://localhost:3000/app", cx);
            assert_eq!(
                toast(view).as_deref(),
                Some(
                    "localhost:3000 is on spark, not this Mac, so it can't open here. \
                     To view it on this Mac, forward the port: \
                     ssh -L 3000:localhost:3000 me@spark"
                )
            );
        })
    });
    assert!(cx.opened_url().is_none());
    cx.update(|_, cx| {
        view.update(cx, |view, cx| {
            view.open_link("https://example.test/", cx);
        })
    });
    assert_eq!(cx.opened_url().as_deref(), Some("https://example.test/"));
    cx.update(|_, cx| {
        view.update(cx, |view, cx| {
            view.browser_state.remote_machine = None;
            view.open_link("http://localhost:3000/app", cx);
        })
    });
    assert_eq!(
        cx.opened_url().as_deref(),
        Some("http://localhost:3000/app"),
        "a local pane's loopback link opens"
    );
}

/// Card 9: double-click selects the word, triple-click the line.
#[gpui::test]
fn double_and_triple_click_select_a_word_and_a_line(cx: &mut TestAppContext) {
    let (sender, _receiver) = mpsc::sync_channel(32);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            two_panes(view);
            let here = at(view, 8., 1.);
            view.terminal_click(&press(here, Modifiers::default(), 2), window, cx);
            assert_eq!(view.selection.as_ref().unwrap().text().unwrap(), "test_all");
            let here = at(view, 8., 1.);
            view.terminal_release(&release(here), window, cx);
            let here = at(view, 8., 1.);
            view.terminal_click(&press(here, Modifiers::default(), 3), window, cx);
            assert_eq!(
                view.selection.as_ref().unwrap().text().unwrap(),
                "cargo test_all ok"
            );
        })
    });
}
