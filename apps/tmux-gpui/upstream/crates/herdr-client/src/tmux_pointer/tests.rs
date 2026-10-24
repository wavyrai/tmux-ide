#![allow(clippy::unwrap_used)]
use super::*;
fn scope() -> Scope {
    Scope {
        generation: "generation".into(),
        incarnation: "pane:1".into(),
        presentation_epoch: 1,
        cols: 16384,
        rows: 16384,
        protocol: Some(MouseProtocol::Any),
        encoding: Some(MouseEncoding::Sgr),
        alternate_screen: false,
    }
}
fn report(action: Action, gesture: u64) -> PointerEvent {
    PointerEvent::Report(Report {
        action,
        gesture,
        row: 2,
        col: 4,
        button: if action == Action::Move {
            None
        } else {
            Some(2)
        },
        modifiers: Modifiers {
            shift: false,
            alt: true,
            control: true,
        },
        cols: 16384,
        rows: 16384,
        protocol: MouseProtocol::Any,
        encoding: MouseEncoding::Sgr,
    })
}
#[test]
fn production_bridge_sgr_pointer_and_batched_wheel_vectors_match() {
    let vectors: serde_json::Value = serde_json::from_str(include_str!("vectors.json")).unwrap();
    let scope = scope();
    for (index, action) in [Action::Down, Action::Drag, Action::Up, Action::Move]
        .into_iter()
        .enumerate()
    {
        let mut owner = MouseOwner::default();
        if matches!(action, Action::Drag | Action::Up) {
            owner.route(&scope, report(Action::Down, 1));
        }
        let PointerDecision::Input(Input::Text(text)) = owner.route(&scope, report(action, 1))
        else {
            panic!("input expected")
        };
        assert_eq!(
            text,
            vectors["pointers"][index]["expected"]["data"]
                .as_str()
                .unwrap()
        );
    }
    for vector in vectors["wheels"].as_array().unwrap() {
        let lines = vector["lines"].as_i64().unwrap() as i16;
        let WheelDecision::Application { inputs } = route_wheel(
            &scope,
            0,
            WheelEvent {
                lines,
                row: 16383,
                col: 16383,
                modifiers: Modifiers {
                    shift: false,
                    alt: true,
                    control: true,
                },
            },
        ) else {
            panic!("application expected")
        };
        let actual = inputs
            .into_iter()
            .map(|input| match input {
                Input::Text(text) => {
                    assert!(text.len() <= 1024);
                    text
                }
                _ => panic!("text"),
            })
            .collect::<Vec<_>>();
        let expected = vector["expected"]["inputs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|input| input["data"].as_str().unwrap().to_owned())
            .collect::<Vec<_>>();
        assert_eq!(actual, expected);
    }
}
#[test]
fn gestures_retire_on_scope_or_focus_change_without_replay() {
    for change in 0..7 {
        let mut owner = MouseOwner::default();
        let original = scope();
        assert!(matches!(
            owner.route(&original, report(Action::Down, 1)),
            PointerDecision::Input(_)
        ));
        let mut changed = original.clone();
        match change {
            0 => changed.generation.push('x'),
            1 => changed.incarnation.push('x'),
            2 => changed.presentation_epoch += 1,
            3 => changed.cols -= 1,
            4 => changed.protocol = Some(MouseProtocol::Vt200),
            5 => changed.alternate_screen = true,
            _ => {}
        };
        owner.observe(if change == 6 { None } else { Some(&changed) });
        assert!(matches!(
            owner.route(&original, report(Action::Up, 1)),
            PointerDecision::Ignore
        ));
        assert!(matches!(
            owner.route(&original, report(Action::Down, 1)),
            PointerDecision::Ignore
        ));
        assert!(matches!(
            owner.route(&original, report(Action::Down, 2)),
            PointerDecision::Input(_)
        ));
    }
}
#[test]
fn cancellation_hover_and_button_fences() {
    let scope = scope();
    let mut owner = MouseOwner::default();
    assert!(matches!(
        owner.route(&scope, report(Action::Move, 1)),
        PointerDecision::Input(_)
    ));
    assert!(matches!(
        owner.route(&scope, report(Action::Move, 1)),
        PointerDecision::Ignore
    ));
    owner.route(&scope, report(Action::Down, 2));
    let PointerEvent::Report(mut up) = report(Action::Up, 2) else {
        panic!()
    };
    up.button = Some(1);
    assert!(matches!(
        owner.route(&scope, PointerEvent::Report(up)),
        PointerDecision::Ignore
    ));
    assert!(matches!(
        owner.route(&scope, report(Action::Drag, 2)),
        PointerDecision::Input(_)
    ));
    owner.route(&scope, PointerEvent::Cancel { gesture: 3 });
    assert!(matches!(
        owner.route(&scope, report(Action::Up, 2)),
        PointerDecision::Ignore
    ));
    assert!(matches!(
        owner.route(&scope, report(Action::Down, 3)),
        PointerDecision::Ignore
    ));
}
#[test]
fn shift_history_x10_and_legacy_encodings_are_explicit() {
    let mut scope = scope();
    let wheel = WheelEvent {
        lines: 1,
        row: 0,
        col: 0,
        modifiers: Modifiers::default(),
    };
    assert!(matches!(
        route_wheel(&scope, 1, wheel),
        WheelDecision::History { lines: 1 }
    ));
    assert!(matches!(
        route_wheel(
            &scope,
            0,
            WheelEvent {
                modifiers: Modifiers {
                    shift: true,
                    ..Default::default()
                },
                ..wheel
            }
        ),
        WheelDecision::History { .. }
    ));
    scope.protocol = Some(MouseProtocol::X10);
    assert!(matches!(
        route_wheel(&scope, 0, wheel),
        WheelDecision::History { .. }
    ));
    scope.protocol = Some(MouseProtocol::Any);
    for encoding in [MouseEncoding::Default, MouseEncoding::Utf8] {
        scope.encoding = Some(encoding.clone());
        assert!(matches!(
            route_wheel(&scope, 0, wheel),
            WheelDecision::Application { .. }
        ));
        let PointerEvent::Report(mut down) = report(Action::Down, 1) else {
            panic!()
        };
        down.encoding = encoding;
        let mut owner = MouseOwner::default();
        assert!(matches!(
            owner.route(&scope, PointerEvent::Report(down)),
            PointerDecision::Input(Input::Bytes(_))
        ));
        assert!(owner.held.is_some());
    }
    assert!(matches!(
        route_wheel(
            &scope,
            0,
            WheelEvent {
                lines: 129,
                ..wheel
            }
        ),
        WheelDecision::Ignore
    ));
}

#[test]
fn legacy_reports_match_tui_bytes_and_utf8_overflow() {
    let modifiers = Modifiers {
        alt: true,
        control: true,
        shift: false,
    };
    let hex = |input| match input {
        Some(Input::Bytes(data)) => data,
        _ => panic!("bytes expected"),
    };
    assert_eq!(
        hex(encode(
            &MouseEncoding::Default,
            0,
            300,
            200,
            false,
            modifiers
        )),
        "1b5b4d38e9ff"
    );
    assert_eq!(
        hex(encode(&MouseEncoding::Default, 2, 0, 0, true, modifiers)),
        "1b5b4d3b2121"
    );
    assert_eq!(
        hex(encode(
            &MouseEncoding::Utf8,
            0,
            2014,
            95,
            false,
            Modifiers::default()
        )),
        "1b5b4d20c280dfbf"
    );
    assert!(
        encode(
            &MouseEncoding::Utf8,
            0,
            2015,
            0,
            false,
            Modifiers::default()
        )
        .is_none()
    );
}
