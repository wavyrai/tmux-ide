use super::*;

#[gpui::test]
fn connected_image_paste_key_down_ctrl_v_and_cmd_v(cx: &mut gpui::TestAppContext) {
    let (fixture, cx) = cx.add_window_view(|window, cx| {
        Fixture(cx.new(|cx| crate::sidebar::layout_tests::fixture_window(window, cx)))
    });
    let view = fixture.update(cx, |fixture, _| fixture.0.clone());
    for remote in [false, true] {
        for key in ["ctrl-v", "cmd-v"] {
            for image in [false, true] {
                let (endpoint, mut server) = connected_endpoint("image");
                let event = gpui::KeyDownEvent {
                    keystroke: gpui::Keystroke::parse(key).unwrap(),
                    is_held: false,
                    prefer_character_input: false,
                };
                cx.update(|window, cx| {
                    view.update(cx, |view, cx| {
                        if remote {
                            prepare_remote_image(view, endpoint, cx);
                        } else {
                            prepare_mouse(view, endpoint, cx);
                        }
                        let item = if image {
                            clipboard_image(&[42])
                        } else {
                            ClipboardItem::new_string("clipboard text".into())
                        };
                        cx.write_to_clipboard(item.clone());
                        view.key_down(&event, window, cx);
                        assert_eq!(cx.read_from_clipboard(), Some(item));
                        // Remote clipboard reads reserve FIFO order even for text-only
                        // Ctrl-V. Local Ctrl-V stays a key for agents that read the
                        // clipboard themselves; local Cmd-V bridges images.
                        let native_paste = key == "cmd-v" && (image || !cfg!(target_os = "linux"));
                        assert_eq!(
                            view.pending_images.len(),
                            usize::from(native_paste || (remote && key == "ctrl-v"))
                        );
                        view.send(ClientPaneInputEvent::TextCommit("key sentinel".into()), cx);
                    });
                });
                cx.run_until_parked();
                if image && (remote || key == "cmd-v") {
                    assert_eq!(
                        server.receive(),
                        ClientMessage::ClipboardImage {
                            target: ClientClipboardImageTarget::Pane("w1:p1".into()),
                            extension: "png".into(),
                            data: vec![42],
                        }
                    );
                } else if key == "ctrl-v" || !image {
                    assert_eq!(
                        server.receive(),
                        ClientMessage::ClientShellPaneInput {
                            pane_id: "w1:p1".into(),
                            events: vec![if key == "ctrl-v" {
                                crate::terminal::key_input(&event, true).unwrap()
                            } else {
                                ClientPaneInputEvent::Paste("clipboard text".into())
                            }],
                        }
                    );
                }
                assert_eq!(
                    server.receive(),
                    ClientMessage::ClientShellPaneInput {
                        pane_id: "w1:p1".into(),
                        events: vec![ClientPaneInputEvent::TextCommit("key sentinel".into())],
                    },
                    "remote={remote}, key={key}, image={image}"
                );
                wait_image_finished(&view, cx);
                view.read_with(cx, |view, _| assert!(view.local_error.is_none()));
            }
        }
    }
}

#[gpui::test]
fn connected_image_paste_native_text_reservations_preserve_fifo(cx: &mut gpui::TestAppContext) {
    let (fixture, cx) = cx.add_window_view(|window, cx| {
        Fixture(cx.new(|cx| crate::sidebar::layout_tests::fixture_window(window, cx)))
    });
    let view = fixture.update(cx, |fixture, _| fixture.0.clone());
    let (endpoint, mut server) = connected_endpoint("ssh:image");
    view.update(cx, |view, cx| {
        prepare_remote_image(view, endpoint, cx);
        for text in ["first paste", "second paste"] {
            cx.write_to_clipboard(ClipboardItem::new_string(text.into()));
            view.paste_native_clipboard(false, None, cx);
        }
        assert_eq!(view.pending_images.len(), 2);
        assert!(view.local_error.is_none());
        view.send(ClientPaneInputEvent::TextCommit("sentinel".into()), cx);
    });
    cx.run_until_parked();
    for event in [
        ClientPaneInputEvent::Paste("first paste".into()),
        ClientPaneInputEvent::Paste("second paste".into()),
        ClientPaneInputEvent::TextCommit("sentinel".into()),
    ] {
        assert_eq!(
            server.receive(),
            ClientMessage::ClientShellPaneInput {
                pane_id: "w1:p1".into(),
                events: vec![event],
            }
        );
    }
    wait_image_finished(&view, cx);
    view.read_with(cx, |view, _| assert!(view.local_error.is_none()));
}

#[gpui::test]
fn connected_image_paste_native_text_during_blocked_image_and_second_image_busy(
    cx: &mut gpui::TestAppContext,
) {
    let (fixture, cx) = cx.add_window_view(|window, cx| {
        Fixture(cx.new(|cx| crate::sidebar::layout_tests::fixture_window(window, cx)))
    });
    let view = fixture.update(cx, |fixture, _| fixture.0.clone());
    let (endpoint, mut server) = connected_endpoint("ssh:image");
    view.update(cx, |view, cx| {
        prepare_remote_image(view, endpoint, cx);
        let handle = view.endpoints[1].connection.handle.as_ref().unwrap();
        // The second API request holds the FIFO behind the first request's reply.
        for _ in 0..2 {
            handle
                .request(
                    &snapshot().boot_id,
                    Method::TabCreate,
                    serde_json::json!({}),
                )
                .unwrap();
        }
        assert!(view.paste_terminal_clipboard(clipboard_image(&[42]), false, cx));
    });
    let ClientMessage::ClientShellEndpointRequest { request, .. } = server.receive() else {
        panic!("missing first API request");
    };
    let first: serde_json::Value = serde_json::from_str(&request).unwrap();
    cx.run_until_parked();
    view.update(cx, |view, cx| {
        assert_eq!(view.pending_images.len(), 1);
        for text in ["first paste", "second paste"] {
            cx.write_to_clipboard(ClipboardItem::new_string(text.into()));
            view.paste_native_clipboard(false, None, cx);
        }
        assert_eq!(view.pending_images.len(), 3);
        assert!(view.local_error.is_none());
        cx.write_to_clipboard(clipboard_image(&[99]));
        view.paste_native_clipboard(false, None, cx);
        assert_eq!(view.pending_images.len(), 4);
        view.send(ClientPaneInputEvent::TextCommit("sentinel".into()), cx);
    });
    cx.run_until_parked();
    view.read_with(cx, |view, _| {
        assert_eq!(
            view.local_error,
            Some(format!(
                "Image not sent: {}",
                herdr_client::Error::ClipboardImageBusy
            ))
        );
    });
    server.respond(&first);
    let ClientMessage::ClientShellEndpointRequest { request, .. } = server.receive() else {
        panic!("missing second API request");
    };
    server.respond(&serde_json::from_str(&request).unwrap());
    assert_eq!(
        server.receive(),
        ClientMessage::ClipboardImage {
            target: ClientClipboardImageTarget::Pane("w1:p1".into()),
            extension: "png".into(),
            data: vec![42],
        }
    );
    for event in [
        ClientPaneInputEvent::Paste("first paste".into()),
        ClientPaneInputEvent::Paste("second paste".into()),
        ClientPaneInputEvent::TextCommit("sentinel".into()),
    ] {
        assert_eq!(
            server.receive(),
            ClientMessage::ClientShellPaneInput {
                pane_id: "w1:p1".into(),
                events: vec![event],
            }
        );
    }
    wait_image_finished(&view, cx);
}

#[gpui::test]
fn connected_image_paste_native_preparations_stay_bounded_across_reset(
    cx: &mut gpui::TestAppContext,
) {
    let (fixture, cx) = cx.add_window_view(|window, cx| {
        Fixture(cx.new(|cx| crate::sidebar::layout_tests::fixture_window(window, cx)))
    });
    let view = fixture.update(cx, |fixture, _| fixture.0.clone());
    for reset_all in [false, true] {
        let (endpoint, mut server) = connected_endpoint("ssh:image");
        view.update(cx, |view, cx| {
            prepare_remote_image(view, endpoint, cx);
            let surface = view.live.surface.clone();
            for index in 0..4 {
                if index == 3 {
                    view.reset_selected(cx);
                    view.activation_deadline = None;
                    view.live.surface = surface.clone();
                }
                cx.write_to_clipboard(ClipboardItem::new_string(format!("paste {index}")));
                view.paste_native_clipboard(false, None, cx);
                assert_eq!(view.pending_images.len(), index + 1);
            }
            if reset_all {
                view.reset_selected(cx);
                view.live.surface = surface;
            }
            view.cancel_stale_image();
            assert_eq!(view.pending_images.len(), 4);
            // Even cancelled tasks count until their background work returns.
            view.activation_deadline = None;
            cx.write_to_clipboard(ClipboardItem::new_string("overflow".into()));
            view.paste_native_clipboard(false, None, cx);
            assert_eq!(view.pending_images.len(), 4);
            assert_eq!(
                view.local_error,
                Some(format!(
                    "Image not sent: {}",
                    herdr_client::Error::ClipboardImageBusy
                ))
            );
            view.endpoints[1]
                .connection
                .handle
                .as_ref()
                .unwrap()
                .set_focus(&snapshot().boot_id, false)
                .unwrap();
        });
        cx.run_until_parked();
        if !reset_all {
            assert_eq!(
                server.receive(),
                ClientMessage::ClientShellPaneInput {
                    pane_id: "w1:p1".into(),
                    events: vec![ClientPaneInputEvent::Paste("paste 3".into())],
                }
            );
        }
        assert_eq!(
            server.receive(),
            ClientMessage::ClientShellFocus { focused: false }
        );
        wait_image_finished(&view, cx);
    }
}

#[gpui::test]
fn connected_image_paste_queued_upload_remains_cancellable_after_preparation(
    cx: &mut gpui::TestAppContext,
) {
    let (fixture, cx) = cx.add_window_view(|window, cx| {
        Fixture(cx.new(|cx| crate::sidebar::layout_tests::fixture_window(window, cx)))
    });
    let view = fixture.update(cx, |fixture, _| fixture.0.clone());
    for change in ["epoch", "popup", "local"] {
        let (endpoint, mut server) = connected_endpoint("ssh:image");
        let requests = view.update(cx, |view, cx| {
            prepare_remote_image(view, endpoint, cx);
            if change == "popup" {
                image_popup(view, "original-popup");
            }
            let handle = view.endpoints[1].connection.handle.as_ref().unwrap();
            // Images bypass the API lease, so a second API request must block the FIFO.
            let requests = [0, 1].map(|_| {
                handle
                    .request(
                        &snapshot().boot_id,
                        Method::TabCreate,
                        serde_json::json!({}),
                    )
                    .unwrap()
            });
            assert!(view.paste_terminal_clipboard(clipboard_image(&[42]), false, cx));
            view.endpoints[1]
                .connection
                .handle
                .as_ref()
                .unwrap()
                .set_focus(&snapshot().boot_id, false)
                .unwrap();
            requests
        });
        let ClientMessage::ClientShellEndpointRequest { request, .. } = server.receive() else {
            panic!("missing first API request");
        };
        let first: serde_json::Value = serde_json::from_str(&request).unwrap();
        assert_eq!(first["id"], requests[0]);
        cx.run_until_parked();
        view.update(cx, |view, cx| {
            view.cancel_stale_image();
            assert!(
                !view.pending_images.is_empty(),
                "publication must retain cancellation"
            );
            assert!(view.local_error.is_none());
            // No preparation is running now, but the unsent frame still occupies the guard.
            assert!(view.paste_terminal_clipboard(clipboard_image(&[99]), false, cx));
            assert_eq!(
                view.local_error,
                Some(format!(
                    "Image not sent: {}",
                    herdr_client::Error::ClipboardImageBusy
                ))
            );
            match change {
                "epoch" => view.selection_epoch += 1,
                "popup" => image_popup(view, "replacement-popup"),
                "local" => {
                    view.endpoints[1].connection.target =
                        ConnectTarget::Socket(server.path.clone());
                }
                _ => unreachable!(),
            }
            view.cancel_stale_image();
            assert!(
                !view.pending_images.is_empty(),
                "cancelling does not finish the worker slot"
            );
        });
        server.respond(&first);
        let ClientMessage::ClientShellEndpointRequest { request, .. } = server.receive() else {
            panic!("missing second API request");
        };
        let second: serde_json::Value = serde_json::from_str(&request).unwrap();
        assert_eq!(second["id"], requests[1]);
        server.respond(&second);
        assert_eq!(
            server.receive(),
            ClientMessage::ClientShellFocus { focused: false },
            "queued image escaped after {change} changed"
        );
        wait_image_finished(&view, cx);
    }
}

#[gpui::test]
fn connected_image_paste_snapshot_surface_gap_preserves_existing_target(
    cx: &mut gpui::TestAppContext,
) {
    let (fixture, cx) = cx.add_window_view(|window, cx| {
        Fixture(cx.new(|cx| crate::sidebar::layout_tests::fixture_window(window, cx)))
    });
    let view = fixture.update(cx, |fixture, _| fixture.0.clone());
    for removed in [false, true] {
        let (endpoint, mut server) = connected_endpoint("ssh:image");
        let requests = view.update(cx, |view, cx| {
            prepare_remote_image(view, endpoint, cx);
            let handle = view.endpoints[1].connection.handle.as_ref().unwrap();
            let requests = [0, 1].map(|_| {
                handle
                    .request(
                        &snapshot().boot_id,
                        Method::TabCreate,
                        serde_json::json!({}),
                    )
                    .unwrap()
            });
            assert!(view.paste_terminal_clipboard(clipboard_image(&[42]), false, cx));
            view.send(
                ClientPaneInputEvent::TextCommit("after surface gap".into()),
                cx,
            );
            // A newer snapshot invalidates old cells before the replacement surface arrives.
            let snapshot = Arc::make_mut(view.live.snapshot.as_mut().unwrap());
            snapshot.revision += 1;
            if removed {
                snapshot.panes.retain(|pane| pane.pane_id != "w1:p1");
                snapshot.focused_pane_id = Some("w1:p2".into());
            }
            view.live.surface = None;
            assert!(!view.input_ready());
            view.cancel_stale_image();
            assert_eq!(view.pending_images.len(), 1);
            requests
        });
        let ClientMessage::ClientShellEndpointRequest { request, .. } = server.receive() else {
            panic!("missing first API request");
        };
        let first: serde_json::Value = serde_json::from_str(&request).unwrap();
        assert_eq!(first["id"], requests[0]);
        cx.run_until_parked();
        view.update(cx, |view, _| {
            view.cancel_stale_image();
            if !removed {
                assert!(
                    !view.pending_images.is_empty(),
                    "missing cells must not cancel an existing pane"
                );
            }
            assert!(view.local_error.is_none());
        });
        server.respond(&first);
        let ClientMessage::ClientShellEndpointRequest { request, .. } = server.receive() else {
            panic!("missing second API request");
        };
        let second: serde_json::Value = serde_json::from_str(&request).unwrap();
        assert_eq!(second["id"], requests[1]);
        server.respond(&second);
        if !removed {
            assert_eq!(
                server.receive(),
                ClientMessage::ClipboardImage {
                    target: ClientClipboardImageTarget::Pane("w1:p1".into()),
                    extension: "png".into(),
                    data: vec![42],
                }
            );
        }
        assert_eq!(
            server.receive(),
            ClientMessage::ClientShellPaneInput {
                pane_id: "w1:p1".into(),
                events: vec![ClientPaneInputEvent::TextCommit("after surface gap".into())],
            },
            "snapshot removed pane={removed}"
        );
        wait_image_finished(&view, cx);
        view.read_with(cx, |view, _| assert!(view.local_error.is_none()));
    }
}
