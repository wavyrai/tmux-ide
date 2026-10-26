#![allow(clippy::unwrap_used)]
use super::*;
fn fixture() -> (ServerScope, WindowLink, serde_json::Value) {
    let scope = ServerScope {
        server_id: format!("tmux-server.{}", "a".repeat(32)),
        generation: uuid::Uuid::new_v4().to_string(),
    };
    let window = WindowLink {
        live_session_id: format!("live-session.{}", "b".repeat(20)),
        link_id: format!("window-link.{}", "c".repeat(32)),
        expected_semantic_window_id: "window.fixture".into(),
        link_revision: 3,
    };
    let value = serde_json::json!({"version":1,"server":{"serverId":scope.server_id,"generation":scope.generation},"resource":{"version":1,"window":window,"layoutId":uuid::Uuid::new_v4().to_string(),"cols":80,"rows":24,"panes":[{"semanticPaneId":"pane.fixture","left":0,"top":0,"width":80,"height":24}],"splits":[]}});
    (scope, window, value)
}
#[test]
fn split_layout_is_fenced_to_the_exact_server_and_window_link() {
    let (scope, window, value) = fixture();
    assert!(parse(&serde_json::to_vec(&value).unwrap(), &scope, &window).is_ok());
    for field in [
        "liveSessionId",
        "linkId",
        "expectedSemanticWindowId",
        "linkRevision",
    ] {
        let mut bad = value.clone();
        bad["resource"]["window"][field] = if field == "linkRevision" {
            serde_json::json!(4)
        } else {
            serde_json::json!("other")
        };
        assert!(matches!(
            parse(&serde_json::to_vec(&bad).unwrap(), &scope, &window),
            Err(Error::ServerChanged)
        ));
    }
    let mut bad = value;
    bad["server"]["generation"] = serde_json::json!(uuid::Uuid::new_v4().to_string());
    assert!(matches!(
        parse(&serde_json::to_vec(&bad).unwrap(), &scope, &window),
        Err(Error::ServerChanged)
    ));
}
#[test]
fn invalid_split_geometry_keeps_its_control_error_source() {
    let (scope, window, mut value) = fixture();
    value["resource"]["panes"][0]["width"] = serde_json::json!(81);
    assert!(matches!(
        parse(&serde_json::to_vec(&value).unwrap(), &scope, &window),
        Err(Error::Control(crate::tmux_control::Error::Invalid))
    ));
    let mut invalid = window;
    invalid.link_revision = u64::MAX;
    assert!(invalid.validate().is_err());
}
