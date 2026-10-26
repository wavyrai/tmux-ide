#![allow(clippy::unwrap_used)]
use super::*;
use serde_json::json;
#[test]
fn inherited_location_preserves_socket_commas_and_zero_ids() {
    let value = NativeSurfaceLocation::from_tmux("/tmp/with,comma/t.sock,123,0", "%0").unwrap();
    assert_eq!(
        serde_json::to_value(value).unwrap(),
        json!({"socketPath":"/tmp/with,comma/t.sock","serverPid":"123","sessionId":"$0","runtimePaneId":"%0"})
    );
}
#[test]
fn malformed_location_never_selects_another_source() {
    for tmux in [
        "",
        "/tmp/s,1",
        "relative,1,0",
        "/tmp/s,0,0",
        "/tmp/s,01,0",
        "/tmp/s,1,00",
        "/tmp/s\n,1,0",
    ] {
        assert!(NativeSurfaceLocation::from_tmux(tmux, "%0").is_err());
    }
    for pane in ["", "%01", "%1; kill-server", "pane.semantic"] {
        assert!(NativeSurfaceLocation::from_tmux("/tmp/s,1,0", pane).is_err());
    }
}
#[test]
fn resolved_context_grants_only_one_read_only_semantic_pane() {
    let scope = ServerScope {
        server_id: format!("tmux-server.{}", "a".repeat(32)),
        generation: uuid::Uuid::new_v4().to_string(),
    };
    let mut response = json!({"version":1,"server":scope,"context":{"generation":scope.generation,"workspaceName":"workspace","liveSessionId":format!("live-session.{}","a".repeat(20)),"pane":"pane.one"}});
    let context = parse(response.to_string().as_bytes(), &scope).unwrap();
    assert_eq!(context.selection.mode, ViewerMode::ReadOnly);
    assert_eq!(context.selection.visible_panes, ["pane.one"]);
    response["context"]["pane"] = json!("%0");
    assert!(parse(response.to_string().as_bytes(), &scope).is_err());
    response["context"]["pane"] = json!("pane.one");
    response["context"]["generation"] = json!(uuid::Uuid::new_v4());
    assert!(matches!(
        parse(response.to_string().as_bytes(), &scope),
        Err(Error::ServerChanged)
    ));
}
