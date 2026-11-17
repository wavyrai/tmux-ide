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
            .panes
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

fn scope() -> ServerScope {
    ServerScope {
        server_id: "tmux-server.0123456789abcdef0123456789abcdef".into(),
        generation: "d9c81ebd-5785-45a3-9206-a2aa497d68fc".into(),
    }
}
fn v2() -> serde_json::Value {
    let scope = scope();
    serde_json::json!({"version":2,"server":{"serverId":scope.server_id,"generation":scope.generation},"resource":{"workspaceName":"fixture","workspaceId":"workspace.fixture","sessionId":"session.0123456789abcdef","resourceRevision":1,"semanticPaneIds":["pane.a","pane.b","pane.c"],"windows":[
        {"semanticWindowId":"window.one","active":false,"semanticPaneIds":["pane.b","pane.a"]},
        {"semanticWindowId":"window.two","active":true,"semanticPaneIds":["pane.c"]}]}})
}
/// #806: version 2 places each pane in its window, in tmux window order.
#[test]
fn version_2_lists_each_window_with_its_panes() {
    let parsed = parse(&serde_json::to_vec(&v2()).unwrap(), &scope(), "fixture").unwrap();
    assert_eq!(parsed.panes, ["pane.a", "pane.b", "pane.c"]);
    assert_eq!(
        parsed.windows.unwrap(),
        [
            InventoryWindow {
                id: "window.one".into(),
                active: false,
                panes: vec!["pane.b".into(), "pane.a".into()],
            },
            InventoryWindow {
                id: "window.two".into(),
                active: true,
                panes: vec!["pane.c".into()],
            },
        ]
    );
    // A pane of an unverified window is in no window.
    let mut partial = v2();
    partial["resource"]["windows"] = serde_json::json!([{"semanticWindowId":"window.two","active":true,"semanticPaneIds":["pane.c"]}]);
    let parsed = parse(&serde_json::to_vec(&partial).unwrap(), &scope(), "fixture").unwrap();
    assert_eq!(parsed.windows.unwrap().len(), 1);
}
#[test]
fn version_2_windows_cannot_invent_share_or_duplicate() {
    for windows in [
        // A pane that is not the workspace's.
        serde_json::json!([{"semanticWindowId":"window.one","active":false,"semanticPaneIds":["pane.z"]}]),
        // One pane in two windows.
        serde_json::json!([{"semanticWindowId":"window.one","active":false,"semanticPaneIds":["pane.a"]},{"semanticWindowId":"window.two","active":false,"semanticPaneIds":["pane.a"]}]),
        // The same pane twice in one window.
        serde_json::json!([{"semanticWindowId":"window.one","active":false,"semanticPaneIds":["pane.a","pane.a"]}]),
        // The same window twice.
        serde_json::json!([{"semanticWindowId":"window.one","active":false,"semanticPaneIds":["pane.a"]},{"semanticWindowId":"window.one","active":false,"semanticPaneIds":["pane.b"]}]),
        // Two active windows.
        serde_json::json!([{"semanticWindowId":"window.one","active":true,"semanticPaneIds":["pane.a"]},{"semanticWindowId":"window.two","active":true,"semanticPaneIds":["pane.b"]}]),
        // An invalid window id, and an empty window.
        serde_json::json!([{"semanticWindowId":"@1","active":false,"semanticPaneIds":["pane.a"]}]),
        serde_json::json!([{"semanticWindowId":"window.one","active":false,"semanticPaneIds":[]}]),
        // An unknown field.
        serde_json::json!([{"semanticWindowId":"window.one","active":false,"semanticPaneIds":["pane.a"],"extra":1}]),
    ] {
        let mut bad = v2();
        bad["resource"]["windows"] = windows.clone();
        assert!(
            parse(&serde_json::to_vec(&bad).unwrap(), &scope(), "fixture").is_err(),
            "{windows}"
        );
    }
    // Version 2 must list windows; version 1 must not.
    let mut missing = v2();
    missing["resource"]
        .as_object_mut()
        .unwrap()
        .remove("windows");
    assert!(parse(&serde_json::to_vec(&missing).unwrap(), &scope(), "fixture").is_err());
    let mut early = v2();
    early["version"] = 1.into();
    assert!(parse(&serde_json::to_vec(&early).unwrap(), &scope(), "fixture").is_err());
}
