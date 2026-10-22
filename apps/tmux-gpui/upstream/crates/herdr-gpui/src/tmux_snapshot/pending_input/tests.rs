use super::*;
use core::prelude::v1::test;
fn pending() -> Pending {
    Pending {
        request: 8,
        id: "pane-b".into(),
        token: "a".repeat(64),
        session: "session".into(),
        presence: 1,
        started: Instant::now(),
        inputs: Vec::new(),
        bytes: 0,
    }
}
#[test]
fn bounded_fifo_preserves_text_paste_and_keys_without_splitting() {
    let mut p = pending();
    assert!(p.push(Input::Text("é".into())));
    assert!(p.push(Input::Paste("one\ntwo".into())));
    assert!(p.push(Input::Key("Enter".into())));
    assert_eq!(
        p.inputs,
        vec![
            Input::Text("é".into()),
            Input::Paste("one\ntwo".into()),
            Input::Key("Enter".into())
        ]
    );
    assert!(!p.push(Input::Text("x".repeat(65536))));
    assert_eq!(p.inputs.len(), 3);
    for _ in 3..64 {
        assert!(p.push(Input::Key("Left".into())));
    }
    assert!(!p.push(Input::Key("Enter".into())));
    assert!(!p.push(Input::Scroll(1)));
}
#[test]
fn target_proofs_are_bounded_unique_and_strict() {
    let target = || Target {
        id: "pane-b".into(),
        token: "a".repeat(64),
    };
    assert!(validate_targets(&[target()]).is_ok());
    assert!(validate_targets(&[target(), target()]).is_err());
    assert!(
        validate_targets(&[Target {
            token: "A".repeat(64),
            ..target()
        }])
        .is_err()
    );
    assert!(
        validate_targets(&[Target {
            id: "\n".into(),
            ..target()
        }])
        .is_err()
    );
    assert!(
        validate_targets(
            &(0..25)
                .map(|n| Target {
                    id: n.to_string(),
                    ..target()
                })
                .collect::<Vec<_>>()
        )
        .is_err()
    );
}
