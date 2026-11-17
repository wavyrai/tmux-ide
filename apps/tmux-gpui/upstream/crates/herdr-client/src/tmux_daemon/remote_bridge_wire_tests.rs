use super::*;
use serde_json::json;

fn capabilities(remote_bridge: Option<serde_json::Value>) -> Vec<u8> {
    let mut capabilities = json!({"appWindowMutation":{"available":true}});
    if let Some(offer) = remote_bridge {
        capabilities["remoteBridge"] = offer;
    }
    json!({"status":"ok","daemon":{},"capabilities":capabilities})
        .to_string()
        .into_bytes()
}

#[test]
fn an_older_daemon_without_the_field_offers_no_bridge() {
    assert!(!offers_clipboard(&capabilities(None)));
    assert!(!offers_clipboard(b"{}"));
    assert!(!offers_clipboard(b"not json"));
}

#[test]
fn only_version_one_on_the_bridge_path_with_remote_copy_counts() {
    let good = json!({"version":1,"path":"/api/v2/bridge","features":["clipboard-write"]});
    assert!(offers_clipboard(&capabilities(Some(good.clone()))));
    let more = json!({"version":1,"path":"/api/v2/bridge","features":["ports","clipboard-write"]});
    assert!(offers_clipboard(&capabilities(Some(more))));
    for (key, value) in [
        ("version", json!(2)),
        ("version", json!(0)),
        ("path", json!("/api/v2/other")),
        ("features", json!(["ports"])),
        ("features", json!([])),
    ] {
        let mut changed = good.clone();
        changed[key] = value;
        assert!(!offers_clipboard(&capabilities(Some(changed))), "{key}");
    }
    assert!(!offers_clipboard(&capabilities(Some(json!(null)))));
    let mut failed: serde_json::Value =
        serde_json::from_slice(&capabilities(Some(good))).unwrap_or_default();
    failed["status"] = json!("error");
    assert!(!offers_clipboard(failed.to_string().as_bytes()));
}

fn write(text: &str) -> serde_json::Value {
    json!({"type":"clipboard.write","session":"s","paneId":"pane.mirror.ab","incarnation":"g:0",
        "bytes":text.len(),"text":text})
}

#[test]
fn ready_must_be_version_one_with_remote_copy() {
    let ready = |version: u64, features: serde_json::Value| {
        receive(&json!({"type":"ready","version":version,"features":features}).to_string())
    };
    assert_eq!(ready(1, json!(["clipboard-write"])), Ok(Received::Ready));
    assert_eq!(
        ready(2, json!(["clipboard-write"])),
        Err(WireError::Version)
    );
    assert_eq!(ready(1, json!([])), Err(WireError::Version));
}

#[test]
fn a_copy_carries_its_pane_and_text() {
    assert_eq!(
        receive(&write("hi").to_string()),
        Ok(Received::Event(BridgeEvent::Clipboard {
            session: "s".into(),
            pane_id: "pane.mirror.ab".into(),
            incarnation: "g:0".into(),
            text: "hi".into(),
        }))
    );
    // Multi-byte text: bytes count UTF-8.
    let text = "héllo ✓";
    assert!(matches!(
        receive(&write(text).to_string()),
        Ok(Received::Event(BridgeEvent::Clipboard { .. }))
    ));
}

#[test]
fn unusable_copies_are_ignored_not_written() {
    let mut empty = write("");
    empty["bytes"] = json!(0);
    let mut wrong_count = write("hi");
    wrong_count["bytes"] = json!(3);
    let nul = write("a\0b");
    let large = write(&"x".repeat(MAX_TEXT_BYTES + 1));
    let mut no_pane = write("hi");
    no_pane["paneId"] = json!("");
    let mut long_pane = write("hi");
    long_pane["paneId"] = json!("p".repeat(257));
    for frame in [empty, wrong_count, nul, large, no_pane, long_pane] {
        assert_eq!(receive(&frame.to_string()), Ok(Received::Ignored));
    }
    let exact = write(&"x".repeat(MAX_TEXT_BYTES));
    assert!(matches!(
        receive(&exact.to_string()),
        Ok(Received::Event(_))
    ));
}

#[test]
fn a_refusal_names_its_size() {
    let refused = json!({"type":"clipboard.refused","session":"s","paneId":"p","incarnation":"g:0",
        "bytes":5_000_000,"reason":"too-large"});
    assert_eq!(
        receive(&refused.to_string()),
        Ok(Received::Event(BridgeEvent::TooLarge {
            session: "s".into(),
            pane_id: "p".into(),
            incarnation: "g:0".into(),
            bytes: 5_000_000,
        }))
    );
    let mut other = refused.clone();
    other["reason"] = json!("other");
    assert_eq!(receive(&other.to_string()), Ok(Received::Ignored));
}

#[test]
fn unknown_kinds_are_ignored_and_known_kinds_are_strict() {
    assert_eq!(
        receive(r#"{"type":"port.added","port":3000}"#),
        Ok(Received::Ignored)
    );
    let mut extra = write("hi");
    extra["request"] = json!("clipboard");
    assert_eq!(receive(&extra.to_string()), Err(WireError::Malformed));
    let mut missing = write("hi");
    missing.as_object_mut().map(|o| o.remove("incarnation"));
    assert_eq!(receive(&missing.to_string()), Err(WireError::Malformed));
    assert_eq!(receive("[]"), Err(WireError::Malformed));
    assert_eq!(receive(r#"{"no":"type"}"#), Err(WireError::Malformed));
}

/// The app answers no daemon frame with data from the Mac: the only frame it
/// ever sends is the hello, and it names nothing but the version.
#[test]
fn the_hello_is_the_only_frame_the_app_sends() {
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(HELLO).ok(),
        Some(json!({"type":"hello","version":1}))
    );
}
