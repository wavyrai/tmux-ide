//! Actual GPUI wheel dispatch, distinct from the upstream accumulator unit tests.
use super::*;
use core::prelude::v1::test;
use herdr_client::protocol::{CellData, FrameData};

fn prepare(view: &mut SnapshotView) {
    let frame = Arc::new(FrameData {
        width: 11,
        height: 9,
        cursor: None,
        hyperlinks: vec![],
        graphics: vec![],
        cells: vec![
            CellData {
                symbol: " ".into(),
                fg: 0,
                bg: 0,
                modifier: 0,
                skip: false,
                hyperlink: None
            };
            99
        ],
    });
    view.frame = Some(frame.clone());
    view.browser_state.frame = Some(frame);
    view.browser_state.request = view.browser_request;
    view.browser_state.selected_session = Some("session".into());
    view.browser_state.selected_pane = Some("pane-a".into());
    // Historical output intentionally denies command input, not local scroll.
    view.browser_state.input_ready = false;
    view.browser_state.regions = serde_json::from_str(r#"[{"id":"pane-a","left":0,"top":0,"width":5,"height":9},{"id":"pane-b","left":6,"top":0,"width":5,"height":9}]"#).unwrap();
    view.browser_state.panes = ["pane-a", "pane-b"]
        .into_iter()
        .map(|id| browser::Choice {
            id: id.into(),
            label: id.into(),
            pane_count: None,
            window_id: Some("window".into()),
            window_label: None,
        })
        .collect();
}
fn event(position: Point<Pixels>, fraction: f32) -> ScrollWheelEvent {
    ScrollWheelEvent {
        position,
        delta: ScrollDelta::Pixels(point(px(0.), px(fraction * crate::terminal::CELL_HEIGHT))),
        touch_phase: TouchPhase::Moved,
        ..Default::default()
    }
}
fn assert_scroll(receiver: &mpsc::Receiver<browser::Command>, request: u64, lines: i16) {
    assert!(
        matches!(receiver.try_recv().unwrap(), browser::Command::Input { request:r, id, input:Input::Scroll(n) } if r == request && id == "pane-a" && n == lines)
    );
    assert!(
        receiver.try_recv().is_err(),
        "wheel must not send command text, keys or resize"
    );
}

#[gpui::test]
fn painted_selected_history_wheel_accumulates_pixels_and_refuses_other_targets(
    cx: &mut TestAppContext,
) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = make_view(window, cx, sender);
        prepare(&mut view);
        view
    });
    cx.simulate_resize(size(px(640.), px(400.)));
    cx.update(|window, cx| {
        window.draw(cx).clear(cx);
    });
    receiver.try_iter().for_each(drop);
    let (selected, other, outside) = view.read_with(cx, |view, _| {
        assert!(!view.browser_state.input_ready);
        assert!(crate::tmux_snapshot::hit_regions::is_painted(
            view.frame.as_ref(),
            view.painted_frame.as_ref()
        ));
        let bounds = view.input_geometry.unwrap().0;
        let width = view.input_cell_width.unwrap();
        (
            bounds.origin + point(px(width * 2.), px(crate::terminal::CELL_HEIGHT * 2.)),
            bounds.origin + point(px(width * 7.), px(crate::terminal::CELL_HEIGHT * 2.)),
            bounds.origin + point(px(width * 12.), px(crate::terminal::CELL_HEIGHT * 2.)),
        )
    });
    cx.simulate_event(event(selected, 0.5));
    assert!(receiver.try_recv().is_err());
    cx.simulate_event(event(selected, 0.5));
    assert_scroll(&receiver, 7, 1);
    for refused in [other, outside] {
        cx.simulate_event(event(selected, 0.5));
        cx.simulate_event(event(refused, 1.));
        cx.simulate_event(event(selected, 0.5));
        assert!(
            receiver.try_recv().is_err(),
            "refused target must reset fractional remainder"
        );
        cx.simulate_event(event(selected, 0.5));
        assert_scroll(&receiver, 7, 1);
    }
    cx.simulate_event(ScrollWheelEvent {
        position: selected,
        delta: ScrollDelta::Lines(point(0., -2.)),
        ..event(selected, 0.)
    });
    assert_scroll(&receiver, 7, -2);
    cx.simulate_event(event(selected, 0.5));
    cx.simulate_event(ScrollWheelEvent {
        touch_phase: TouchPhase::Started,
        ..event(selected, 0.5)
    });
    assert!(receiver.try_recv().is_err());
    cx.simulate_event(event(selected, 0.5));
    assert_scroll(&receiver, 7, 1);
}

#[gpui::test]
fn actual_request_selection_does_not_carry_wheel_fraction_into_new_view(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = make_view(window, cx, sender);
        prepare(&mut view);
        view
    });
    cx.simulate_resize(size(px(640.), px(400.)));
    cx.update(|window, cx| {
        window.draw(cx).clear(cx);
    });
    receiver.try_iter().for_each(drop);
    let position = view.read_with(cx, |view, _| {
        view.input_geometry.unwrap().0.origin
            + point(
                px(view.input_cell_width.unwrap() * 2.),
                px(crate::terminal::CELL_HEIGHT * 2.),
            )
    });
    cx.simulate_event(event(position, 0.5));
    assert!(receiver.try_recv().is_err());
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.select(Selection::Pane("pane-a".into()), window, cx);
            assert_eq!(view.browser_request, 8);
            prepare(view); // A fresh verified publication for the new request.
        });
        window.draw(cx).clear(cx);
    });
    assert!(matches!(
        receiver.try_recv().unwrap(),
        browser::Command::Pane { request: 8, .. }
    ));
    assert!(receiver.try_recv().is_err());
    let position = view.read_with(cx, |view, _| {
        view.input_geometry.unwrap().0.origin
            + point(
                px(view.input_cell_width.unwrap() * 2.),
                px(crate::terminal::CELL_HEIGHT * 2.),
            )
    });
    cx.simulate_event(event(position, 0.5));
    assert!(receiver.try_recv().is_err());
    cx.simulate_event(event(position, 0.5));
    assert_scroll(&receiver, 8, 1);
}
