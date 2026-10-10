use super::*;

#[gpui::test]
fn open_worktree_replies_cannot_revive_dismissed_or_stale_pickers(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(fixture_window);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            let original = view.live.snapshot.clone();
            for (change, opening) in (0..7).flat_map(|change| [false, true].map(|opening| (change, opening))) {
                view.live.snapshot = original.clone();
                view.live.status = ConnectionStatus::Connected;
                view.open_workspace_menu("w3", Default::default(), window, cx);
                view.open_workspace_dialog(WorkspaceAction::OpenWorktree, window, cx);
                pending(&mut view.menu, cx);
                view.live.dialog_response = Some(("list".into(), Some(Ok(listing()))));
                if opening {
                    view.menu.apply_worktree_list_response("list", Ok(listing()));
                    view.menu.creation = Some("open".into());
                    view.live.dialog_response = Some(("open".into(), Some(Ok(json!({"result":{
                        "type":"worktree_opened", "workspace":{"workspace_id":"w6"}
                    }})))));
                }
                match change {
                    0 => view.dismiss_menu(window, cx),
                    1 => view.endpoints[0].generation += 1,
                    2 => view.selection_epoch += 1,
                    3 => std::sync::Arc::make_mut(view.live.snapshot.as_mut().unwrap()).boot_id = "replacement".into(),
                    4 => std::sync::Arc::make_mut(view.live.snapshot.as_mut().unwrap()).workspaces.retain(|w| w.workspace_id != "w3"),
                    5 => view.live.status = ConnectionStatus::Disconnected,
                    _ => std::sync::Arc::make_mut(view.live.snapshot.as_mut().unwrap()).workspaces[3].worktree = None,
                }
                view.update_workspace_dialog(window, cx);
                assert!(view.menu.page.is_none());
                assert!(view.menu.worktree_open.is_none());
                assert!(view.pending_navigation.is_none());
            }
            view.live.snapshot = original;
            view.live.status = ConnectionStatus::Connected;
            view.open_workspace_menu("w3", Default::default(), window, cx);
            view.open_workspace_dialog(WorkspaceAction::OpenWorktree, window, cx);
            pending(&mut view.menu, cx);
            view.menu.apply_worktree_list_response("list", Ok(listing()));
            for response in [json!({"error":{"code":"open_failed","message":"checkout vanished"}}),
                json!({"result":{"type":"worktree_created","workspace":{"workspace_id":"wrong"}}}),
                json!({"result":{"type":"worktree_opened","workspace":{}}})] {
                view.menu.creation = Some("open".into());
                view.live.dialog_response = Some(("open".into(), Some(Ok(response))));
                view.update_workspace_dialog(window, cx);
                assert!(view.menu.error.is_some());
                assert!(view.menu.creation.is_none());
                assert!(view.pending_navigation.is_none());
            }
            view.menu.creation = Some("open".into());
            let opened = json!({"result":{"type":"worktree_opened","workspace":{"workspace_id":"w6"},"already_open":true}});
            view.live.dialog_response = Some(("old-open".into(), Some(Ok(opened.clone()))));
            view.update_workspace_dialog(window, cx);
            assert_eq!(view.menu.creation.as_deref(), Some("open"));
            view.collapsed_repos.insert(crate::sidebar::layout_tests::REPO_KEY.into());
            view.live.dialog_response = Some(("open".into(), Some(Ok(opened))));
            view.update_workspace_dialog(window, cx);
            assert!(view.menu.page.is_none());
            assert!(view.collapsed_repos.is_empty());
            assert_eq!(view.pending_navigation, Some(crate::NavigationTarget::Workspace("w6".into())));
        });
    });
}

#[gpui::test]
fn open_worktree_parent_establishment_requires_pending_source_identity_and_fences(
    cx: &mut TestAppContext,
) {
    use herdr_client::protocol::ClientShellWorktree;
    let (view, cx) = cx.add_window_view(fixture_window);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            let original = view.live.snapshot.clone();
            for change in [
                "matching",
                "not-pending",
                "repo",
                "label",
                "linked",
                "source-workspace",
                "branch",
                "boot",
                "removed",
                "generation",
                "selection",
                "disconnected",
                "existing",
            ] {
                view.menu.reset();
                view.pending_navigation = None;
                view.live.snapshot = original.clone();
                view.live.status = ConnectionStatus::Connected;
                if change != "existing" {
                    std::sync::Arc::make_mut(view.live.snapshot.as_mut().unwrap()).workspaces[3]
                        .worktree = None;
                }
                view.open_workspace_menu("w3", Default::default(), window, cx);
                view.open_workspace_dialog(WorkspaceAction::OpenWorktree, window, cx);
                pending(&mut view.menu, cx);
                let mut response = listing();
                if change == "source-workspace" {
                    response["result"]["source"]["source_workspace_id"] = json!("other");
                }
                view.menu.apply_worktree_list_response("list", Ok(response));
                assert!(view.menu.error.is_none());
                if change != "not-pending" {
                    view.menu.creation = Some("open".into());
                }
                let snapshot = std::sync::Arc::make_mut(view.live.snapshot.as_mut().unwrap());
                let mut membership = ClientShellWorktree {
                    key: "/remote/repo/.git".into(),
                    label: "repo".into(),
                    is_linked_worktree: false,
                };
                match change {
                    "repo" => membership.key = "/other/repo/.git".into(),
                    "label" => membership.label = "other".into(),
                    "linked" => membership.is_linked_worktree = true,
                    "branch" => snapshot.workspaces[3].branch = Some("different".into()),
                    "boot" => snapshot.boot_id = "restarted".into(),
                    _ => {}
                }
                snapshot.workspaces[3].worktree = Some(membership);
                if change == "removed" {
                    snapshot.workspaces.remove(3);
                }
                match change {
                    "generation" => view.endpoints[0].generation += 1,
                    "selection" => view.selection_epoch += 1,
                    "disconnected" => view.live.status = ConnectionStatus::Disconnected,
                    _ => {}
                }
                // A snapshot delivered before the response must retain the pending
                // open, but an unrelated response must still not navigate.
                let opened =
                    json!({"result":{"type":"worktree_opened","workspace":{"workspace_id":"w6"}}});
                view.live.dialog_response = Some(("unrelated".into(), Some(Ok(opened.clone()))));
                view.update_workspace_dialog(window, cx);
                assert!(view.pending_navigation.is_none(), "{change}");
                if change == "matching" {
                    assert_eq!(view.menu.creation.as_deref(), Some("open"));
                    view.live.dialog_response = Some(("open".into(), Some(Ok(opened))));
                    view.update_workspace_dialog(window, cx);
                    assert_eq!(
                        view.pending_navigation,
                        Some(crate::NavigationTarget::Workspace("w6".into()))
                    );
                }
                assert!(view.menu.page.is_none(), "{change}");
            }
        });
    });
}

#[gpui::test]
fn open_worktree_branch_only_parent_membership_preserves_correlated_navigation(
    cx: &mut TestAppContext,
) {
    use gpui::AppContext;
    use herdr_client::{
        ClientEvent, ConnectOptions, ConnectTarget, Method, Stream, connect_with_connector,
        protocol::{endpoint::*, *},
    };
    use std::time::Duration;
    let (stream, mut server) = Stream::pair().unwrap();
    server
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    server
        .set_write_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    let client = connect_with_connector(
        ConnectTarget::Socket("/unused".into()),
        ConnectOptions::default(),
        true,
        move |_, _| Ok(stream),
    )
    .unwrap();
    assert!(matches!(
        read_message(&mut server, MAX_FRAME_SIZE).unwrap(),
        ClientMessage::EndpointControl { .. }
    ));
    let mut welcome: Value = serde_json::from_str(include_str!(
        "../../../../herdr-protocol/tests/fixtures/endpoint-welcome-v1.json"
    ))
    .unwrap();
    welcome["methods"] = json!(["worktree.list", "worktree.open", "workspace.focus"]);
    let snapshot: ClientShellSnapshot = serde_json::from_str(include_str!(
        "../../../../herdr-protocol/tests/fixtures/endpoint-snapshot-v1.json"
    ))
    .unwrap();
    for (kind, data) in [
        (ENDPOINT_WELCOME_KIND, welcome.to_string()),
        (
            ENDPOINT_SNAPSHOT_KIND,
            serde_json::to_string(&snapshot).unwrap(),
        ),
    ] {
        write_message(
            &mut server,
            &ServerMessage::EndpointControl {
                kind: kind.into(),
                data,
            },
            MAX_GRAPHICS_FRAME_SIZE,
        )
        .unwrap();
    }
    let connected = client.events.recv_timeout(Duration::from_secs(3)).unwrap();
    let snapshot_event = client.events.recv_timeout(Duration::from_secs(3)).unwrap();
    // No terminal render tree: it would enqueue unrelated resize requests.
    struct Fixture(gpui::Entity<crate::HerdrWindow>);
    impl gpui::Render for Fixture {
        fn render(
            &mut self,
            _: &mut gpui::Window,
            _: &mut gpui::Context<Self>,
        ) -> impl gpui::IntoElement {
            gpui::div()
        }
    }
    let (fixture, cx) =
        cx.add_window_view(|window, cx| Fixture(cx.new(|cx| fixture_window(window, cx))));
    let view = fixture.update(cx, |fixture, _| fixture.0.clone());
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.live.apply(connected);
            view.live.apply(snapshot_event);
            std::sync::Arc::make_mut(view.live.snapshot.as_mut().unwrap()).workspaces =
                crate::sidebar::layout_tests::snapshot(7).workspaces;
            std::sync::Arc::make_mut(view.live.snapshot.as_mut().unwrap()).workspaces[3].worktree =
                None;
            view.endpoints[0].connection.handle = Some(client.handle.clone());
            *view.endpoints[0].connection.inbox.lock().unwrap() = view.live.clone();
            view.open_workspace_menu("w3", Default::default(), window, cx);
            view.open_workspace_dialog(WorkspaceAction::OpenWorktree, window, cx);
            assert!(view.menu.error.is_none());
            assert!(view.menu.worktree_open.as_ref().unwrap().pending.is_some());
            view.collapsed_repos.insert("/remote/repo/.git".into());
        });
    });
    for (method, response) in [
        (Method::WorktreeList, listing()),
        (
            Method::WorktreeOpen,
            json!({"result":{"type":"worktree_opened","workspace":{"workspace_id":"returned-workspace"}}}),
        ),
    ] {
        let ClientMessage::ClientShellEndpointRequest { request, .. } =
            read_message(&mut server, MAX_FRAME_SIZE).unwrap()
        else {
            panic!("expected worktree request")
        };
        let request: Value = serde_json::from_str(&request).unwrap();
        assert_eq!(request["method"], method.as_str());
        let mut params = json!({"workspace_id":"w3","trust_repository":false});
        if method == Method::WorktreeOpen {
            params["path"] = json!("/remote/checkout with spaces ");
            params["focus"] = json!(true);
        }
        assert_eq!(request["params"], params);
        let id = request["id"].as_str().unwrap();
        let mut response = response;
        response["id"] = json!(id);
        write_message(
            &mut server,
            &ServerMessage::ClientShellEndpointResponseChunk {
                boot_id: snapshot.boot_id.clone(),
                request_id: id.into(),
                final_chunk: true,
                data: serde_json::to_vec(&response).unwrap(),
            },
            MAX_GRAPHICS_FRAME_SIZE,
        )
        .unwrap();
        let event = client.events.recv_timeout(Duration::from_secs(3)).unwrap();
        assert!(matches!(event, ClientEvent::Response { .. }));
        cx.update(|window, cx| {
            view.update(cx, |view, cx| {
                if method == Method::WorktreeOpen {
                    // worktree.open establishes membership before its success response.
                    // The UI mailbox can coalesce both into one update.
                    let mut established = (**view.live.snapshot.as_ref().unwrap()).clone();
                    established.revision += 1;
                    established.workspaces[3].worktree = Some(ClientShellWorktree {
                        key: "/remote/repo/.git".into(),
                        label: "repo".into(),
                        is_linked_worktree: false,
                    });
                    view.endpoints[0]
                        .connection
                        .inbox
                        .lock()
                        .unwrap()
                        .apply(ClientEvent::Snapshot(std::sync::Arc::new(established)));
                }
                view.endpoints[0]
                    .connection
                    .inbox
                    .lock()
                    .unwrap()
                    .apply(event);
                view.live = view.endpoints[0].connection.take_update().unwrap();
                view.update_workspace_dialog(window, cx);
                if method == Method::WorktreeList {
                    let picker = view.menu.worktree_open.as_mut().unwrap();
                    assert_eq!(picker.entries.len(), 2);
                    picker.filter("SPACES");
                    assert_eq!(picker.filtered, [1]);
                    assert_eq!(picker.selected, 0);
                    view.submit_workspace_dialog(window, cx);
                    let pending = view.menu.creation.clone();
                    assert!(pending.is_some());
                    view.submit_workspace_dialog(window, cx);
                    assert_eq!(view.menu.creation, pending);
                } else {
                    assert!(view.menu.page.is_none());
                    assert!(!view.collapsed_repos.contains("/remote/repo/.git"));
                    assert_eq!(
                        view.pending_navigation,
                        Some(crate::NavigationTarget::Workspace(
                            "returned-workspace".into()
                        ))
                    );
                }
            });
        });
    }
    // FIFO marker proves duplicate submission did not queue a second open.
    client.handle.set_focus(&snapshot.boot_id, false).unwrap();
    assert!(matches!(
        read_message(&mut server, MAX_FRAME_SIZE).unwrap(),
        ClientMessage::ClientShellFocus { focused: false }
    ));
    client.handle.disconnect();
}
