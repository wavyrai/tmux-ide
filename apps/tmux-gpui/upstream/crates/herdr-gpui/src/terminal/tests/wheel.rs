use super::*;

fn hit(target: InputTarget, mouse_reporting: bool) -> WheelTarget {
    WheelTarget {
        target,
        mouse_reporting,
        bounds: Bounds::default(),
        position: ClientMousePosition::Cell { column: 2, row: 3 },
        geometry: None,
    }
}

fn lines(wheel: &mut WheelAccumulator, target: &WheelTarget, event: &ScrollWheelEvent) -> i16 {
    wheel.steps(target, event, 10., CELL_HEIGHT).lines
}

#[test]
fn wheel_preserves_fractions_and_resets_on_target_direction_or_gesture_change() {
    let mut wheel = WheelAccumulator::default();
    let pane = hit(InputTarget::Pane("pane".into()), false);
    let other = hit(InputTarget::Pane("other".into()), false);
    let popup = hit(InputTarget::Popup("other".into()), false);
    let mut event = ScrollWheelEvent {
        delta: ScrollDelta::Pixels(point(px(0.), px(12.))),
        touch_phase: TouchPhase::Moved,
        ..Default::default()
    };
    assert_eq!(lines(&mut wheel, &pane, &event), 0);
    assert_eq!(lines(&mut wheel, &pane, &event), 1);
    assert_eq!(lines(&mut wheel, &other, &event), 0);
    assert_eq!(lines(&mut wheel, &popup, &event), 0);
    event.touch_phase = TouchPhase::Started;
    assert_eq!(lines(&mut wheel, &popup, &event), 0);
    event.touch_phase = TouchPhase::Moved;
    event.delta = ScrollDelta::Lines(point(0., -1.));
    assert_eq!(lines(&mut wheel, &popup, &event), -1);
    event.delta = ScrollDelta::Lines(point(0., 1e9));
    assert_eq!(lines(&mut wheel, &popup, &event), 128);
    event.delta = ScrollDelta::Lines(point(10., 0.));
    assert_eq!(lines(&mut wheel, &popup, &event), 0);
}

#[test]
fn nonfinite_wheel_deltas_do_not_poison_fractional_motion() {
    for mouse_reporting in [false, true] {
        let pane = hit(InputTarget::Pane("pane".into()), mouse_reporting);
        for invalid in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
            for vertical in [false, true] {
                let delta = |value: f32| {
                    ScrollDelta::Lines(if vertical {
                        point(0., value)
                    } else {
                        point(value, 0.)
                    })
                };
                let step = |wheel: &mut WheelAccumulator, value: f32| {
                    let event = ScrollWheelEvent {
                        delta: delta(value),
                        touch_phase: TouchPhase::Moved,
                        ..Default::default()
                    };
                    let steps = wheel.steps(&pane, &event, 10., CELL_HEIGHT);
                    if vertical { steps.lines } else { steps.columns }
                };
                // Columns exist only for a mouse-reporting target.
                let scale = i16::from(vertical || mouse_reporting);
                let mut wheel = WheelAccumulator::default();
                assert_eq!(step(&mut wheel, 0.75), 0);
                assert_eq!(step(&mut wheel, invalid), 0);
                assert_eq!(step(&mut wheel, 0.25), scale);
                assert_eq!(step(&mut wheel, -1e9), -128 * scale);
                assert_eq!(step(&mut wheel, 0.), 0);
            }
        }
    }
}

#[test]
fn horizontal_wheel_accumulates_columns_by_cell_width_for_mouse_reporting_targets() {
    let mut wheel = WheelAccumulator::default();
    let pane = hit(InputTarget::Pane("pane".into()), true);
    let popup = hit(InputTarget::Popup("popup".into()), true);
    let plain = hit(InputTarget::Pane("plain".into()), false);
    let mut event = ScrollWheelEvent {
        delta: ScrollDelta::Pixels(point(px(6.), px(0.))),
        touch_phase: TouchPhase::Moved,
        ..Default::default()
    };
    let mut steps = |target: &WheelTarget, event: &ScrollWheelEvent| {
        wheel.steps(target, event, 10., CELL_HEIGHT)
    };
    // Pixel motion becomes columns by cell width, keeping the fraction.
    assert_eq!(steps(&pane, &event), WheelSteps::default());
    assert_eq!(
        steps(&pane, &event),
        WheelSteps {
            lines: 0,
            columns: 1
        }
    );
    // Reversing direction drops the fraction left over from the other way.
    event.delta = ScrollDelta::Pixels(point(px(-8.), px(0.)));
    assert_eq!(steps(&pane, &event), WheelSteps::default());
    assert_eq!(
        steps(&pane, &event),
        WheelSteps {
            lines: 0,
            columns: -1
        }
    );
    // A mostly vertical swipe's sideways drift is not a column, even
    // though cells are narrower than they are tall.
    event.delta = ScrollDelta::Pixels(point(px(-19.), px(20.)));
    assert_eq!(
        steps(&pane, &event),
        WheelSteps {
            lines: 1,
            columns: 0
        }
    );
    // A mostly horizontal one still carries its vertical lines.
    event.delta = ScrollDelta::Pixels(point(px(-30.), px(20.)));
    assert_eq!(
        steps(&pane, &event),
        WheelSteps {
            lines: 1,
            columns: -3
        }
    );
    // Discrete wheels report whole columns; a popup reports like a pane.
    event.delta = ScrollDelta::Lines(point(2., 0.));
    assert_eq!(
        steps(&popup, &event),
        WheelSteps {
            lines: 0,
            columns: 2
        }
    );
    // Without mouse reporting, Herdr would drop a horizontal wheel, so
    // nothing accumulates to leak out once reporting starts.
    event.delta = ScrollDelta::Pixels(point(px(25.), px(0.)));
    assert_eq!(steps(&plain, &event), WheelSteps::default());
    assert_eq!(steps(&plain, &event), WheelSteps::default());
    let plain = hit(InputTarget::Pane("plain".into()), true);
    event.delta = ScrollDelta::Pixels(point(px(5.), px(0.)));
    assert_eq!(steps(&plain, &event), WheelSteps::default());
}

#[test]
fn wheel_steps_become_one_event_per_axis_vertical_first() {
    let target = hit(InputTarget::Pane("pane".into()), true);
    let shift = Modifiers {
        shift: true,
        ..Default::default()
    };
    let events = |lines, columns| {
        target
            .wheel_events(WheelSteps { lines, columns }, shift)
            .map(|event| match event {
                ClientPaneInputEvent::Mouse {
                    kind,
                    position,
                    modifiers,
                    lines,
                    ..
                } => {
                    assert_eq!(position, ClientMousePosition::Cell { column: 2, row: 3 });
                    // Shift reaches the application as reported.
                    assert_eq!(modifiers, 1);
                    (kind, lines)
                }
                event => panic!("unexpected wheel event {event:?}"),
            })
            .collect::<Vec<_>>()
    };
    assert!(events(0, 0).is_empty());
    assert_eq!(events(2, 0), [(ClientMouseKind::ScrollUp, 2)]);
    assert_eq!(events(0, 3), [(ClientMouseKind::ScrollLeft, 3)]);
    assert_eq!(events(0, -128), [(ClientMouseKind::ScrollRight, 128)]);
    assert_eq!(
        events(-1, -2),
        [
            (ClientMouseKind::ScrollDown, 1),
            (ClientMouseKind::ScrollRight, 2)
        ]
    );
}

#[test]
fn wheel_uses_configured_height_only_for_pixel_deltas() {
    let mut wheel = WheelAccumulator::default();
    let pane = hit(InputTarget::Pane("pane".into()), true);
    let mut event = ScrollWheelEvent {
        delta: ScrollDelta::Pixels(point(px(0.), px(15.))),
        touch_phase: TouchPhase::Moved,
        ..Default::default()
    };
    assert_eq!(wheel.steps(&pane, &event, 10., 30.).lines, 0);
    assert_eq!(wheel.steps(&pane, &event, 10., 30.).lines, 1);
    event.delta = ScrollDelta::Lines(point(0., 2.));
    assert_eq!(wheel.steps(&pane, &event, 10., 30.).lines, 2);
}
