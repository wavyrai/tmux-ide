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
