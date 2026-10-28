#![allow(clippy::unwrap_used)]
use super::*;
fn state() -> BrowserState {
    BrowserState {
        version: 1,
        instance: "12345678-1234-4234-8234-123456789abc".into(),
        pane: "%1".into(),
        tab: 1,
        revision: 7,
        enabled: true,
        url: "https://example.com".into(),
        title: "Example".into(),
        loading: false,
        can_go_back: false,
        can_go_forward: false,
    }
}
fn response(state: &BrowserState) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({"version":1,"state":state})).unwrap()
}
#[test]
fn mutation_response_cannot_replace_the_browser_instance_or_pane() {
    let original = state();
    let command = BrowserCommand::new(
        &original,
        BrowserAction::Navigate,
        Some("localhost:3000".into()),
    );
    let mut next = original.clone();
    next.revision += 1;
    next.url = "http://localhost:3000/".into();
    assert!(parse_response(&response(&next), Some(&command)).is_ok());
    next.instance = "22345678-1234-4234-8234-123456789abc".into();
    assert!(parse_response(&response(&next), Some(&command)).is_err());
    next = original;
    next.pane = "%2".into();
    assert!(parse_response(&response(&next), Some(&command)).is_err());
}
#[test]
fn browser_wire_rejects_unbounded_invalid_and_unknown_data() {
    let good = response(&state());
    assert!(parse_response(&good, None).unwrap().is_some());
    let mut bad: serde_json::Value = serde_json::from_slice(&good).unwrap();
    bad["state"]["terminalInput"] = "unexpected".into();
    assert!(parse_response(&serde_json::to_vec(&bad).unwrap(), None).is_err());
    for field in ["tab", "revision"] {
        for value in [0, SAFE + 1] {
            let mut bad: serde_json::Value = serde_json::from_slice(&good).unwrap();
            bad["state"][field] = value.into();
            assert!(parse_response(&serde_json::to_vec(&bad).unwrap(), None).is_err());
        }
    }
    assert!(parse_response(&vec![b' '; 128 * 1024 + 1], None).is_err());
    assert!(
        parse_response(b"{\"version\":1,\"state\":null}", None)
            .unwrap()
            .is_none()
    );
    let mut bad = state();
    bad.title = "x".repeat(2049);
    assert!(parse_response(&response(&bad), None).is_err());
}
#[test]
fn navigation_is_not_a_terminal_command_and_requires_bounded_text() {
    for value in ["", "  ", "https://example.com\nrm -rf /", "\0"] {
        assert!(
            !BrowserCommand::new(&state(), BrowserAction::Navigate, Some(value.into())).valid()
        );
    }
    assert!(!BrowserCommand::new(&state(), BrowserAction::Back, Some("x".into())).valid());
    assert!(!BrowserCommand::new(&state(), BrowserAction::Navigate, None).valid());
    assert!(
        BrowserCommand::new(
            &state(),
            BrowserAction::Navigate,
            Some("localhost:3000/a b".into())
        )
        .valid()
    );
}
