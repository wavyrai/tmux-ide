#![allow(clippy::unwrap_used)]
use super::*;
fn fixture() -> (ServerScope, EditorTarget, serde_json::Value) {
    let scope = ServerScope {
        server_id: format!("tmux-server.{}", "a".repeat(32)),
        generation: uuid::Uuid::new_v4().to_string(),
    };
    let target = EditorTarget {
        generation: scope.generation.clone(),
        workspace_name: "fixture".into(),
        live_session_id: format!("live-session.{}", "b".repeat(20)),
        semantic_pane_id: "pane.fixture".into(),
    };
    let mut context = serde_json::to_value(&target).unwrap();
    context["directory"] = serde_json::json!("/tmp/fixture");
    context["cwd"] = serde_json::json!({"kind":"project-relative","path":"."});
    let value = serde_json::json!({"version":1,"server":{"serverId":scope.server_id,"generation":scope.generation},"context":context});
    (scope, target, value)
}
#[test]
fn editor_observation_matches_every_selected_identity() {
    let (scope, target, value) = fixture();
    assert!(target.valid());
    assert_eq!(
        parse(&serde_json::to_vec(&value).unwrap(), &scope, &target)
            .unwrap()
            .directory(),
        "/tmp/fixture"
    );
    for field in [
        "generation",
        "workspaceName",
        "liveSessionId",
        "semanticPaneId",
    ] {
        let mut bad = value.clone();
        bad["context"][field] = serde_json::json!("other");
        assert!(matches!(
            parse(&serde_json::to_vec(&bad).unwrap(), &scope, &target),
            Err(Error::ServerChanged)
        ));
    }
    let mut bad = value;
    bad["server"]["generation"] = serde_json::json!(uuid::Uuid::new_v4().to_string());
    assert!(matches!(
        parse(&serde_json::to_vec(&bad).unwrap(), &scope, &target),
        Err(Error::ServerChanged)
    ));
}
#[test]
fn editor_paths_reject_uri_relative_escape_and_inconsistent_cwd() {
    let (scope, target, value) = fixture();
    for directory in [
        "file:///tmp/x",
        "https://example.com",
        "relative",
        "C:relative",
        "\\\\host",
        "",
        "/tmp/\0bad",
    ] {
        let mut bad = value.clone();
        bad["context"]["directory"] = serde_json::json!(directory);
        assert!(parse(&serde_json::to_vec(&bad).unwrap(), &scope, &target).is_err());
    }
    for path in [
        "../escape",
        "a/../../escape",
        "a\\..\\..\\escape",
        "/absolute",
        "C:relative",
    ] {
        let mut bad = value.clone();
        bad["context"]["cwd"]["path"] = serde_json::json!(path);
        assert!(parse(&serde_json::to_vec(&bad).unwrap(), &scope, &target).is_err());
    }
    let mut bad = value.clone();
    bad["context"]["cwd"] = serde_json::json!({"kind":"absolute","path":"/elsewhere"});
    assert!(parse(&serde_json::to_vec(&bad).unwrap(), &scope, &target).is_err());
    for directory in ["/tmp/a b", "C:\\folder", "\\\\host\\share\\folder"] {
        let mut good = value.clone();
        good["context"]["directory"] = serde_json::json!(directory);
        good["context"]["cwd"] = serde_json::json!({"kind":"absolute","path":directory});
        assert!(parse(&serde_json::to_vec(&good).unwrap(), &scope, &target).is_ok());
    }
}
#[test]
fn editor_observations_are_bounded_and_strict() {
    let (scope, target, value) = fixture();
    for field in ["context", "server"] {
        let mut bad = value.clone();
        bad[field]["unexpected"] = serde_json::json!(true);
        assert!(parse(&serde_json::to_vec(&bad).unwrap(), &scope, &target).is_err());
    }
    let mut bad = value;
    bad["context"]["directory"] = serde_json::json!(format!("/{}", "x".repeat(4096)));
    assert!(parse(&serde_json::to_vec(&bad).unwrap(), &scope, &target).is_err());
    assert!(parse(&vec![b' '; 32769], &scope, &target).is_err());
}
