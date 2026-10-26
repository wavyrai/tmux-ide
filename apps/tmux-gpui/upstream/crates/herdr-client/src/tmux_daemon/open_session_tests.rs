#![allow(clippy::unwrap_used)]
use super::*;
#[test]
fn opening_cannot_substitute_another_session_or_generation() {
    let scope = ServerScope {
        server_id: "tmux-server.0123456789abcdef0123456789abcdef".into(),
        generation: "d9c81ebd-5785-45a3-9206-a2aa497d68fc".into(),
    };
    let live = "live-session.0123456789abcdef0123";
    let value = serde_json::json!({"version":1,"server":{"serverId":scope.server_id,"generation":scope.generation},"workspaceName":"fixture","liveSessionId":live});
    assert_eq!(
        parse(&serde_json::to_vec(&value).unwrap(), &scope, live).unwrap(),
        "fixture"
    );
    for field in ["liveSessionId", "server", "workspaceName", "extra"] {
        let mut bad = value.clone();
        bad[field] = serde_json::json!("constructor");
        assert!(parse(&serde_json::to_vec(&bad).unwrap(), &scope, live).is_err());
    }
}
