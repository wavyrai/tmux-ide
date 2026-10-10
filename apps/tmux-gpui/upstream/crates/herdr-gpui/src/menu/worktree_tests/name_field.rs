use super::*;

/// The name field is what the dialog opens on, and its typing never edits the
/// branch draft; the branch field is still one click away.
#[gpui::test]
fn the_name_field_opens_focused_and_keeps_its_keys(cx: &mut gpui::TestAppContext) {
    let (view, cx) = cx.add_window_view(sidebar::layout_tests::fixture_window);
    cx.simulate_resize(gpui::size(gpui::px(900.), gpui::px(700.)));
    open_dialog(&view, cx, false, Tab::New);
    let branch = cx.update(|_, cx| view.read(cx).menu.input.as_ref().unwrap().text.clone());
    let name = |cx: &mut VisualTestContext| {
        cx.update(|_, cx| {
            let source = view.read(cx).menu.worktree.as_ref().unwrap();
            source.name.read(cx).text().to_owned()
        })
    };
    assert!(cx.update(|window, cx| view.read(cx).worktree_name_focused(window, cx)));
    assert!(cx.debug_bounds("worktree-name").is_some());
    // Empty means the daemon's default label.
    assert_eq!(cx.update(|_, cx| view.read(cx).worktree_name(cx)), None);

    cx.simulate_input("Login work");
    cx.simulate_keystrokes("backspace left right");
    assert_eq!(name(cx), "Login wor");
    assert_eq!(
        cx.update(|_, cx| view.read(cx).worktree_name(cx)),
        Some("Login wor".into())
    );
    cx.update(|_, cx| {
        let input = view.read(cx).menu.input.as_ref().unwrap();
        assert_eq!(input.text, branch);
        assert_eq!(input.selection, 0..branch.len());
    });

    // Clicking the branch field moves typing there, leaving the name alone.
    let field = cx.debug_bounds("dialog-input").unwrap();
    cx.simulate_click(field.center(), gpui::Modifiers::none());
    assert!(!cx.update(|window, cx| view.read(cx).worktree_name_focused(window, cx)));
    cx.simulate_keystrokes("cmd-a");
    cx.simulate_input("feature/login");
    assert_eq!(
        cx.update(|_, cx| view.read(cx).menu.input.as_ref().unwrap().text.clone()),
        "feature/login"
    );
    assert_eq!(name(cx), "Login wor");

    // Returning to the form tab puts typing back on the name.
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.select_worktree_tab(Tab::New, window, cx)
        });
    });
    assert!(cx.update(|window, cx| view.read(cx).worktree_name_focused(window, cx)));

    // Enter from the name field submits the form; the fixture has no daemon.
    cx.simulate_keystrokes("enter");
    cx.update(|_, cx| {
        let view = view.read(cx);
        assert_eq!(
            view.menu.page,
            Some(Page::Dialog(WorkspaceAction::NewWorktree))
        );
        assert!(view.menu.error.is_some());
    });
    // Escape still dismisses from the name field.
    cx.simulate_keystrokes("escape");
    cx.update(|_, cx| assert!(view.read(cx).menu.page.is_none()));
}

/// A typed name rides along on `worktree.create` as its label, so the daemon
/// names the workspace as it creates it; an empty one leaves the label out.
#[gpui::test]
fn a_typed_name_labels_the_created_worktree(cx: &mut gpui::TestAppContext) {
    use gpui::AppContext;
    use herdr_client::{
        ConnectOptions, ConnectTarget, Method, Stream, connect_with_connector,
        protocol::{endpoint::*, *},
    };
    use serde_json::{Value, json};
    use std::time::Duration;
    let (stream, mut server) = Stream::pair().unwrap();
    server
        .set_read_timeout(Some(Duration::from_secs(3)))
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
    welcome["methods"] = json!(["worktree.list", "worktree.create", "workspace.focus"]);
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
    struct Fixture(Entity<HerdrWindow>);
    impl gpui::Render for Fixture {
        fn render(
            &mut self,
            _: &mut gpui::Window,
            _: &mut gpui::Context<Self>,
        ) -> impl gpui::IntoElement {
            gpui::div()
        }
    }
    let (fixture, cx) = cx.add_window_view(|window, cx| {
        Fixture(cx.new(|cx| sidebar::layout_tests::fixture_window(window, cx)))
    });
    let view = fixture.update(cx, |fixture, _| fixture.0.clone());
    cx.update(|_, cx| {
        view.update(cx, |view, _| {
            view.live.apply(connected);
            view.live.apply(snapshot_event);
            std::sync::Arc::make_mut(view.live.snapshot.as_mut().unwrap()).workspaces =
                sidebar::layout_tests::snapshot(7).workspaces;
            view.endpoints[0].connection.handle = Some(client.handle.clone());
            *view.endpoints[0].connection.inbox.lock().unwrap() = view.live.clone();
        });
    });
    for name in ["  Login work ", "   "] {
        let branch = cx.update(|window, cx| {
            view.update(cx, |view, cx| {
                view.menu.reset();
                view.open_workspace_menu("w3", Default::default(), window, cx);
                view.open_workspace_dialog(WorkspaceAction::NewWorktree, window, cx);
                let source = view.menu.worktree.as_ref().unwrap();
                source
                    .name
                    .update(cx, |input, cx| input.set_text_selected(name, cx));
                view.menu.creation = None;
                view.submit_workspace_dialog(window, cx);
                assert!(view.menu.error.is_none(), "{:?}", view.menu.error);
                view.menu.input.as_ref().unwrap().text.clone()
            })
        });
        // The dialog also asks for the repository's checkouts on opening, and
        // one request is in flight at a time, so each one is answered.
        let request = loop {
            let ClientMessage::ClientShellEndpointRequest { request, .. } =
                read_message(&mut server, MAX_FRAME_SIZE).unwrap()
            else {
                continue;
            };
            let request: Value = serde_json::from_str(&request).unwrap();
            let id = request["id"].as_str().unwrap();
            let response = json!({"id": id, "error": {"code": "fixture", "message": "unused"}});
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
            if request["method"] == Method::WorktreeCreate.as_str() {
                break request;
            }
        };
        let mut params = json!({"workspace_id": "w3", "base": "HEAD", "focus": true,
            "trust_repository": false, "branch": branch});
        if !name.trim().is_empty() {
            params["label"] = json!("Login work");
        }
        assert_eq!(request["params"], params);
    }
    client.handle.disconnect();
}
