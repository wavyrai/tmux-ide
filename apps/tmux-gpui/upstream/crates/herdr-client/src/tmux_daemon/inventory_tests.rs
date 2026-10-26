#![allow(clippy::unwrap_used)]
use super::*;
#[test]
fn inventory_cannot_change_scope_or_mint_duplicate_or_fallback_panes() {
    let scope = ServerScope {
        server_id: "tmux-server.0123456789abcdef0123456789abcdef".into(),
        generation: "d9c81ebd-5785-45a3-9206-a2aa497d68fc".into(),
    };
    let value = serde_json::json!({"version":1,"server":{"serverId":scope.server_id,"generation":scope.generation},"resource":{"workspaceName":"fixture","workspaceId":"workspace.fixture","sessionId":"session.0123456789abcdef","resourceRevision":1,"semanticPaneIds":["pane.first","pane.second"]}});
    assert_eq!(
        parse(&serde_json::to_vec(&value).unwrap(), &scope, "fixture")
            .unwrap()
            .len(),
        2
    );
    assert!(matches!(
        parse(&serde_json::to_vec(&value).unwrap(), &scope, "different"),
        Err(Error::ServerChanged)
    ));
    for panes in [
        vec!["pane.first", "pane.first"],
        vec!["pane.second", "pane.first"],
        vec!["terminal.discovered.fake"],
    ] {
        let mut bad = value.clone();
        bad["resource"]["semanticPaneIds"] = serde_json::json!(panes);
        assert!(parse(&serde_json::to_vec(&bad).unwrap(), &scope, "fixture").is_err());
    }
}
