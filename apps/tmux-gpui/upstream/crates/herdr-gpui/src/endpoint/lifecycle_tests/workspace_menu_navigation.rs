use super::*;

#[gpui::test]
fn workspace_menu_keeps_immediate_and_deferred_navigation(cx: &mut gpui::TestAppContext) {
    let (fixture, cx) = cx.add_window_view(|window, cx| {
        Fixture(cx.new(|cx| crate::sidebar::layout_tests::fixture_window(window, cx)))
    });
    let view = fixture.update(cx, |fixture, _| fixture.0.clone());
    for deferred in [false, true] {
        let (endpoint, mut server) = connected_endpoint("local");
        cx.update(|window, cx| {
            view.update(cx, |view, cx| {
                view.selected_endpoint = 0;
                view.endpoints = vec![endpoint];
                view.options = ConnectOptions::default();
                view.reset_selected(cx);
                if deferred {
                    view.live.surface = None;
                }
                assert!(view.navigate_endpoint("local", NavigationTarget::Workspace("w1"), cx));
                view.open_workspace_menu("w1", Default::default(), window, cx);
                assert_eq!(view.menu.page, Some(crate::menu::Page::Workspace));
                if deferred {
                    assert!(view.pending_navigation.is_some());
                    view.live = view.endpoints[0].live.clone();
                    view.poll_endpoints(cx);
                }
                assert!(view.pending_navigation.is_none());
                assert!(!view.input_ready());
                assert_eq!(view.menu.page, Some(crate::menu::Page::Workspace));
                assert!(view.menu.focus.is_focused(window));
                // New input is still blocked while the menu owns focus.
                assert!(!view.navigate(NavigationTarget::Workspace("other"), cx));
            });
        });
        let ClientMessage::ClientShellEndpointRequest { request, .. } = server.receive() else {
            panic!("missing workspace focus request");
        };
        let request: serde_json::Value = serde_json::from_str(&request).unwrap();
        assert_eq!(request["method"], "workspace.focus");
        assert_eq!(request["params"], serde_json::json!({"workspace_id": "w1"}));
        server.respond(&request);
        let ClientMessage::ClientShellEndpointRequest { request, .. } = server.receive() else {
            panic!("missing surface barrier");
        };
        let barrier: serde_json::Value = serde_json::from_str(&request).unwrap();
        assert_eq!(barrier["method"], Method::ClientShellSurfaceSet.as_str());
        view.update(cx, |view, cx| {
            let mut next = snapshot();
            next.revision += 1;
            next.focused_workspace_id = Some("w1".into());
            for workspace in &mut next.workspaces {
                workspace.focused = workspace.workspace_id == "w1";
            }
            {
                let mut state = view.endpoints[0].connection.inbox.lock().unwrap();
                state.apply(ClientEvent::Snapshot(Arc::new(next.clone())));
                state.apply(ClientEvent::Surface(surface(&next)));
                state.apply(ClientEvent::Response {
                    request_id: barrier["id"].as_str().unwrap().into(),
                    response: serde_json::json!({"result": {
                        "type": "client_shell_surface_set", "active": true,
                        "projection_revision": next.revision
                    }}),
                });
            }
            project_until(view, cx, "workspace selection", HerdrWindow::input_ready);
            assert_eq!(view.menu.page, Some(crate::menu::Page::Workspace));
            let selected = view.live.snapshot.as_ref().unwrap();
            assert_eq!(selected.focused_workspace_id.as_deref(), Some("w1"));
            assert!(
                selected
                    .workspaces
                    .iter()
                    .any(|workspace| workspace.workspace_id == "w1" && workspace.focused)
            );
        });
    }
}
