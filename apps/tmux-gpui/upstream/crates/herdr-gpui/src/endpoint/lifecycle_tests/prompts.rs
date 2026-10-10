use super::*;

#[gpui::test]
fn dialog_response_survives_initial_surface_activation(cx: &mut gpui::TestAppContext) {
    let (view, cx) = cx.add_window_view(crate::sidebar::layout_tests::fixture_window);
    let (mut endpoint, _server) = connected_endpoint("ssh:fixture");
    endpoint.initial_surface = false;
    let response = serde_json::json!({"result":{"type":"worktree_list","worktrees":[]}});
    {
        let mut state = endpoint.connection.inbox.lock().unwrap();
        state.dialog_response = Some(("lookup".into(), Some(Ok(response.clone()))));
        state.dirty = true;
    }
    view.update(cx, |view, cx| {
        view.endpoints[0].detached = true;
        view.endpoints.push(endpoint);
        view.selected_endpoint = 1;
        view.reset_selected(cx);
        view.poll_endpoints(cx);
        assert!(view.live.activation.is_some());
        assert!(matches!(&view.live.dialog_response, Some((id, Some(Ok(value)))) if id == "lookup" && value == &response));
        assert!(
            view.endpoints[1]
                .connection
                .inbox
                .lock()
                .unwrap()
                .dialog_response
                .as_ref()
                .unwrap()
                .1
                .is_none()
        );
    });
}

/// `ui.prompt_new_tab_name` and `ui.prompt_new_workspace_name` decide whether
/// creating asks for a name first, and a typed name travels as the label.
#[gpui::test]
fn name_prompts_follow_shared_config_and_label_creations(cx: &mut gpui::TestAppContext) {
    use crate::menu::{Page, WorkspaceAction};
    let (fixture, cx) = cx.add_window_view(|window, cx| {
        Fixture(cx.new(|cx| crate::sidebar::layout_tests::fixture_window(window, cx)))
    });
    let view = fixture.update(cx, |fixture, _| fixture.0.clone());
    // (shared config, command, dialog it opens with its proposal, typed name, request)
    let cases = [
        (
            "",
            Command::Tab,
            Some((WorkspaceAction::NewTab, "2")),
            Some("  Build  "),
            serde_json::json!({"workspace_id": "w1", "focus": true, "label": "Build"}),
        ),
        (
            "",
            Command::Tab,
            Some((WorkspaceAction::NewTab, "2")),
            Some(""),
            serde_json::json!({"workspace_id": "w1", "focus": true}),
        ),
        (
            "",
            Command::Workspace,
            None,
            None,
            serde_json::json!({"focus": true, "source_workspace_id": "w1"}),
        ),
        (
            "[ui]\nprompt_new_workspace_name = true\n",
            Command::Workspace,
            Some((WorkspaceAction::NewWorkspace, "repo")),
            None,
            serde_json::json!({"focus": true, "source_workspace_id": "w1"}),
        ),
        (
            "[ui]\nprompt_new_workspace_name = true\n",
            Command::Workspace,
            Some((WorkspaceAction::NewWorkspace, "repo")),
            Some("Docs"),
            serde_json::json!({"focus": true, "source_workspace_id": "w1", "label": "Docs"}),
        ),
        (
            "[ui]\nprompt_new_tab_name = false\n",
            Command::Tab,
            None,
            None,
            serde_json::json!({"workspace_id": "w1", "focus": true}),
        ),
    ];
    for (config, command, dialog, typed, params) in cases {
        let (endpoint, mut server) = connected_endpoint("ssh:fixture");
        cx.update(|window, cx| {
            view.update(cx, |view, cx| {
                view.endpoints.truncate(1);
                view.endpoints.push(endpoint);
                view.selected_endpoint = 1;
                view.options = ConnectOptions::default();
                view.reset_selected(cx);
                view.activation_deadline = None;
                // A reload replaces the prepared settings; nothing is re-read here.
                view.settings.shared = (!config.is_empty())
                    .then(|| crate::herdr_settings::Settings::parse_text(config).unwrap());
                view.command(command, window, cx);
                if let Some((action, proposed)) = dialog {
                    assert_eq!(view.menu.page, Some(Page::Dialog(action)));
                    assert_eq!(view.menu.input.as_ref().unwrap().text, proposed);
                    // Cancelling sends nothing and leaves input unfenced.
                    view.dismiss_menu(window, cx);
                    assert!(view.activation_deadline.is_none());
                    view.command(command, window, cx);
                    if let Some(typed) = typed {
                        view.menu.input = Some(crate::dialog_input::DialogInput::new(typed.into()));
                    }
                    crate::menu::workspace_tests::submit_dialog(view, window, cx);
                    assert!(view.menu.page.is_none());
                } else {
                    assert!(view.menu.page.is_none());
                }
                assert!(view.activation_deadline.is_some());
            })
        });
        let ClientMessage::ClientShellEndpointRequest { request, .. } = server.receive() else {
            panic!("missing creation");
        };
        let request: serde_json::Value = serde_json::from_str(&request).unwrap();
        let method = match command {
            Command::Tab => Method::TabCreate,
            _ => Method::WorkspaceCreate,
        };
        assert_eq!(request["method"], method.as_str());
        assert_eq!(request["params"], params, "{config:?} {command:?}");
    }
}

#[gpui::test]
fn unconfirmed_tab_close_rejects_invalid_targets_and_unready_input(cx: &mut gpui::TestAppContext) {
    let (fixture, cx) = cx.add_window_view(|window, cx| {
        Fixture(cx.new(|cx| crate::sidebar::layout_tests::fixture_window(window, cx)))
    });
    let view = fixture.update(cx, |fixture, _| fixture.0.clone());
    let (endpoint, mut server) = connected_endpoint("ssh:fixture");
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.endpoints.push(endpoint);
            view.selected_endpoint = 1;
            view.reset_selected(cx);
            view.activation_deadline = None;
            view.config.confirm_close_tab = false;
            assert!(view.input_ready());
            let ready = view.live.clone();
            let tab = ready
                .snapshot
                .as_ref()
                .unwrap()
                .focused_tab_id
                .as_ref()
                .unwrap();
            for explicit in [true, false] {
                for rejection in ["missing-tab", "missing-workspace", "unready-input"] {
                    view.live = ready.clone();
                    match rejection {
                        "missing-tab" => Arc::make_mut(view.live.snapshot.as_mut().unwrap())
                            .tabs
                            .clear(),
                        "missing-workspace" => Arc::make_mut(view.live.snapshot.as_mut().unwrap())
                            .workspaces
                            .clear(),
                        _ => {
                            view.live.surface = None;
                            assert!(!view.input_ready());
                        }
                    }
                    if explicit {
                        view.open_tab_close(tab, window, cx);
                    } else {
                        view.command(Command::CloseTab, window, cx);
                    }
                    assert!(view.activation_deadline.is_none());
                    assert!(view.pending_navigation.is_none());
                    view.dismiss_menu(window, cx);
                }
            }
            // FIFO marker proves none of the rejected attempts reached the peer.
            view.endpoints[1]
                .connection
                .handle
                .as_ref()
                .unwrap()
                .set_focus(&ready.snapshot.as_ref().unwrap().boot_id, false)
                .unwrap();
        });
    });
    assert!(matches!(
        server.receive(),
        ClientMessage::ClientShellFocus { focused: false }
    ));
}
