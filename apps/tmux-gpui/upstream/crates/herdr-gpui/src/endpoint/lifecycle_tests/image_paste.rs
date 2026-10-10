use super::*;

/// Navigation leaves its acknowledged activation recorded. Cmd-V must still
/// paste afterwards, and only a navigation still in flight may drop it.
#[gpui::test]
fn text_paste_survives_a_settled_navigation(cx: &mut gpui::TestAppContext) {
    let (fixture, cx) = cx.add_window_view(|window, cx| {
        Fixture(cx.new(|cx| crate::sidebar::layout_tests::fixture_window(window, cx)))
    });
    let view = fixture.update(cx, |fixture, _| fixture.0.clone());
    let (endpoint, mut server) = connected_endpoint("image");
    let paste = gpui::KeyDownEvent {
        keystroke: gpui::Keystroke::parse("cmd-v").unwrap(),
        is_held: false,
        prefer_character_input: false,
    };
    let settled = |view: &HerdrWindow| crate::state::SurfaceActivation {
        request: "activate-1".into(),
        boot: view.live.snapshot.as_ref().unwrap().boot_id.clone(),
        revision: Some(view.live.surface.as_ref().unwrap().projection_revision),
        failed: false,
        focus: None,
        active: true,
    };
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            prepare_mouse(view, endpoint, cx);
            view.live.activation = Some(settled(view));
            assert!(view.live.surface_ready() && !view.live.activation_pending());
            cx.write_to_clipboard(ClipboardItem::new_string("after navigation".into()));
            view.key_down(&paste, window, cx);
        });
    });
    cx.run_until_parked();
    assert_eq!(
        server.receive(),
        ClientMessage::ClientShellPaneInput {
            pane_id: "w1:p1".into(),
            events: vec![ClientPaneInputEvent::Paste("after navigation".into())],
        }
    );
    wait_image_finished(&view, cx);
    // Linux sends Cmd-V text synchronously from GPUI's clipboard, so there is
    // no background read for a navigation to overtake.
    if cfg!(target_os = "linux") {
        return;
    }

    // A navigation starting while the clipboard is read cancels that paste.
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            cx.write_to_clipboard(ClipboardItem::new_string("stale target".into()));
            view.key_down(&paste, window, cx);
            view.live.activation.as_mut().unwrap().revision = None;
            assert!(view.live.activation_pending());
        });
    });
    cx.run_until_parked();
    wait_image_finished(&view, cx);
    view.update(cx, |view, cx| {
        view.live.activation = Some(settled(view));
        view.send(ClientPaneInputEvent::TextCommit("sentinel".into()), cx);
    });
    assert_eq!(
        server.receive(),
        ClientMessage::ClientShellPaneInput {
            pane_id: "w1:p1".into(),
            events: vec![ClientPaneInputEvent::TextCommit("sentinel".into())],
        }
    );
    view.read_with(cx, |view, _| assert!(view.local_error.is_none()));
}

#[gpui::test]
fn connected_image_paste_captures_pane_before_immediate_text_and_enter(
    cx: &mut gpui::TestAppContext,
) {
    let (fixture, cx) = cx.add_window_view(|window, cx| {
        Fixture(cx.new(|cx| crate::sidebar::layout_tests::fixture_window(window, cx)))
    });
    let view = fixture.update(cx, |fixture, _| fixture.0.clone());
    let (endpoint, mut server) = connected_endpoint("ssh:image");
    let enter = gpui::KeyDownEvent {
        keystroke: gpui::Keystroke::parse("enter").unwrap(),
        is_held: false,
        prefer_character_input: false,
    };
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            prepare_remote_image(view, endpoint, cx);
            assert!(view.paste_terminal_clipboard(clipboard_image(&[0, 1, 255]), false, cx));
            assert_eq!(view.pending_images.len(), 1);
            // Focus can move while preparation runs; the image retains its original pane.
            Arc::make_mut(view.live.snapshot.as_mut().unwrap()).focused_pane_id =
                Some("w1:p2".into());
            view.send(ClientPaneInputEvent::TextCommit("after image".into()), cx);
            view.key_down(&enter, window, cx);
        });
    });
    cx.run_until_parked();
    assert_eq!(
        server.receive(),
        ClientMessage::ClipboardImage {
            target: ClientClipboardImageTarget::Pane("w1:p1".into()),
            extension: "png".into(),
            data: vec![0, 1, 255],
        }
    );
    for event in [
        ClientPaneInputEvent::TextCommit("after image".into()),
        crate::terminal::key_input(&enter, true).unwrap(),
    ] {
        assert_eq!(
            server.receive(),
            ClientMessage::ClientShellPaneInput {
                pane_id: "w1:p2".into(),
                events: vec![event],
            }
        );
    }
    wait_image_finished(&view, cx);
    view.read_with(cx, |view, _| assert!(view.local_error.is_none()));
}

#[gpui::test]
fn connected_image_paste_popup_never_reaches_underlying_pane(cx: &mut gpui::TestAppContext) {
    let (fixture, cx) = cx.add_window_view(|window, cx| {
        Fixture(cx.new(|cx| crate::sidebar::layout_tests::fixture_window(window, cx)))
    });
    let view = fixture.update(cx, |fixture, _| fixture.0.clone());
    let (endpoint, mut server) = connected_endpoint("ssh:image");
    view.update(cx, |view, cx| {
        prepare_remote_image(view, endpoint, cx);
        image_popup(view, "image-popup");
        assert!(view.paste_terminal_clipboard(clipboard_image(&[42]), false, cx));
        view.send(ClientPaneInputEvent::TextCommit("popup only".into()), cx);
    });
    cx.run_until_parked();
    assert_eq!(
        server.receive(),
        ClientMessage::ClipboardImage {
            target: ClientClipboardImageTarget::Popup("image-popup".into()),
            extension: "png".into(),
            data: vec![42],
        }
    );
    assert_eq!(
        server.receive(),
        ClientMessage::ClientShellPopupInput {
            terminal_id: "image-popup".into(),
            events: vec![ClientPaneInputEvent::TextCommit("popup only".into())],
        }
    );
    wait_image_finished(&view, cx);
    view.read_with(cx, |view, _| assert!(view.local_error.is_none()));
}

#[gpui::test]
fn connected_image_paste_image_only_preserves_text(cx: &mut gpui::TestAppContext) {
    let (fixture, cx) = cx.add_window_view(|window, cx| {
        Fixture(cx.new(|cx| crate::sidebar::layout_tests::fixture_window(window, cx)))
    });
    let view = fixture.update(cx, |fixture, _| fixture.0.clone());
    for remote in [false, true] {
        let (endpoint, mut server) = connected_endpoint("image");
        view.update(cx, |view, cx| {
            if remote {
                prepare_remote_image(view, endpoint, cx);
            } else {
                prepare_mouse(view, endpoint, cx);
                assert!(!view.accepts_remote_images());
            }
            let text = ClipboardItem::new_string("ordinary text".into());
            assert!(!view.paste_terminal_clipboard(text.clone(), true, cx));
            assert!(view.pending_images.is_empty());
            assert!(view.paste_terminal_clipboard(text, false, cx));
            view.send(ClientPaneInputEvent::TextCommit("sentinel".into()), cx);
        });
        cx.run_until_parked();
        for event in [
            ClientPaneInputEvent::Paste("ordinary text".into()),
            ClientPaneInputEvent::TextCommit("sentinel".into()),
        ] {
            assert_eq!(
                server.receive(),
                ClientMessage::ClientShellPaneInput {
                    pane_id: "w1:p1".into(),
                    events: vec![event],
                },
                "remote={remote}"
            );
        }
        view.read_with(cx, |view, _| {
            assert!(view.pending_images.is_empty());
            assert!(view.local_error.is_none());
        });
    }
}

#[gpui::test]
fn connected_image_paste_local_bridges_clipboard_image_but_not_paths(
    cx: &mut gpui::TestAppContext,
) {
    let (fixture, cx) = cx.add_window_view(|window, cx| {
        Fixture(cx.new(|cx| crate::sidebar::layout_tests::fixture_window(window, cx)))
    });
    let view = fixture.update(cx, |fixture, _| fixture.0.clone());
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("local image.png");
    std::fs::write(&path, [1, 2, 3]).unwrap();
    let text = format!("'{}'", path.display());
    let (endpoint, mut server) = connected_endpoint("image");
    view.update(cx, |view, cx| {
        prepare_mouse(view, endpoint, cx);
        assert!(view.accepts_clipboard_images());
        assert!(!view.accepts_remote_images());
        assert!(view.paste_terminal_clipboard(clipboard_image(&[42]), false, cx));
        assert_eq!(view.pending_images.len(), 1);
        // A local pane reads the original file; only remote panes need its bytes.
        assert!(view.paste_terminal_clipboard(ClipboardItem::new_string(text.clone()), false, cx));
        assert_eq!(view.pending_images.len(), 1);
    });
    cx.run_until_parked();
    assert_eq!(
        server.receive(),
        ClientMessage::ClipboardImage {
            target: ClientClipboardImageTarget::Pane("w1:p1".into()),
            extension: "png".into(),
            data: vec![42],
        }
    );
    assert_eq!(
        server.receive(),
        ClientMessage::ClientShellPaneInput {
            pane_id: "w1:p1".into(),
            events: vec![ClientPaneInputEvent::Paste(text)],
        }
    );
    wait_image_finished(&view, cx);
    view.read_with(cx, |view, _| assert!(view.local_error.is_none()));
}

#[gpui::test]
fn connected_image_paste_missing_path_falls_back_in_reserved_order(cx: &mut gpui::TestAppContext) {
    let (fixture, cx) = cx.add_window_view(|window, cx| {
        Fixture(cx.new(|cx| crate::sidebar::layout_tests::fixture_window(window, cx)))
    });
    let view = fixture.update(cx, |fixture, _| fixture.0.clone());
    let directory = tempfile::tempdir().unwrap();
    let text = format!(
        "'{}'\r\n",
        directory.path().join("missing image.png").display()
    );
    let (endpoint, mut server) = connected_endpoint("ssh:image");
    view.update(cx, |view, cx| {
        prepare_remote_image(view, endpoint, cx);
        assert!(view.paste_terminal_clipboard(ClipboardItem::new_string(text.clone()), false, cx));
        assert_eq!(view.pending_images.len(), 1);
        view.send(
            ClientPaneInputEvent::TextCommit("after fallback".into()),
            cx,
        );
    });
    cx.run_until_parked();
    for event in [
        ClientPaneInputEvent::Paste(text),
        ClientPaneInputEvent::TextCommit("after fallback".into()),
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
fn connected_image_paste_cancels_stale_preparation_without_blocking_fifo(
    cx: &mut gpui::TestAppContext,
) {
    let (fixture, cx) = cx.add_window_view(|window, cx| {
        Fixture(cx.new(|cx| crate::sidebar::layout_tests::fixture_window(window, cx)))
    });
    let view = fixture.update(cx, |fixture, _| fixture.0.clone());
    for change in [
        "epoch",
        "generation",
        "boot",
        "menu",
        "pane",
        "popup",
        "endpoint",
        "local",
    ] {
        for cancel_before_prepare in [false, true] {
            let (endpoint, mut server) = connected_endpoint("ssh:image");
            cx.update(|window, cx| {
                view.update(cx, |view, cx| {
                    prepare_remote_image(view, endpoint, cx);
                    if change == "popup" {
                        image_popup(view, "original-popup");
                    }
                    assert!(view.paste_terminal_clipboard(clipboard_image(&[42]), false, cx));
                    assert_eq!(view.pending_images.len(), 1);
                    match change {
                        "epoch" => view.selection_epoch += 1,
                        "generation" => view.endpoints[1].generation += 1,
                        "boot" => {
                            Arc::make_mut(view.live.snapshot.as_mut().unwrap()).boot_id =
                                "replacement".into();
                            Arc::make_mut(view.live.surface.as_mut().unwrap()).boot_id =
                                "replacement".into();
                        }
                        "menu" => view.open_keybinds(window, cx),
                        "pane" => Arc::make_mut(view.live.surface.as_mut().unwrap())
                            .panes
                            .retain(|pane| pane.pane_id != "w1:p1"),
                        "popup" => image_popup(view, "replacement-popup"),
                        "endpoint" => view.endpoints[1].id = "ssh:replacement".into(),
                        "local" => {
                            view.endpoints[1].connection.target =
                                ConnectTarget::Socket(server.path.clone());
                        }
                        _ => unreachable!(),
                    }
                    if cancel_before_prepare {
                        view.cancel_stale_image();
                        // Cancellation retains the task until its background work exits.
                        assert_eq!(view.pending_images.len(), 1);
                    }
                    view.endpoints[1]
                        .connection
                        .handle
                        .as_ref()
                        .unwrap()
                        .set_focus(&snapshot().boot_id, false)
                        .unwrap();
                });
            });
            cx.run_until_parked();
            // A bounded FIFO sentinel catches both stray images and stuck cancelled slots.
            assert_eq!(
                server.receive(),
                ClientMessage::ClientShellFocus { focused: false },
                "{change}, cancel_before_prepare={cancel_before_prepare}"
            );
            wait_image_finished(&view, cx);
            view.read_with(cx, |view, _| {
                assert!(view.local_error.is_none(), "{change}")
            });
        }
    }
}

#[gpui::test]
fn connected_image_paste_busy_guard_releases_after_completion(cx: &mut gpui::TestAppContext) {
    let (fixture, cx) = cx.add_window_view(|window, cx| {
        Fixture(cx.new(|cx| crate::sidebar::layout_tests::fixture_window(window, cx)))
    });
    let view = fixture.update(cx, |fixture, _| fixture.0.clone());
    let (endpoint, mut server) = connected_endpoint("ssh:image");
    view.update(cx, |view, cx| prepare_remote_image(view, endpoint, cx));
    for byte in [1, 2] {
        view.update(cx, |view, cx| {
            assert!(view.pending_images.is_empty());
            assert!(view.paste_terminal_clipboard(clipboard_image(&[byte]), false, cx));
            assert!(view.paste_terminal_clipboard(clipboard_image(&[99]), false, cx));
            assert_eq!(
                view.local_error.as_deref(),
                Some(
                    format!(
                        "Image not sent: {}",
                        herdr_client::Error::ClipboardImageBusy
                    )
                    .as_str()
                )
            );
            view.send(ClientPaneInputEvent::TextCommit("sentinel".into()), cx);
        });
        cx.run_until_parked();
        assert_eq!(
            server.receive(),
            ClientMessage::ClipboardImage {
                target: ClientClipboardImageTarget::Pane("w1:p1".into()),
                extension: "png".into(),
                data: vec![byte],
            }
        );
        assert_eq!(
            server.receive(),
            ClientMessage::ClientShellPaneInput {
                pane_id: "w1:p1".into(),
                events: vec![ClientPaneInputEvent::TextCommit("sentinel".into())],
            }
        );
        wait_image_finished(&view, cx);
    }
}

#[gpui::test]
fn connected_image_paste_reconnect_cancels_old_task_and_keeps_single_preparation(
    cx: &mut gpui::TestAppContext,
) {
    use std::io::Read as _;

    let (fixture, cx) = cx.add_window_view(|window, cx| {
        Fixture(cx.new(|cx| crate::sidebar::layout_tests::fixture_window(window, cx)))
    });
    let view = fixture.update(cx, |fixture, _| fixture.0.clone());
    let (endpoint, mut old_server) = connected_endpoint("ssh:image");
    let (replacement, mut server) = connected_endpoint("ssh:image");
    let directory = tempfile::tempdir().unwrap();
    view.update(cx, |view, cx| {
        prepare_remote_image(view, endpoint, cx);
        assert!(view.paste_terminal_clipboard(clipboard_image(&[1]), false, cx));
        view.send(
            ClientPaneInputEvent::TextCommit("must not replay".into()),
            cx,
        );
        // Exercise reconnect without ever launching SSH or discovering a personal daemon.
        view.endpoints[1].connection.target =
            ConnectTarget::Socket(directory.path().join("missing.sock"));
        view.reconnect(cx);
        assert_eq!(view.pending_images.len(), 1);
        prepare_remote_image(view, replacement, cx);
        assert!(view.paste_terminal_clipboard(clipboard_image(&[2]), false, cx));
        assert!(view.local_error.is_some());
        view.send(
            ClientPaneInputEvent::TextCommit("replacement sentinel".into()),
            cx,
        );
    });
    cx.run_until_parked();
    assert_eq!(old_server.stream.read(&mut [0]).unwrap(), 0);
    assert_eq!(
        server.receive(),
        ClientMessage::ClientShellPaneInput {
            pane_id: "w1:p1".into(),
            events: vec![ClientPaneInputEvent::TextCommit(
                "replacement sentinel".into()
            )],
        }
    );
    wait_image_finished(&view, cx);
    view.update(cx, |view, cx| {
        assert!(view.paste_terminal_clipboard(clipboard_image(&[3]), false, cx));
    });
    cx.run_until_parked();
    assert_eq!(
        server.receive(),
        ClientMessage::ClipboardImage {
            target: ClientClipboardImageTarget::Pane("w1:p1".into()),
            extension: "png".into(),
            data: vec![3],
        }
    );
    wait_image_finished(&view, cx);
}
