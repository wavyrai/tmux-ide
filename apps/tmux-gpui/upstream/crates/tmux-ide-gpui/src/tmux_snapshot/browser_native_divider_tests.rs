use super::*;
#[test]
fn canonical_window_handles_are_preserved_without_reconstruction() {
    let source = WindowLink {
        live_session_id: "live-session.01234567890123456789".into(),
        link_id: format!("window-link.{}", "a".repeat(32)),
        expected_semantic_window_id: "window".into(),
        link_revision: 17,
    };
    assert_eq!(window_from(window(&source)), source);
}

#[test]
fn response_parser_rejects_mixed_status_unknown_fields_and_unsafe_sequences() {
    let base = serde_json::json!({"type":"native-split-layout-result","version":1,
        "id":"f8da3f73-66c3-4621-bf6f-547ee1d5fd1c","request":1,"sequence":1,"status":"failed"});
    assert!(SplitResponse::parse(base.to_string().as_bytes()).is_some());
    for (key, value) in [
        ("resource", serde_json::Value::Null),
        ("extra", true.into()),
        ("sequence", 0.into()),
        ("sequence", 9_007_199_254_740_992u64.into()),
        ("status", "ok".into()),
        ("version", 2.into()),
        ("id", "bad".into()),
    ] {
        let mut bad = base.clone();
        bad[key] = value;
        assert!(SplitResponse::parse(bad.to_string().as_bytes()).is_none());
    }
    assert!(SplitResponse::parse(&vec![b' '; 256 * 1024 + 1025]).is_none());
}
