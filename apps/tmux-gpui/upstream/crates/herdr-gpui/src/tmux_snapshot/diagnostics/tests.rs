#![allow(clippy::unwrap_used)]
use super::*;
use serde_json::{Value, json};

fn group(phase: &str, failure: Value) -> Value {
    json!({
        "id": "SECRET_ID", "label": "/private/SECRET_PATH", "state": "disconnected",
        "conflict": false, "retry": "SECRET_TOKEN", "omittedSessions": 0, "sessions": [],
        "diagnostic": {"phase": phase, "failure": failure}
    })
}
fn state(groups: Vec<Value>) -> browser::State {
    browser::State {
        status: "SECRET_TERMINAL_AND_ERROR".into(),
        fleet: Some(serde_json::from_value(json!({"groups": groups, "omittedGroups": 0})).unwrap()),
        ..Default::default()
    }
}

#[test]
fn offline_and_developer_off_export_is_available_without_guessed_versions() {
    let text = build(&browser::State::default(), false).unwrap();
    let value: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(value["developerMode"], false);
    assert_eq!(value["inputReady"], false);
    for key in [
        "nativeVersion",
        "nativeBuild",
        "daemonVersion",
        "tmuxVersion",
    ] {
        assert!(value.get(key).unwrap().is_null());
    }
    assert_eq!(value["fleet"], json!({"states": [], "diagnostics": []}));
}

#[test]
fn export_deduplicates_and_never_copies_machine_or_terminal_details() {
    let row = group("needs-attention", json!("ssh-authentication"));
    let text = build(&state(vec![row.clone(), row]), false).unwrap();
    assert!(!text.contains("SECRET"));
    assert!(!text.contains("/private"));
    let value: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(value["fleet"]["states"], json!(["disconnected"]));
    assert_eq!(
        value["fleet"]["diagnostics"],
        json!([
            {"phase": "needs-attention", "failure": "ssh-authentication"}
        ])
    );
}

#[test]
fn every_enum_pair_is_bounded_and_order_independent() {
    let failures = [
        Value::Null,
        json!("unavailable"),
        json!("identity-mismatch"),
        json!("invalid-target"),
        json!("invalid-descriptor"),
        json!("incompatible"),
        json!("ssh-authentication"),
        json!("ssh-host-key"),
        json!("remote-cli-missing"),
        json!("daemon-missing"),
    ];
    let mut groups = Vec::new();
    for phase in [
        "connecting",
        "ready",
        "reconnecting",
        "needs-attention",
        "disconnected",
    ] {
        for failure in &failures {
            groups.push(group(phase, failure.clone()));
        }
    }
    let text = build(&state(groups.clone()), true).unwrap();
    assert!(text.len() <= MAX_BYTES);
    let value: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(value["fleet"]["diagnostics"].as_array().unwrap().len(), 50);
    groups.reverse();
    groups.extend(groups.clone());
    assert_eq!(text, build(&state(groups), true).unwrap());
}
