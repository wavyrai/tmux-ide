use super::*;

#[gpui::test]
fn first_focus_claims_geometry_without_a_window_resize(cx: &mut gpui::TestAppContext) {
    let (endpoint, mut server) = connected_endpoint("resize");
    let (fixture, cx) = cx.add_window_view(|window, cx| {
        Fixture(cx.new(|cx| crate::sidebar::layout_tests::fixture_window(window, cx)))
    });
    let view = fixture.read_with(cx, |fixture, _| fixture.0.clone());
    view.update(cx, |view, cx| {
        view.endpoints = vec![endpoint];
        view.selected_endpoint = 0;
        view.reset_selected(cx);
        view.active = true;
        view.options.surface_size = ClientSurfaceSize {
            cols: 150,
            rows: 50,
        };
        // The initial size was queued before the surface became focusable.
        view.last_queued_options = Some(view.options);
        view.sent_focus = Some(false);
        assert!(
            !view.input_ready(),
            "the initial surface still has the old size"
        );
        view.report_focus();
        assert!(matches!(
            server.receive(),
            ClientMessage::ClientShellFocus { focused: true }
        ));
        assert_eq!(view.last_queued_options, Some(view.options));
        assert!(!view.input_ready(), "focus alone does not enable input");
        let surface = Arc::make_mut(view.live.surface.as_mut().unwrap());
        surface.frame.width = 150;
        surface.frame.height = 50;
        assert!(view.input_ready(), "the resized surface enables input");

        // Repeated polls must not keep resizing the terminal. A focus-loss
        // message acts as an ordered sentinel after these no-op calls.
        view.report_focus();
        view.resize();
        view.active = false;
        view.report_focus();
        assert!(matches!(
            server.receive(),
            ClientMessage::ClientShellFocus { focused: false }
        ));
    });
}

#[gpui::test]
fn startup_focus_waits_for_the_first_surface_without_flapping_on_later_updates(
    cx: &mut gpui::TestAppContext,
) {
    let (fixture, cx) = cx.add_window_view(|window, cx| {
        Fixture(cx.new(|cx| crate::sidebar::layout_tests::fixture_window(window, cx)))
    });
    let view = fixture.update(cx, |fixture, _| fixture.0.clone());
    let (mut endpoint, mut server) = connected_endpoint(LOCAL);
    endpoint.connection.inbox.lock().unwrap().surface = None;
    endpoint.live.surface = None;
    let inbox = endpoint.connection.inbox.clone();
    view.update(cx, |view, cx| {
        view.endpoints = vec![endpoint];
        view.options = ConnectOptions::default();
        view.reset_selected(cx);
        view.active = true;
        assert!(!view.input_ready());
        view.report_focus();
        assert_eq!(view.sent_focus, Some(false));
    });
    assert!(matches!(
        server.receive(),
        ClientMessage::ClientShellFocus { focused: false }
    ));

    inbox
        .lock()
        .unwrap()
        .apply(ClientEvent::Surface(surface(&snapshot())));
    view.update(cx, |view, cx| {
        project_until(view, cx, "startup surface ready", HerdrWindow::input_ready);
        view.report_focus();
        assert_eq!(view.sent_focus, Some(true));
        // New snapshot/surface pairs can arrive separately during normal activity.
        view.live.surface = None;
        view.report_focus();
        assert_eq!(view.sent_focus, Some(true));
        view.active = false;
        view.report_focus();
        assert_eq!(view.sent_focus, Some(false));
    });
    assert!(matches!(
        server.receive(),
        ClientMessage::ClientShellFocus { focused: true }
    ));
    assert!(matches!(
        server.receive(),
        ClientMessage::ClientShellFocus { focused: false }
    ));
}

#[gpui::test]
fn every_focus_changing_command_fences_immediate_input_until_ack_and_surface(
    cx: &mut gpui::TestAppContext,
) {
    let (fixture, cx) = cx.add_window_view(|window, cx| {
        Fixture(cx.new(|cx| crate::sidebar::layout_tests::fixture_window(window, cx)))
    });
    let view = fixture.update(cx, |fixture, _| fixture.0.clone());
    for (command, method, confirm_close, explicit_tab) in [
        (Command::SplitRight, Method::PaneSplit),
        (Command::SplitDown, Method::PaneSplit),
        (Command::Tab, Method::TabCreate),
        (Command::Workspace, Method::WorkspaceCreate),
        (Command::NextTab, Method::TabFocus),
        (Command::PreviousTab, Method::TabFocus),
        (Command::TabNumber(1), Method::TabFocus),
        (Command::FocusLeft, Method::PaneFocusDirection),
        (Command::FocusRight, Method::PaneFocusDirection),
        (Command::FocusUp, Method::PaneFocusDirection),
        (Command::FocusDown, Method::PaneFocusDirection),
        (Command::NextPane, Method::PaneFocus),
        (Command::PreviousPane, Method::PaneFocus),
        (Command::Zoom, Method::PaneZoom),
        (Command::ResizeLeft, Method::PaneResize),
        (Command::SwapRight, Method::PaneSwap),
        (Command::ClearPane, Method::PaneClear),
        (Command::ClosePane, Method::PaneClose),
        (Command::CloseTab, Method::TabClose),
        (Command::WorkspacePicker, Method::WorkspaceFocus),
        (Command::Palette, Method::CommandInvoke),
        (Command::Workspace, Method::WorkspaceClose),
        (Command::Workspace, Method::WorktreeCreate),
        (Command::Workspace, Method::WorktreeOpen),
        (Command::Workspace, Method::WorktreeRemove),
    ]
    .into_iter()
    .map(|(command, method)| (command, method, true, None))
    .chain([
        (Command::ClosePane, Method::PaneClose, false, None),
        (Command::CloseTab, Method::TabClose, false, None),
        (Command::CloseTab, Method::TabClose, false, Some("inactive")),
    ]) {
        let (endpoint, mut server) = connected_endpoint("ssh:fixture");
        cx.update(|window, cx| {
            view.update(cx, |view, cx| {
                view.endpoints.truncate(1);
                view.endpoints.push(endpoint);
                view.selected_endpoint = 1;
                view.options = ConnectOptions::default();
                view.reset_selected(cx);
                view.activation_deadline = None;
                view.config.confirm_close_tab = confirm_close;
                view.config.confirm_close_pane = confirm_close;
                assert!(view.input_ready());
                if let Some(id) = explicit_tab {
                    let snapshot = Arc::make_mut(view.live.snapshot.as_mut().unwrap());
                    let mut tab = snapshot.tabs[0].clone();
                    tab.tab_id = id.into();
                    tab.focused = false;
                    snapshot.tabs.push(tab);
                    assert_ne!(snapshot.focused_tab_id.as_deref(), Some(id));
                    view.open_tab_close(id, window, cx);
                } else if matches!(
                    method,
                    Method::WorkspaceClose
                        | Method::WorktreeCreate
                        | Method::WorktreeOpen
                        | Method::WorktreeRemove
                ) {
                    crate::menu::workspace_tests::submit_focus_change(view, method, window, cx);
                } else {
                    view.command(command, window, cx);
                }
                let key = |key: &str| gpui::KeyDownEvent {
                    keystroke: gpui::Keystroke::parse(key).unwrap(),
                    is_held: false,
                    prefer_character_input: false,
                };
                match command {
                    // Herdr asks for a tab name by default; its proposal creates.
                    Command::Tab => {
                        assert_eq!(
                            view.menu.page,
                            Some(crate::menu::Page::Dialog(
                                crate::menu::WorkspaceAction::NewTab
                            ))
                        );
                        crate::menu::workspace_tests::submit_dialog(view, window, cx);
                    }
                    Command::ClosePane | Command::CloseTab if confirm_close => {
                        view.close_confirmation_key(&key("tab"), window, cx);
                        view.close_confirmation_key(&key("enter"), window, cx);
                    }
                    Command::WorkspacePicker => view.palette_key(&key("enter"), window, cx),
                    Command::Palette => {
                        // Filter the unified palette to commands before walking
                        // past the native entries, except Palette and those
                        // the daemon does not offer, to the configured command.
                        view.palette_key(&key("tab"), window, cx);
                        view.palette_key(&key("tab"), window, cx);
                        let hidden = usize::from(!view.live.supports_pane_clear)
                            + usize::from(!view.live.supports_edit_scrollback);
                        for _ in 0..crate::controls::COMMANDS.len() - 1 - hidden {
                            view.palette_key(&key("down"), window, cx);
                        }
                        view.palette_key(&key("enter"), window, cx);
                    }
                    _ => {}
                }
                if !confirm_close {
                    assert!(view.menu.page.is_none());
                }
                assert!(!view.input_ready(), "{method} must fence immediately");
                assert!(view.activation_deadline.is_some());
                view.send(
                    ClientPaneInputEvent::TextCommit("must not reach old pane".into()),
                    cx,
                );
                let boot = view.live.snapshot.as_ref().unwrap().boot_id.clone();
                // An ordered marker exposes any input that incorrectly escaped.
                view.endpoints[view.selected_endpoint]
                    .connection
                    .handle
                    .as_ref()
                    .unwrap()
                    .set_focus(&boot, false)
                    .unwrap();
            })
        });
        let ClientMessage::ClientShellEndpointRequest { request, .. } = server.receive() else {
            panic!("missing command");
        };
        let request: serde_json::Value = serde_json::from_str(&request).unwrap();
        assert_eq!(request["method"], method.as_str());
        if method == Method::WorktreeOpen {
            assert_eq!(
                request["params"],
                serde_json::json!({"workspace_id": "w3",
                "path": "/endpoint/existing checkout ", "focus": true, "trust_repository": false})
            );
        }
        if method == Method::TabCreate {
            assert_eq!(
                request["params"],
                serde_json::json!({"workspace_id": "w1", "focus": true})
            );
        }
        if method == Method::TabClose {
            let focused = snapshot().focused_tab_id.unwrap();
            assert_eq!(
                request["params"],
                serde_json::json!({"tab_id": explicit_tab.unwrap_or(&focused)})
            );
        }
        // herdr-client serializes API requests behind their predecessor's reply.
        server.respond(&request);
        let ClientMessage::ClientShellEndpointRequest { request, .. } = server.receive() else {
            panic!("missing surface barrier");
        };
        let barrier: serde_json::Value = serde_json::from_str(&request).unwrap();
        assert_eq!(barrier["method"], Method::ClientShellSurfaceSet.as_str());
        assert!(matches!(
            server.receive(),
            ClientMessage::ClientShellFocus { focused: false }
        ));
        view.update(cx, |view, cx| {
            let mut next = snapshot();
            next.revision += 1;
            next.focused_pane_id = Some("new-pane".into());
            {
                let mut state = view.endpoints[view.selected_endpoint]
                    .connection
                    .inbox
                    .lock()
                    .unwrap();
                // A fresh frame alone must not open input before the ordered ack.
                state.apply(ClientEvent::Snapshot(Arc::new(next.clone())));
                state.apply(ClientEvent::Surface(surface(&next)));
            }
            project_until(view, cx, "fresh frame", |view| {
                view.live.snapshot.as_ref().map(|s| s.revision) == Some(next.revision)
                    && view.live.activation.is_some()
            });
            assert!(!view.input_ready());
            {
                let mut state = view.endpoints[view.selected_endpoint]
                    .connection
                    .inbox
                    .lock()
                    .unwrap();
                state.apply(ClientEvent::Response {
                    request_id: barrier["id"].as_str().unwrap().into(),
                    response: serde_json::json!({"result": {
                        "type": "client_shell_surface_set", "active": true,
                        "projection_revision": next.revision + 1
                    }}),
                });
            }
            project_until(view, cx, "ack ahead of the frame", |view| {
                view.live
                    .activation
                    .as_ref()
                    .and_then(|activation| activation.revision)
                    == Some(next.revision + 1)
            });
            assert!(
                !view.input_ready(),
                "ack newer than frame still fences input"
            );
            next.revision += 1;
            {
                let mut state = view.endpoints[view.selected_endpoint]
                    .connection
                    .inbox
                    .lock()
                    .unwrap();
                state.apply(ClientEvent::Snapshot(Arc::new(next.clone())));
                state.apply(ClientEvent::Surface(surface(&next)));
            }
            project_until(view, cx, "frame matching the ack", |view| {
                view.live.surface.as_ref().map(|s| s.projection_revision) == Some(next.revision)
            });
            assert!(view.input_ready());
            assert!(view.activation_deadline.is_none());
            view.send(ClientPaneInputEvent::TextCommit("new pane only".into()), cx);
        });
        let ClientMessage::ClientShellPaneInput { pane_id, .. } = server.receive() else {
            panic!("missing input after fence");
        };
        assert_eq!(pane_id, "new-pane");
    }
}
