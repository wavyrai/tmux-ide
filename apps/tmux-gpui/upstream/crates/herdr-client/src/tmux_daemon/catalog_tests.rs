#![allow(clippy::unwrap_used)]
use super::*;
fn scope() -> ServerScope {
    ServerScope {
        server_id: format!("tmux-server.{}", "a".repeat(32)),
        generation: "d9c81ebd-5785-45a3-9206-a2aa497d68fc".into(),
    }
}
#[test]
fn environment_keys_match_helper_shape_across_aliases_and_separate_generations() {
    let identity = CatalogIdentity {
        instance_id: "daemon-one".into(),
        environment_id: Some("environment".into()),
    };
    let mut scope = scope();
    let key = identity
        .session_key("alias-one", &scope, "live-session.abc", false)
        .unwrap();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&key).unwrap(),
        serde_json::json!([
            "environment",
            "session",
            scope.server_id,
            scope.generation,
            "live-session.abc"
        ])
    );
    assert_eq!(
        key,
        identity
            .session_key("alias-two", &scope, "live-session.abc", false)
            .unwrap()
    );
    scope.generation = uuid::Uuid::new_v4().to_string();
    assert_ne!(
        key,
        identity
            .session_key("alias-one", &scope, "live-session.abc", false)
            .unwrap()
    );
    assert_eq!(identity.group_key("alias-one"), "environment");
}
#[test]
fn missing_or_conflicting_environment_uses_exact_nested_route_key() {
    let mut identity = CatalogIdentity {
        instance_id: "daemon".into(),
        environment_id: None,
    };
    let scope = scope();
    let key = identity
        .session_key("local", &scope, "live-session.abc", false)
        .unwrap();
    let source = serde_json::to_string(&serde_json::json!([
        scope.server_id,
        scope.generation,
        "live-session.abc"
    ]))
    .unwrap();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&key).unwrap(),
        serde_json::json!(["local", "session", source])
    );
    assert_ne!(
        key,
        identity
            .session_key("other", &scope, "live-session.abc", false)
            .unwrap()
    );
    assert_eq!(identity.group_key("local"), "local");
    identity.environment_id = Some("conflicted".into());
    assert_eq!(
        key,
        identity
            .session_key("local", &scope, "live-session.abc", true)
            .unwrap()
    );
}
