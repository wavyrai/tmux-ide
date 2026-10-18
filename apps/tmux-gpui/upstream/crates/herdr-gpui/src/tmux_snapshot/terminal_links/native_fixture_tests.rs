//! Real canonical bridge capture through parser and native click handler.
//! Geometry/paint completion are simulated; no physical UI or external URL opens.
use super::*;

const PUBLICATION: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../fixtures/nr04-links-publication.json"
));

fn prepare(view: &mut SnapshotView, cx: &mut Context<SnapshotView>) {
    let state = browser::fixture_state(PUBLICATION).unwrap();
    assert_eq!(state.request, 2);
    assert!(state.input_ready);
    let region = state.copy_region.as_ref().unwrap();
    assert_eq!(
        (region.left, region.top, region.width, region.height),
        (0, 1, 66, 40)
    );
    assert!(region.wrapped[4]);
    view.browser_request = state.request;
    view.apply_browser_state(Some(state), cx);
    let height = view.terminal_height();
    view.input_cell_width = Some(10.);
    view.input_geometry = Some((
        Bounds::new(point(px(0.), px(0.)), size(px(1320.), px(41. * height))),
        Bounds::default(),
    ));
    // Simulate completion of painting this exact parsed canonical frame.
    view.painted_frame = view.frame.clone();
}

fn click(
    view: &mut SnapshotView,
    column: u16,
    row: u16,
    window: &mut Window,
    cx: &mut Context<SnapshotView>,
) {
    let event = MouseDownEvent {
        position: point(
            px((f32::from(column) + 0.5) * 10.),
            px((f32::from(row) + 0.5) * view.terminal_height()),
        ),
        modifiers: Modifiers {
            platform: true,
            ..Default::default()
        },
        ..Default::default()
    };
    view.terminal_click(&event, window, cx);
}

#[gpui::test]
fn canonical_links_allow_exact_web_targets_without_terminal_input(cx: &mut TestAppContext) {
    for (column, row, expected) in [
        (5, 2, "https://example.invalid/a(b)".to_owned()),
        (5, 3, "http://example.invalid/ok".to_owned()),
        (5, 5, format!("https://example.invalid/{}", "w".repeat(58))),
    ] {
        let (sender, receiver) = mpsc::sync_channel(32);
        let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
        cx.update(|window, cx| {
            view.update(cx, |view, cx| {
                prepare(view, cx);
                receiver.try_iter().for_each(drop);
                click(view, column, row, window, cx);
                assert!(receiver.try_recv().is_err());
                assert!(view.selection.is_none());
            });
        });
        assert_eq!(cx.opened_url().as_deref(), Some(expected.as_str()));
    }
}

#[gpui::test]
fn canonical_links_refuse_unsafe_labels_and_adjacent_pane(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(32);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            prepare(view, cx);
            receiver.try_iter().for_each(drop);
            // file, javascript, mailto, OSC8 label, incomplete left prefix, right suffix.
            for (column, row) in [(5, 8), (5, 9), (5, 10), (5, 11), (61, 12), (72, 12)] {
                click(view, column, row, window, cx);
            }
            assert!(receiver.try_recv().is_err());
        });
    });
    assert!(cx.opened_url().is_none());
}

#[gpui::test]
fn canonical_links_refuse_stale_or_unavailable_admission(cx: &mut TestAppContext) {
    for refusal in 0..5 {
        let (sender, receiver) = mpsc::sync_channel(32);
        let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
        cx.update(|window, cx| {
            view.update(cx, |view, cx| {
                prepare(view, cx);
                assert!(view.terminal_input_ready());
                assert_eq!(
                    view.terminal_web_link(point(px(55.), px(2.5 * view.terminal_height())))
                        .as_deref(),
                    Some("https://example.invalid/a(b)")
                );
                match refusal {
                    0 => view.browser_state.request += 1,
                    1 => view.painted_frame = None,
                    2 => {
                        view.presence.set_active(false);
                    }
                    3 => {
                        view.open_picker(window, cx);
                        assert!(view.picker.is_some());
                    }
                    _ => view.marked = "composition".into(),
                }
                receiver.try_iter().for_each(drop);
                click(view, 5, 2, window, cx);
                assert!(receiver.try_recv().is_err());
            });
        });
        assert!(cx.opened_url().is_none());
    }
}
