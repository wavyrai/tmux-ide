use super::*;
use serde_json::{Value, json};
fn envelope() -> Value {
    json!({"type":"native-terminal-open","version":1,"id":"b987f903-e864-43dd-8591-8d0a464ca6e8",
        "request":3,"liveSessionId":"session.one","capability":{
        "origin":"http://127.0.0.1:4000","hostClientId":"native.test","workspaceName":"test","selectedPane":"pane.one",
        "descriptor":{"protocolVersion":2,"webSocketUrl":"ws://127.0.0.1:4000/v2/terminal/pane-streams/redeem",
        "subprotocol":"tmux-ide.pane-stream.v2","redemptionTicket":"fixture-only","daemonInstanceId":"e01ce8ee-74d8-40d0-9a59-a096050a6ade",
        "requestId":"b987f903-e864-43dd-8591-8d0a464ca6e8","expiresAt":1,"panes":["pane.one"],"effectiveViewerMode":"interactive"}}})
}
#[test]
fn accepts_broker_open_and_close_envelopes() {
    assert!(matches!(
        Event::parse(envelope().to_string().as_bytes()),
        Ok(Event::Open { request: 3, .. })
    ));
    let close = json!({"type":"native-terminal-close","version":1,"id":"b987f903-e864-43dd-8591-8d0a464ca6e8","request":3});
    assert!(matches!(
        Event::parse(close.to_string().as_bytes()),
        Ok(Event::Close { request: 3, .. })
    ));
}
#[test]
fn rejects_wrong_scope_and_reusable_credentials() {
    let mut wrong = envelope();
    wrong["capability"]["selectedPane"] = json!("pane.other");
    assert!(matches!(
        Event::parse(wrong.to_string().as_bytes()),
        Err(Error::Selection)
    ));
    let mut owner = envelope();
    owner["capability"]["ownerToken"] = json!("must-not-cross");
    assert!(matches!(
        Event::parse(owner.to_string().as_bytes()),
        Err(Error::Json(_))
    ));
}
#[test]
fn rejects_bad_envelope_and_bounds() {
    for (key, value) in [
        ("request", json!(9_007_199_254_740_992_u64)),
        ("version", json!(2)),
        ("id", json!("bad")),
        ("liveSessionId", json!("")),
    ] {
        let mut invalid = envelope();
        invalid[key] = value;
        assert!(matches!(
            Event::parse(invalid.to_string().as_bytes()),
            Err(Error::Envelope)
        ));
    }
    assert!(matches!(
        Event::parse(&vec![b' '; 20 * 1024 + 1]),
        Err(Error::Bounds)
    ));
}

#[test]
fn graphics_offer_is_explicit_boolean_and_older_handoffs_default_disabled() {
    let original = envelope();
    assert!(
        matches!(Event::parse(original.to_string().as_bytes()),Ok(Event::Open{capability,..}) if !capability.graphics)
    );
    for enabled in [false, true] {
        let mut offered = envelope();
        offered["capability"]["graphics"] = json!(enabled);
        assert!(
            matches!(Event::parse(offered.to_string().as_bytes()),Ok(Event::Open{capability,..}) if capability.graphics==enabled)
        );
    }
    for invalid in [
        json!(null),
        json!(101),
        json!("true"),
        json!([101, 102, 103, 104]),
    ] {
        let mut offered = envelope();
        offered["capability"]["graphics"] = invalid;
        assert!(matches!(
            Event::parse(offered.to_string().as_bytes()),
            Err(Error::Json(_))
        ));
    }
}

#[test]
fn optional_history_server_scope_is_strict_and_bound_to_descriptor_generation() {
    let original = envelope();
    assert!(
        matches!(Event::parse(original.to_string().as_bytes()),Ok(Event::Open{capability,..}) if capability.server_scope.is_none())
    );
    let mut valid = original.clone();
    valid["capability"]["serverScope"] = json!({"serverId":format!("tmux-server.{}","a".repeat(32)),"generation":original["capability"]["descriptor"]["daemonInstanceId"]});
    assert!(
        matches!(Event::parse(valid.to_string().as_bytes()),Ok(Event::Open{capability,..}) if capability.server_scope.is_some())
    );
    for invalid in [
        json!(null),
        json!({"serverId":"bad","generation":original["capability"]["descriptor"]["daemonInstanceId"]}),
        json!({"serverId":format!("tmux-server.{}","a".repeat(32)),"generation":"b987f903-e864-43dd-8591-8d0a464ca6e8"}),
        json!({"serverId":format!("tmux-server.{}","a".repeat(32)),"generation":original["capability"]["descriptor"]["daemonInstanceId"],"ownerToken":"must-not-cross"}),
    ] {
        let mut changed = original.clone();
        changed["capability"]["serverScope"] = invalid;
        assert!(Event::parse(changed.to_string().as_bytes()).is_err());
    }
}

#[test]
fn catalog_only_requires_read_only_capability_and_explicit_boolean() {
    let original = envelope();
    assert!(
        matches!(Event::parse(original.to_string().as_bytes()), Ok(Event::Open { capability, .. }) if !capability.catalog_only)
    );
    for catalog in [false, true] {
        for mode in ["interactive", "read-only"] {
            let mut value = original.clone();
            value["capability"]["catalogOnly"] = json!(catalog);
            value["capability"]["descriptor"]["effectiveViewerMode"] = json!(mode);
            let parsed = Event::parse(value.to_string().as_bytes());
            if catalog && mode == "interactive" {
                assert!(matches!(parsed, Err(Error::Selection)));
            } else {
                assert!(
                    matches!(parsed, Ok(Event::Open { capability, .. }) if capability.catalog_only == catalog)
                );
            }
        }
    }
    for invalid in [json!(null), json!(1), json!("true"), json!([])] {
        let mut value = original.clone();
        value["capability"]["catalogOnly"] = invalid;
        assert!(matches!(
            Event::parse(value.to_string().as_bytes()),
            Err(Error::Json(_))
        ));
    }
    let mut outside = original;
    outside["capability"]["catalogOnly"] = json!(true);
    outside["capability"]["descriptor"]["effectiveViewerMode"] = json!("read-only");
    outside["capability"]["selectedPane"] = json!("pane.outside");
    assert!(matches!(
        Event::parse(outside.to_string().as_bytes()),
        Err(Error::Selection)
    ));
}

#[test]
fn local_root_is_explicit_strict_and_canonical_generation_is_not_scope_generation() {
    let generation = "11111111-1111-4111-8111-111111111111";
    let mut value = envelope();
    value["capability"]["graphics"] = json!(true);
    value["capability"]["localImages"] =
        json!({"root":format!("/private/test/local-images-{generation}"),"generation":generation});
    assert_eq!(
        Event::parse(value.to_string().as_bytes()).is_ok(),
        cfg!(unix)
    );
    for root in [
        json!(null),
        json!({"root":"/tmp/elsewhere","generation":generation}),
        json!({"root":format!("/private/test/local-images-{generation}"),"generation":generation,"unknown":true}),
        json!({"root":format!("relative/local-images-{generation}"),"generation":generation}),
    ] {
        let mut bad = value.clone();
        bad["capability"]["localImages"] = root;
        assert!(Event::parse(bad.to_string().as_bytes()).is_err());
    }
    value["capability"]["graphics"] = json!(false);
    assert!(Event::parse(value.to_string().as_bytes()).is_err());
    assert!(
        matches!(Event::parse(envelope().to_string().as_bytes()),Ok(Event::Open{capability,..}) if capability.local_images.is_none())
    );
}

#[path = "tmux_handoff_binary_tests.rs"]
mod binary;

#[test]
fn broker_json_cannot_inject_native_remote_identity() {
    for value in [json!(null), json!({"pid":123})] {
        let mut wrong = envelope();
        wrong["capability"]["remotePeer"] = value;
        assert!(matches!(
            Event::parse(wrong.to_string().as_bytes()),
            Err(Error::Json(_))
        ));
    }
}

#[test]
fn pipe_json_cannot_enable_native_surface_authority() {
    let mut value = envelope();
    value["capability"]["nativeSurfaces"] = json!(true);
    assert!(matches!(
        Event::parse(value.to_string().as_bytes()),
        Err(Error::Json(_))
    ));
}

#[test]
fn broker_json_cannot_supply_the_daemon_version() {
    let mut value = envelope();
    value["capability"]["daemonVersion"] = json!("2.9.15");
    assert!(matches!(
        Event::parse(value.to_string().as_bytes()),
        Err(Error::Json(_))
    ));
    match Event::parse(envelope().to_string().as_bytes()) {
        Ok(Event::Open { capability, .. }) => assert_eq!(capability.daemon_version, None),
        _ => panic!("expected open"),
    }
}
