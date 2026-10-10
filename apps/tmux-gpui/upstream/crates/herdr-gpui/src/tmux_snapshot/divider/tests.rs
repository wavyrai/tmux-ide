#![allow(clippy::unwrap_used)]
use super::*;
use core::prelude::v1::test;
use herdr_client::protocol::{CellData, FrameData};
use std::sync::Arc;
fn state(axis: Axis) -> browser::State {
    let regions = if axis == Axis::Cols {
        vec![region("a", 0, 0, 5, 9), region("b", 6, 0, 5, 9)]
    } else {
        vec![region("a", 0, 0, 11, 4), region("b", 0, 5, 11, 4)]
    };
    browser::State {
        request: 7,
        surface: browser::Surface::Workspace,
        input_ready: true,
        resize_token: Some("312b2c16-a13d-4411-82e5-1fdb58adab92".into()),
        selected_session: Some("session-a".into()),
        selected_pane: Some("a".into()),
        panes: regions
            .iter()
            .map(|r| browser::Choice {
                id: r.id.clone(),
                label: "Pane".into(),
                pane_count: None,
                window_id: Some("window".into()),
                window_label: None,
            })
            .collect(),
        regions,
        frame: Some(Arc::new(FrameData {
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
        })),
        ..Default::default()
    }
}
fn region(id: &str, left: u16, top: u16, width: u16, height: u16) -> hit_regions::Region {
    hit_regions::Region {
        id: id.into(),
        left,
        top,
        width,
        height,
    }
}
fn bounds() -> Bounds<Pixels> {
    Bounds::new(
        point(px(10.), px(20.)),
        size(px(110.), px(9. * crate::terminal::CELL_HEIGHT)),
    )
}
fn point_at(x: f32, y: f32) -> Point<Pixels> {
    bounds().origin + point(px(x * 10.), px(y * crate::terminal::CELL_HEIGHT))
}

#[test]
fn both_axes_commit_exact_outer_cells_only_after_motion_and_clamp_both_panes() {
    for axis in [Axis::Cols, Axis::Rows] {
        let s = state(axis);
        let start = if axis == Axis::Cols {
            (5.5, 2.)
        } else {
            (2., 4.5)
        };
        let mut drag = Drag::begin(&s, bounds(), 10., point_at(start.0, start.1)).unwrap();
        assert!(drag.command().is_none());
        let end = if axis == Axis::Cols {
            (7.5, 2.)
        } else {
            (2., 5.5)
        };
        assert!(drag.update(point_at(end.0, end.1)));
        let expected = if axis == Axis::Cols { 7 } else { 5 };
        assert!(
            matches!(drag.command(),Some(browser::Command::ResizePane{id,cells,axis:a,request:7,..}) if id=="a" && cells==expected && a==axis)
        );
        assert!(drag.update(point_at(-1000., -1000.)));
        assert_eq!(drag.cells, if axis == Axis::Cols { 2 } else { 3 });
        assert!(drag.update(point_at(10000., 10000.)));
        assert_eq!(
            drag.cells,
            drag.split.total - if axis == Axis::Cols { 2 } else { 3 }
        );
    }
}
#[test]
fn content_only_updates_survive_but_topology_lifetime_selection_and_presence_do_not() {
    let original = state(Axis::Cols);
    let drag = Drag::begin(&original, bounds(), 10., point_at(5.5, 2.)).unwrap();
    let mut busy = original.clone();
    Arc::make_mut(busy.frame.as_mut().unwrap()).cells[0].symbol = "busy".into();
    assert!(!Arc::ptr_eq(
        original.frame.as_ref().unwrap(),
        busy.frame.as_ref().unwrap()
    ));
    assert!(drag.compatible(&busy));
    for case in 0..8 {
        let mut changed = original.clone();
        match case {
            0 => changed.resize_token = Some("new lifetime".into()),
            1 => changed.regions[0].width = 4,
            2 => changed.request += 1,
            3 => changed.selected_session = Some("other".into()),
            4 => changed.selected_pane = Some("b".into()),
            5 => changed.presence_revision += 1,
            6 => changed.input_ready = false,
            _ => changed.frame = None,
        }
        assert!(!drag.compatible(&changed), "{case}");
    }
}
#[test]
fn content_outer_edges_nonoverlapping_splits_and_styled_gaps_are_not_handles() {
    let mut s = state(Axis::Cols);
    for (x, y) in [
        (0., 0.),
        (4.9, 2.),
        (6., 2.),
        (11., 2.),
        (-1., 2.),
        (f32::NAN, 2.),
    ] {
        assert!(at(&s, x, y).is_none());
    }
    assert!(at(&s, 5.5, 2.).is_some());
    Arc::make_mut(s.frame.as_mut().unwrap()).cells[27].bg = 0x123456;
    assert!(at(&s, 5.5, 2.).is_none());
    s = state(Axis::Cols);
    s.regions[1].top = 5;
    s.regions[1].height = 4;
    assert!(at(&s, 5.5, 2.).is_none());
    s = state(Axis::Cols);
    s.resize_token = None;
    assert!(at(&s, 5.5, 2.).is_none());
}

fn with_regions(regions: Vec<hit_regions::Region>) -> browser::State {
    let mut s = state(Axis::Cols);
    s.panes = regions
        .iter()
        .map(|r| pane(&r.id, Some("window")))
        .collect();
    s.regions = regions;
    s
}
#[test]
fn origin_t_and_inverse_t_segments_target_leading_pane_and_exclude_junctions() {
    for (regions, hits, junction) in [
        (
            vec![
                region("a", 0, 0, 5, 4),
                region("c", 0, 5, 5, 4),
                region("b", 6, 0, 5, 9),
            ],
            vec![(5., 2., "a", Axis::Cols), (5., 7., "c", Axis::Cols)],
            (5., 4.),
        ),
        (
            vec![
                region("a", 0, 0, 5, 9),
                region("b", 6, 0, 5, 4),
                region("c", 6, 5, 5, 4),
            ],
            vec![(5., 2., "a", Axis::Cols), (5., 7., "a", Axis::Cols)],
            (5., 4.),
        ),
        (
            vec![
                region("a", 0, 0, 5, 4),
                region("c", 6, 0, 5, 4),
                region("b", 0, 5, 11, 4),
            ],
            vec![(2., 4., "a", Axis::Rows), (8., 4., "c", Axis::Rows)],
            (5., 4.),
        ),
        (
            vec![
                region("a", 0, 0, 11, 4),
                region("b", 0, 5, 5, 4),
                region("c", 6, 5, 5, 4),
            ],
            vec![(2., 4., "a", Axis::Rows), (8., 4., "a", Axis::Rows)],
            (5., 4.),
        ),
    ] {
        let s = with_regions(regions);
        for (x, y, id, axis) in hits {
            let split = at(&s, x, y).unwrap();
            assert_eq!((split.id.as_str(), split.axis), (id, axis));
            let mut drag = Drag::begin(&s, bounds(), 10., point_at(x, y)).unwrap();
            assert!(drag.command().is_none());
            assert!(drag.update(point_at(x + 1., y + 1.)));
            assert!(
                matches!(drag.command(), Some(browser::Command::ResizePane { id: target, axis: actual, .. }) if target == id && actual == axis)
            );
        }
        assert!(at(&s, junction.0, junction.1).is_none());
    }
}
#[test]
fn nonorigin_alternating_axis_outer_boundaries_are_not_guessed_from_rectangles() {
    // The upper-left group has its own horizontal split. Resizing a1 can move
    // its inner boundary rather than the outer boundary facing the tall pane.
    let s = with_regions(vec![
        region("a0", 0, 0, 2, 4),
        region("a1", 3, 0, 2, 4),
        region("bottom", 0, 5, 5, 4),
        region("right", 6, 0, 5, 9),
    ]);
    assert!(at(&s, 5., 2.).is_none());
    assert!(at(&s, 2., 2.).is_some()); // Existing equal-span inner split.
    let transposed = with_regions(vec![
        region("a0", 0, 0, 5, 2),
        region("a1", 0, 3, 5, 2),
        region("right", 6, 0, 5, 5),
        region("bottom", 0, 6, 11, 3),
    ]);
    assert!(at(&transposed, 2., 5.).is_none());
    assert!(at(&transposed, 2., 2.).is_some());
}

use super::super::{decode, presence::Presence};
use std::{cell::RefCell, rc::Rc, sync::mpsc};
fn pane(id: &str, window: Option<&str>) -> browser::Choice {
    browser::Choice {
        id: id.into(),
        label: "Pane".into(),
        pane_count: None,
        window_id: window.map(str::to_owned),
        window_label: None,
    }
}
fn make_view(
    window: &mut Window,
    cx: &mut Context<SnapshotView>,
    sender: mpsc::SyncSender<browser::Command>,
) -> SnapshotView {
    let focus = cx.focus_handle();
    focus.focus(window, cx);
    let mut presence = Presence::new(true);
    presence.flush(&sender);
    presence.acknowledge(1);
    let frame = Arc::new(
        decode::frame(include_bytes!("../../../../../../fixtures/snapshot.json")).unwrap(),
    );
    SnapshotView {
        presence,
        _activation: None,
        _appearance: None,
        last_system: None,
        glass: Default::default(),
        last_workspace_session: None,
        pending_session_open: None,
        frame: Some(frame.clone()),
        browsing: true,
        terminal_focus: focus,
        input_interrupted: false,
        picker: None,
        pane_actions: None,
        new_session: None,
        new_session_queued: None,
        window_reveal: Default::default(),
        resize_gesture: Default::default(),
        last_resize: None,
        marked: String::new(),
        marked_selection: None,
        input_geometry: Some((
            Bounds::new(point(px(0.), px(0.)), size(px(500.), px(500.))),
            Bounds::default(),
        )),
        input_cell_width: Some(10.),
        painted_frame: Some(frame.clone()),
        selection: None,
        divider: None,
        wheel: crate::terminal::WheelRemainder::default(),
        browser_request: 7,
        browser_state: browser::State {
            surface: browser::Surface::Workspace,
            input_ready: true,
            sessions: vec![pane("session-a", None)],
            panes: vec![
                pane("pane-a", Some("window-a")),
                pane("pane-b", Some("window-b")),
            ],
            selected_session: Some("session-a".into()),
            selected_pane: Some("pane-a".into()),
            frame: Some(frame),
            regions: serde_json::from_str(
                r#"[{"id":"pane-a","left":0,"top":0,"width":1,"height":1}]"#,
            )
            .unwrap(),
            ..Default::default()
        },
        browser_commands: Some(sender),
        _browser_task: None,
        _task: None,
        painter: Rc::new(RefCell::new(
            crate::terminal_painter::TerminalPainter::default(),
        )),
    }
}

#[gpui::test]
fn native_handler_path_emits_one_resize_never_terminal_input_or_optimistic_frame(
    cx: &mut TestAppContext,
) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    receiver.try_iter().for_each(drop);
    cx.update(|_,cx|view.update(cx,|view,cx|{
        view.browser_state=state(Axis::Cols);
        view.frame=view.browser_state.frame.clone();view.painted_frame=view.frame.clone();
        view.input_geometry=Some((bounds(),Bounds::default()));view.input_cell_width=Some(10.);
        assert!(view.begin_divider(point_at(5.5,2.),cx));
        assert!(view.selection.is_none());
        assert!(!view.offer_terminal_input(cx));
        assert!(receiver.try_recv().is_err());
        // A fresh output frame with identical topology does not kill the gesture.
        Arc::make_mut(view.browser_state.frame.as_mut().unwrap()).cells[0].symbol="output".into();
        view.frame=view.browser_state.frame.clone();view.painted_frame=view.frame.clone();
        let actual=view.frame.clone().unwrap();
        view.move_divider(point_at(7.5,2.),false,cx);
        assert!(receiver.try_recv().is_err());
        view.move_divider(point_at(7.5,2.),true,cx);
        assert!(matches!(receiver.try_recv().unwrap(),browser::Command::ResizePane{request:7,id,cells:7,axis:Axis::Cols,..} if id=="a"));
        assert!(receiver.try_recv().is_err());assert!(view.divider.is_none());
        assert!(Arc::ptr_eq(view.frame.as_ref().unwrap(),&actual));
        // A changed pixel transform invalidates release, even when tokens match.
        assert!(view.begin_divider(point_at(5.5,2.),cx));
        view.input_cell_width=Some(11.);
        view.move_divider(point_at(7.5,2.),true,cx);
        assert!(receiver.try_recv().is_err());assert!(view.divider.is_none());
    }));
}

#[gpui::test]
fn native_lower_header_preserves_horizontal_drag_and_external_row_excludes_resize(
    cx: &mut TestAppContext,
) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = make_view(window, cx, sender);
        view.browser_state = state(Axis::Rows);
        view.frame = view.browser_state.frame.clone();
        view.painted_frame = view.frame.clone();
        view
    });
    receiver.try_iter().for_each(drop);
    cx.simulate_resize(size(px(900.), px(600.)));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    let header = cx.debug_bounds("pane-header-row").unwrap();
    let (grid, width) = view.read_with(cx, |view, _| {
        assert_eq!(
            view.lower_pane_headers(view.input_cell_width.unwrap())
                .len(),
            1
        );
        (
            view.input_geometry.unwrap().0,
            view.input_cell_width.unwrap(),
        )
    });
    assert_eq!(header.size.height, px(crate::terminal::CELL_HEIGHT));
    assert!(grid.top() >= header.bottom());
    let expected = crate::tmux_snapshot::geometry::cell_grid(
        f32::from(grid.size.width),
        f32::from(grid.size.height),
        width,
        crate::terminal::CELL_HEIGHT,
    )
    .unwrap();
    let commands: Vec<_> = receiver.try_iter().collect();
    assert!(commands.iter().any(|command| matches!(command,
        browser::Command::Input { input: crate::tmux_snapshot::keys::Input::Resize {cols,rows},.. }
        if (*cols,*rows)==expected)));
    let start = grid.origin + point(px(2. * width), px(4.5 * crate::terminal::CELL_HEIGHT));
    cx.simulate_mouse_down(start, MouseButton::Left, Modifiers::default());
    view.read_with(cx, |view, _| assert!(view.divider.is_some()));
    let end = start + point(px(0.), px(crate::terminal::CELL_HEIGHT));
    cx.simulate_mouse_move(end, Some(MouseButton::Left), Modifiers::default());
    cx.simulate_mouse_up(end, MouseButton::Left, Modifiers::default());
    assert!(receiver.try_iter().any(|command| matches!(
        command,
        browser::Command::ResizePane {
            axis: Axis::Rows,
            cells: 5,
            ..
        }
    )));
}

#[test]
fn continuous_owner_coalesces_motion_retains_release_and_orders_cancel_under_backpressure() {
    let mut s = state(Axis::Cols);
    s.resize_gesture_supported = true;
    let drag = Drag::begin(&s, bounds(), 10., point_at(5.5, 2.)).unwrap();
    let mut owner = Owner::default();
    owner.begin(&drag);
    let (sender, receiver) = mpsc::sync_channel(1);
    assert!(!owner.flush(&sender, true, true));
    owner.offer(6, false);
    owner.offer(7, false);
    owner.offer(8, false);
    owner.flush(&sender, true, true); // full: retain only latest target
    assert!(matches!(
        receiver.try_recv().unwrap(),
        browser::Command::ResizeGesture {
            update: gesture::Update::Begin { cells: 5, .. },
            ..
        }
    ));
    owner.flush(&sender, true, true);
    assert!(matches!(
        receiver.try_recv().unwrap(),
        browser::Command::ResizeGesture {
            update: gesture::Update::Move { cells: 8 },
            ..
        }
    ));
    owner.offer(7, true);
    owner.flush(&sender, false, true);
    assert!(matches!(
        receiver.try_recv().unwrap(),
        browser::Command::ResizeGesture {
            update: gesture::Update::Release { cells: 7 },
            ..
        }
    ));
    assert!(owner.busy()); // release is not an acknowledged completion
    s.resize_gesture = Some(gesture::Ack {
        gesture: drag.gesture.clone().unwrap(),
        id: "a".into(),
        axis: Axis::Cols,
        phase: gesture::Phase::Settled,
        revision: 2,
        token: s.resize_token.clone(),
        cells: 7,
    });
    owner.observe(&s);
    assert!(!owner.busy());
    owner.begin(&drag);
    owner.flush(&sender, true, true);
    owner.flush(&sender, false, false); // full: cancellation retained
    receiver.try_recv().unwrap();
    owner.flush(&sender, false, false);
    assert!(matches!(
        receiver.try_recv().unwrap(),
        browser::Command::ResizeGesture {
            update: gesture::Update::Cancel,
            ..
        }
    ));
    assert!(owner.busy()); // cancellation stays owned until acknowledged
    s.resize_gesture.as_mut().unwrap().phase = gesture::Phase::Cancelled;
    s.resize_gesture.as_mut().unwrap().revision = 3;
    owner.observe(&s);
    assert!(!owner.busy());
    owner.begin(&drag);
    owner.flush(&sender, false, false); // never-queued begin retires locally
    assert!(!owner.busy());
    assert!(receiver.try_recv().is_err());
}
#[test]
fn continuous_ack_preserves_pending_but_requires_same_settled_split_and_identity() {
    let mut s = state(Axis::Cols);
    s.resize_gesture_supported = true;
    let drag = Drag::begin(&s, bounds(), 10., point_at(5.5, 2.)).unwrap();
    s.resize_gesture = Some(gesture::Ack {
        gesture: drag.gesture.clone().unwrap(),
        id: "a".into(),
        axis: Axis::Cols,
        phase: gesture::Phase::Pending,
        revision: 1,
        token: None,
        cells: 5,
    });
    s.resize_token = None;
    assert!(drag.compatible(&s));
    let frame = s.frame.take();
    s.input_ready = false;
    assert!(
        drag.compatible(&s),
        "pending skew must retain gesture without input authority or frame"
    );
    s.frame = frame;
    s.input_ready = true;
    s.selected_pane = Some("b".into());
    assert!(!drag.compatible(&s));
    s.selected_pane = Some("a".into());
    let token = uuid::Uuid::new_v4().to_string();
    s.resize_token = Some(token.clone());
    s.regions[0].width = 7;
    s.regions[1].left = 8;
    s.regions[1].width = 3;
    let ack = s.resize_gesture.as_mut().unwrap();
    ack.phase = gesture::Phase::Dragging;
    ack.token = Some(token);
    ack.cells = 7;
    assert!(drag.compatible(&s));
    s.regions[1].id = "foreign-neighbor".into();
    assert!(!drag.compatible(&s));
    s.regions[1].id = "b".into();
    s.resize_gesture.as_mut().unwrap().gesture = uuid::Uuid::new_v4().to_string();
    assert!(!drag.compatible(&s));
}
#[gpui::test]
fn rendered_continuous_drag_sends_during_motion_and_final_cells_on_release(
    cx: &mut TestAppContext,
) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = make_view(window, cx, sender);
        view.browser_state = state(Axis::Cols);
        view.browser_state.resize_gesture_supported = true;
        view.frame = view.browser_state.frame.clone();
        view.painted_frame = view.frame.clone();
        view
    });
    cx.simulate_resize(size(px(900.), px(600.)));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    receiver.try_iter().for_each(drop);
    let (grid, width) = view.read_with(cx, |view, _| {
        (
            view.input_geometry.unwrap().0,
            view.input_cell_width.unwrap(),
        )
    });
    let start = grid.origin + point(px(5.5 * width), px(2. * crate::terminal::CELL_HEIGHT));
    cx.simulate_mouse_down(start, MouseButton::Left, Modifiers::default());
    view.update(cx, |view, cx| view.flush_resize_gesture(cx));
    assert!(matches!(
        receiver.try_recv().unwrap(),
        browser::Command::ResizeGesture {
            update: gesture::Update::Begin { .. },
            ..
        }
    ));
    let moved = start + point(px(2. * width), px(0.));
    cx.simulate_mouse_move(moved, Some(MouseButton::Left), Modifiers::default());
    view.update(cx, |view, cx| view.flush_resize_gesture(cx));
    assert!(matches!(
        receiver.try_recv().unwrap(),
        browser::Command::ResizeGesture {
            update: gesture::Update::Move { cells: 7 },
            ..
        }
    ));
    view.read_with(cx, |view, _| assert!(view.divider.is_some()));
    cx.simulate_mouse_up(moved, MouseButton::Left, Modifiers::default());
    view.update(cx, |view, cx| view.flush_resize_gesture(cx));
    assert!(matches!(
        receiver.try_recv().unwrap(),
        browser::Command::ResizeGesture {
            update: gesture::Update::Release { cells: 7 },
            ..
        }
    ));
    assert!(receiver.try_recv().is_err());
}

#[test]
fn healthy_idle_gesture_outlives_ten_seconds_but_stalled_transport_is_bounded() {
    let mut s = state(Axis::Cols);
    s.resize_gesture_supported = true;
    let drag = Drag::begin(&s, bounds(), 10., point_at(5.5, 2.)).unwrap();
    let mut owner = Owner::default();
    owner.begin(&drag);
    let (sender, receiver) = mpsc::sync_channel(1);
    let now = std::time::Instant::now();
    owner.flush_at(&sender, true, true, now);
    receiver.try_recv().unwrap();
    s.resize_gesture = Some(gesture::Ack {
        gesture: drag.gesture.clone().unwrap(),
        id: "a".into(),
        axis: Axis::Cols,
        phase: gesture::Phase::Dragging,
        revision: 1,
        token: s.resize_token.clone(),
        cells: 5,
    });
    owner.observe(&s);
    assert!(!owner.flush_at(
        &sender,
        true,
        true,
        now + std::time::Duration::from_secs(60)
    ));
    assert!(owner.busy());
    assert!(receiver.try_recv().is_err());
    let mut stalled = Owner::default();
    stalled.begin(&drag);
    sender
        .try_send(browser::Command::Home { request: 99 })
        .ok()
        .unwrap();
    assert!(stalled.flush_at(
        &sender,
        true,
        true,
        now + std::time::Duration::from_secs(13)
    ));
    assert!(!stalled.busy());
}

mod canonical_cases;
