#![allow(clippy::unwrap_used)]
use super::*;
fn scope() -> ServerScope {
    ServerScope {
        server_id: "tmux-server.0123456789abcdef0123456789abcdef".into(),
        generation: "d9c81ebd-5785-45a3-9206-a2aa497d68fc".into(),
    }
}
fn resource() -> serde_json::Value {
    let scope = scope();
    serde_json::json!({"version":1,"server":{"serverId":scope.server_id,"generation":scope.generation},"sessions":[{"liveSessionId":"live-session.0123456789abcdef0123","sessionName":"ordinary tmux","workspaceName":null,"paneCount":2}]})
}
#[test]
fn ordinary_sessions_do_not_gain_an_invented_workspace() {
    let result = parse(&serde_json::to_vec(&resource()).unwrap(), &scope()).unwrap();
    assert_eq!(result[0].workspace_name, None);
    assert_eq!(result[0].pane_count, 2);
}
#[test]
fn session_generation_and_required_fields_are_fenced() {
    let mut wrong = resource();
    wrong["server"]["generation"] = "different".into();
    assert!(matches!(
        parse(&serde_json::to_vec(&wrong).unwrap(), &scope()),
        Err(Error::ServerChanged)
    ));
    for field in ["liveSessionId", "sessionName", "workspaceName", "paneCount"] {
        let mut missing = resource();
        missing["sessions"][0]
            .as_object_mut()
            .unwrap()
            .remove(field);
        assert!(
            parse(&serde_json::to_vec(&missing).unwrap(), &scope()).is_err(),
            "{field}"
        );
    }
    let mut malformed = resource();
    malformed["sessions"][0]["liveSessionId"] = "display-name".into();
    assert!(parse(&serde_json::to_vec(&malformed).unwrap(), &scope()).is_err());
}

fn resource_v2() -> serde_json::Value {
    let mut value = resource();
    value["version"] = 2.into();
    let session = &mut value["sessions"][0];
    session["windowCount"] = 3.into();
    session["lastActivity"] = 1_793_635_178_i64.into();
    session["favicon"] = serde_json::json!({"mime": "image/svg+xml", "data": "PHN2Zy8+"});
    value
}
#[test]
fn version_2_carries_windows_activity_and_favicon() {
    let result = parse(&serde_json::to_vec(&resource_v2()).unwrap(), &scope()).unwrap();
    assert_eq!(result[0].window_count, Some(3));
    assert_eq!(result[0].last_activity, Some(1_793_635_178));
    let favicon = result[0].favicon.as_ref().unwrap();
    assert_eq!(
        (favicon.mime.as_str(), favicon.data.as_str()),
        ("image/svg+xml", "PHN2Zy8+")
    );
    // A later version is refused, even with every version 2 field in place.
    let mut future = resource_v2();
    future["version"] = 3.into();
    assert!(parse(&serde_json::to_vec(&future).unwrap(), &scope()).is_err());
    // Activity and favicon may be null; windows may not.
    let mut nulls = resource_v2();
    nulls["sessions"][0]["lastActivity"] = serde_json::Value::Null;
    nulls["sessions"][0]["favicon"] = serde_json::Value::Null;
    let result = parse(&serde_json::to_vec(&nulls).unwrap(), &scope()).unwrap();
    assert_eq!(
        (
            result[0].last_activity.is_none(),
            result[0].favicon.is_none()
        ),
        (true, true)
    );
    for broken in [
        serde_json::json!({"windowCount": serde_json::Value::Null}),
        serde_json::json!({"windowCount": 0}),
        serde_json::json!({"favicon": {"mime": "image/png", "data": "AA==", "extra": 1}}),
        serde_json::json!({"unknown": 1}),
    ] {
        let mut value = resource_v2();
        for (key, field) in broken.as_object().unwrap() {
            value["sessions"][0][key] = field.clone();
        }
        assert!(
            parse(&serde_json::to_vec(&value).unwrap(), &scope()).is_err(),
            "{broken}"
        );
    }
}
#[test]
fn version_1_still_parses_and_may_not_carry_version_2_fields() {
    let result = parse(&serde_json::to_vec(&resource()).unwrap(), &scope()).unwrap();
    assert_eq!(
        (
            result[0].window_count,
            result[0].last_activity,
            result[0].favicon.is_none()
        ),
        (None, None, true)
    );
    let mut mixed = resource();
    mixed["sessions"][0]["windowCount"] = 2.into();
    assert!(parse(&serde_json::to_vec(&mixed).unwrap(), &scope()).is_err());
    let mut future = resource();
    future["version"] = 3.into();
    assert!(parse(&serde_json::to_vec(&future).unwrap(), &scope()).is_err());
}
