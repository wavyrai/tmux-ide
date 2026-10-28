use super::*;

fn canonical_state(axis: Axis) -> browser::State {
    let mut s = state(axis);
    s.selected_session = Some("live-session.11111111111111111111".into());
    let window = canonical::Window {
        live_session_id: s.selected_session.clone().unwrap(),
        link_id: "window-link.11111111111111111111111111111111".into(),
        expected_semantic_window_id: "window".into(),
        link_revision: 1,
    };
    s.split_layout = Some(canonical::Layout {
        version: 1,
        window,
        layout_id: "11111111-1111-4111-8111-111111111111".into(),
        cols: 11,
        rows: 9,
        panes: s
            .regions
            .iter()
            .map(|r| canonical::Pane {
                semantic_pane_id: r.id.clone(),
                left: r.left,
                top: r.top,
                width: r.width,
                height: r.height,
            })
            .collect(),
        splits: vec![canonical::Edge {
            split_id: "22222222-2222-4222-8222-222222222222".into(),
            axis,
            boundary: if axis == Axis::Cols { 5 } else { 4 },
            start: 0,
            length: if axis == Axis::Cols { 9 } else { 11 },
        }],
    });
    s.resize_token = None;
    s
}
#[test]
fn canonical_both_axes_emit_only_absolute_split_commands_and_latest_release() {
    for axis in [Axis::Cols, Axis::Rows] {
        let s = canonical_state(axis);
        let (x, y) = if axis == Axis::Cols {
            (5.5, 2.)
        } else {
            (2., 4.5)
        };
        let mut drag = Drag::begin(
            &s,
            bounds(),
            10.,
            crate::terminal::CELL_HEIGHT,
            point_at(x, y),
        )
        .unwrap();
        assert!(drag.command().is_none());
        let mut owner = Owner::default();
        owner.begin(&drag);
        let (tx, rx) = mpsc::sync_channel(8);
        owner.flush(&tx, true, true);
        let begin = serde_json::to_value(rx.recv().unwrap()).unwrap();
        assert_eq!(begin["type"], "split-gesture");
        assert_eq!(begin["phase"], "begin");
        assert_eq!(
            begin["target"]["boundary"],
            if axis == Axis::Cols { 5 } else { 4 }
        );
        assert!(drag.update(point_at(x + 2., y + 2.)));
        owner.offer(drag.cells, false);
        owner.flush(&tx, true, true);
        assert!(rx.try_recv().is_err(), "canonical split motion stays local");
        assert!(drag.update(point_at(x + 3., y + 3.)));
        owner.offer(drag.cells, true);
        owner.flush(&tx, false, true);
        let release = serde_json::to_value(rx.recv().unwrap()).unwrap();
        assert_eq!(release["type"], "split-gesture");
        assert_eq!(release["phase"], "release");
        assert_eq!(release["boundary"], if axis == Axis::Cols { 8 } else { 7 });
        assert!(rx.try_recv().is_err());
    }
}
#[test]
fn canonical_resource_mismatch_cannot_fall_back_to_inferred_pane_resize() {
    let mut s = canonical_state(Axis::Cols);
    s.resize_token = Some("312b2c16-a13d-4411-82e5-1fdb58adab92".into());
    s.split_layout.as_mut().unwrap().panes[0].width = 4;
    assert!(splits(&s).is_empty());
    assert!(
        Drag::begin(
            &s,
            bounds(),
            10.,
            crate::terminal::CELL_HEIGHT,
            point_at(5.5, 2.)
        )
        .is_none()
    );
}
#[test]
fn canonical_successor_requires_exact_current_resource_and_holds_pending_without_rebase() {
    let mut s = canonical_state(Axis::Cols);
    let drag = Drag::begin(
        &s,
        bounds(),
        10.,
        crate::terminal::CELL_HEIGHT,
        point_at(5.5, 2.),
    )
    .unwrap();
    let original = drag.split.canonical.clone().unwrap();
    s.split_gesture = Some(canonical::Ack {
        gesture: drag.gesture.clone().unwrap(),
        phase: gesture::Phase::Pending,
        revision: 1,
        boundary: 5,
        target: None,
    });
    s.split_layout = None;
    s.frame = None;
    s.input_ready = false;
    assert!(drag.compatible(&s));
    let mut next = canonical_state(Axis::Cols);
    next.split_layout.as_mut().unwrap().layout_id = "33333333-3333-4333-8333-333333333333".into();
    let layout = next.split_layout.as_ref().unwrap();
    let target = layout.target(&layout.splits[0]);
    next.split_gesture = Some(canonical::Ack {
        gesture: drag.gesture.clone().unwrap(),
        phase: gesture::Phase::Dragging,
        revision: 2,
        boundary: 5,
        target: Some(target),
    });
    assert!(drag.compatible(&next));
    next.split_gesture.as_mut().unwrap().target = Some(original);
    assert!(!drag.compatible(&next));
    next.request += 1;
    assert!(!drag.compatible(&next));
}
#[test]
fn canonical_segments_reject_content_and_crossings_without_inventing_ancestry() {
    let mut s = canonical_state(Axis::Cols);
    assert!(at(&s, 5.5, 2.).is_some());
    assert!(at(&s, 4.5, 2.).is_none());
    let layout = s.split_layout.as_mut().unwrap();
    layout.splits.push(canonical::Edge {
        split_id: "33333333-3333-4333-8333-333333333333".into(),
        axis: Axis::Rows,
        boundary: 2,
        start: 0,
        length: 11,
    });
    assert!(at(&s, 5.5, 2.5).is_none());
    assert!(at(&s, 5.5, 3.5).is_some());
    Arc::make_mut((s.frame.as_mut().unwrap()).legacy_mut()).cells[3 * 11 + 5].symbol = "X".into();
    assert!(at(&s, 5.5, 3.5).is_none());
}

#[gpui::test]
fn output_updates_do_not_disarm_painted_native_gutters(cx: &mut TestAppContext) {
    let (sender, _receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = make_view(window, cx, sender);
        view.browser_state = canonical_state(Axis::Cols);
        view.frame = view.browser_state.frame.clone();
        view
    });
    cx.update(|window, cx| window.draw(cx).clear(cx));
    cx.update(|_, cx| {
        view.update(cx, |view, cx| {
            let point = view.test_cell_point(5.5, 2.);
            Arc::make_mut(view.browser_state.frame.as_mut().unwrap().legacy_mut()).cells[0]
                .symbol = "new output".into();
            view.frame = view.browser_state.frame.clone();
            assert!(!hit_regions::is_painted(
                view.frame.as_ref(),
                view.painted_frame.as_ref()
            ));
            assert!(
                view.begin_divider(point, cx),
                "unchanged painted gutter must remain draggable"
            );
        })
    });
}
#[test]
fn painted_gutters_reject_changed_authority_geometry_and_content_insets() {
    let state = canonical_state(Axis::Cols);
    let mut owner = Owner::default();
    owner.record_painted_gutters(paint::Painted::capture(&state, 10., 20.));
    assert!(owner.matches_painted_gutters(&state, 10., 20.));
    assert!(!owner.matches_painted_gutters(&state, 11., 20.));
    for change in 0..5 {
        let mut changed = state.clone();
        match change {
            0 => changed.request += 1,
            1 => changed.presence_revision += 1,
            2 => {
                changed.split_layout.as_mut().unwrap().layout_id =
                    "33333333-3333-4333-8333-333333333333".into()
            }
            3 => changed.native_content_regions = vec![region("a", 0, 1, 5, 8)],
            _ => changed.retained_preview = true,
        }
        assert!(!owner.matches_painted_gutters(&changed, 10., 20.));
    }
}
