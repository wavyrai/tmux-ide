#![allow(clippy::unwrap_used)]
use super::*;
use core::prelude::v1::test;
use herdr_client::ClientEvent;
use std::sync::Arc;

pub(crate) mod close_option;
mod menu_width;

fn snapshot() -> ClientShellSnapshot {
    let mut snapshot: ClientShellSnapshot = serde_json::from_str(include_str!(
        "../../../herdr-protocol/tests/fixtures/endpoint-snapshot-v1.json"
    ))
    .unwrap();
    let mut pane = snapshot.panes[0].clone();
    pane.pane_id = "inactive".into();
    pane.label = Some("Original label".into());
    snapshot.panes.push(pane);
    snapshot
}

#[test]
fn captured_pane_payloads_ignore_focus_and_reject_stale_membership() {
    let original = snapshot();
    let target = Target::capture(&original, "inactive").unwrap();
    let mut snapshot = original.clone();
    snapshot.focused_pane_id = None;
    snapshot.focused_tab_id = None;
    snapshot.focused_workspace_id = None;
    assert!(target.validate(&snapshot).is_ok());
    assert_eq!(
        target.rename_params("  \u{4e2d}  "),
        json!({"pane_id":"inactive", "label":"\u{4e2d}"})
    );
    assert_eq!(
        target.rename_params(" \u{2003}\t"),
        json!({"pane_id":"inactive", "label":""})
    );
    for (action, direction) in [(Action::SplitRight, "right"), (Action::SplitDown, "down")] {
        assert_eq!(
            action.request(&target).unwrap(),
            (
                Method::PaneSplit,
                json!({"target_pane_id":"inactive", "direction":direction, "focus":true})
            )
        );
    }
    assert_eq!(
        Action::Zoom.request(&target).unwrap(),
        (Method::PaneZoom, json!({"pane_id":"inactive", "mode":"on"}))
    );
    assert_eq!(Action::Zoom.label(&target), "Zoom");
    let mut zoomed = original.clone();
    zoomed.tabs[0].zoomed = true;
    let target_zoomed = Target::capture(&zoomed, "inactive").unwrap();
    assert_eq!(Action::Zoom.label(&target_zoomed), "Unzoom");
    assert_eq!(
        Action::Zoom.request(&target_zoomed).unwrap(),
        (
            Method::PaneZoom,
            json!({"pane_id":"inactive", "mode":"off"})
        )
    );
    // The focused pane takes the menu's pane's place.
    assert_eq!(
        Action::Swap.request(&target).unwrap(),
        (
            Method::PaneSwap,
            json!({"source_pane_id": original.focused_pane_id, "target_pane_id":"inactive"})
        )
    );
    let focused = Target::capture(&original, original.focused_pane_id.as_deref().unwrap()).unwrap();
    assert!(focused.focused.is_none());
    assert!(Action::Swap.request(&focused).is_none());
    assert_eq!(
        Action::RightClick.request(&target).unwrap(),
        (
            Method::PaneInputSet,
            json!({"pane_id":"inactive", "right_click":"pane"})
        )
    );
    assert_eq!(
        Action::RightClick.label(&target),
        "Send Right-Clicks to Pane"
    );
    let mut routed = original.clone();
    routed.panes[1].right_click_passthrough = true;
    let routed = Target::capture(&routed, "inactive").unwrap();
    assert_eq!(
        Action::RightClick.request(&routed).unwrap(),
        (
            Method::PaneInputSet,
            json!({"pane_id":"inactive", "right_click":"herdr"})
        )
    );
    assert_eq!(
        Action::RightClick.label(&routed),
        "Open This Menu on Right-Click"
    );
    for case in 0..7 {
        let mut snapshot = original.clone();
        match case {
            0 => snapshot.boot_id.push('x'),
            1 => snapshot.workspaces.clear(),
            2 => snapshot.tabs.clear(),
            3 => snapshot.tabs[0].workspace_id.push('x'),
            4 => snapshot.panes[1].tab_id.push('x'),
            5 => snapshot.panes[1].workspace_id.push('x'),
            _ => snapshot.panes.truncate(1),
        }
        assert!(matches!(
            target.validate(&snapshot),
            Err(crate::Error::StalePane)
        ));
    }
}

#[gpui::test]
fn menu_isolation_rename_composition_close_and_endpoint_fences(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(|window, cx| {
        crate::bind_keys(cx);
        let mut view = crate::sidebar::layout_tests::fixture_window(window, cx);
        view.live.snapshot = Some(Arc::new(snapshot()));
        view
    });
    cx.simulate_resize(size(px(800.), px(600.)));
    cx.update(|window, cx| {
        view.update(cx, |v, cx| {
            v.open_pane_menu("inactive", point(px(799.), px(599.)), window, cx)
        });
        window.draw(cx).clear(cx);
    });
    let panel = cx.debug_bounds("menu-panel").unwrap();
    assert_eq!(panel.left(), (px(788.) - panel.size.width).round());
    assert_eq!(panel.top(), (px(588.) - panel.size.height).round());
    assert!(panel.right() <= px(800.) && panel.bottom() <= px(600.));
    for selector in [
        "pane-menu-0",
        "pane-menu-1",
        "pane-menu-2",
        "pane-menu-3",
        "pane-menu-4",
        "pane-menu-5",
        "pane-menu-6",
        "pane-menu-7",
    ] {
        assert!(cx.debug_bounds(selector).is_some());
    }
    assert!(cx.debug_bounds("pane-menu-8").is_none());
    cx.simulate_keystrokes("enter cmd-t cmd-w cmd-b");
    view.read_with(cx, |v, _| {
        assert_eq!(v.menu.page, Some(Page::Pane));
        assert!(v.sidebar_visible && v.pending_navigation.is_none());
        assert_ne!(
            v.live.snapshot.as_ref().unwrap().focused_pane_id.as_deref(),
            Some("inactive")
        );
    });
    cx.simulate_keystrokes("down enter");
    let input = view.read_with(cx, |v, _| {
        assert_eq!(v.menu.page, Some(Page::RenamePane));
        v.menu.pane.as_ref().unwrap().input.clone().unwrap()
    });
    cx.update(|window, cx| {
        input.update(cx, |input, cx| {
            assert_eq!(input.text(), "Original label");
            assert_eq!(
                input.selected_text_range(false, window, cx).unwrap().range,
                0..14
            );
            input.replace_and_mark_text_in_range(None, "\u{4e2d}", Some(0..1), window, cx);
        });
        window.draw(cx).clear(cx);
    });
    cx.simulate_keystrokes("enter");
    assert!(view.read_with(cx, |v, _| v.menu.page == Some(Page::RenamePane)));
    cx.update(|window, cx| {
        input.update(cx, |input, cx| {
            input.set_text_selected("", cx);
            input.replace_and_mark_text_in_range(None, "\u{4e2d}", Some(0..1), window, cx);
        });
        window.draw(cx).clear(cx);
    });
    cx.simulate_keystrokes("escape");
    assert!(
        view.read_with(cx, |v, _| v.menu.page == Some(Page::RenamePane)
            && v.menu.pane.as_ref().unwrap().pending.is_none())
    );
    cx.update(|window, cx| {
        input.update(cx, |input, cx| {
            input.replace_text_in_range(None, "", window, cx)
        })
    });
    cx.simulate_keystrokes("escape");
    cx.update(|window, cx| assert!(view.read(cx).focus.is_focused(window)));

    for fence in [false, true] {
        cx.update(|window, cx| {
            view.update(cx, |v, cx| {
                v.open_pane_menu("inactive", Point::default(), window, cx);
                if fence {
                    v.endpoints[0].generation += 1;
                } else {
                    v.selection_epoch += 1;
                }
                for action in ACTIONS {
                    v.activate_pane_menu(action, window, cx);
                    assert_eq!(v.menu.page, Some(Page::Pane));
                    assert!(v.menu.pane.as_ref().unwrap().error.is_some());
                    assert!(v.menu.close.is_none());
                }
                v.dismiss_menu(window, cx);
            })
        });
    }
    cx.update(|window, cx| {
        view.update(cx, |v, cx| {
            v.open_pane_menu("inactive", Point::default(), window, cx);
            v.activate_pane_menu(Action::Close, window, cx);
            assert_eq!(v.menu.page, Some(Page::ConfirmClose));
        })
    });
    cx.simulate_keystrokes("enter");
    assert!(view.read_with(cx, |v, _| v.menu.page.is_none()));
    for button in [MouseButton::Left, MouseButton::Right] {
        cx.update(|window, cx| {
            view.update(cx, |v, cx| {
                v.open_pane_menu("inactive", point(px(799.), px(599.)), window, cx)
            });
            window.draw(cx).clear(cx);
        });
        cx.simulate_mouse_down(point(px(5.), px(5.)), button, Modifiers::default());
        assert!(view.read_with(cx, |v, _| v.menu.page.is_none()));
    }
}

/// Shows the "inactive" pane over a cancelled connection, so input is
/// routed for real but nothing reaches a daemon. Returns a point inside it.
fn live_pane(
    v: &mut HerdrWindow,
    mouse_reporting: bool,
    window: &mut Window,
    cx: &mut Context<HerdrWindow>,
) -> Point<Pixels> {
    use herdr_client::protocol::{FrameData, PaneSurfaceFrame, PaneSurfacePane, SurfaceRect};
    // Initialize surface interest without connecting to a personal daemon.
    // A cancelled handle lets queue-failure paths run deterministically.
    v.reconnect(cx);
    let client = herdr_client::connect(
        herdr_client::ConnectTarget::Socket("/unused-pane-menu-test.sock".into()),
        v.options,
    )
    .unwrap();
    client.handle.disconnect();
    v.endpoints[0].connection.handle = Some(client.handle);
    let snapshot = snapshot();
    let rect = SurfaceRect {
        x: 0,
        y: 0,
        width: v.options.surface_size.cols,
        height: v.options.surface_size.rows,
    };
    v.live.surface = Some(Arc::new(PaneSurfaceFrame {
        boot_id: snapshot.boot_id.clone(),
        projection_revision: snapshot.revision,
        surface_revision: 1,
        frame: FrameData {
            width: rect.width,
            height: rect.height,
            cells: vec![],
            cursor: None,
            hyperlinks: vec![],
            graphics: vec![],
        },
        panes: vec![PaneSurfacePane {
            pane_id: "inactive".into(),
            content_revision: 1,
            rect,
            inner_rect: rect,
            scrollbar_rect: None,
            scroll: None,
            focused: false,
            mouse_reporting,
            sgr_pixel_mouse: false,
            alternate_screen_active: false,
            pixel_width: 0,
            pixel_height: 0,
        }],
        splits: vec![],
        popup: None,
        graphics: Default::default(),
    }));
    v.live.snapshot = Some(Arc::new(snapshot));
    v.live.status = crate::state::ConnectionStatus::Connected;
    assert!(v.input_ready());
    v.dismiss_menu(window, cx);
    v.bounds.origin
        + point(
            px(v.cell_width * 2.),
            px(v.config.terminal.line_height() * 2.),
        )
}

#[gpui::test]
fn right_click_targets_inactive_pane_and_blocks_stale_surfaces(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(|window, cx| {
        crate::bind_keys(cx);
        crate::sidebar::layout_tests::fixture_window(window, cx)
    });
    cx.simulate_resize(size(px(800.), px(600.)));
    cx.update(|window, cx| {
        window.draw(cx).clear(cx);
    });
    let position = cx.update(|window, cx| view.update(cx, |v, cx| live_pane(v, false, window, cx)));
    // Use the actual terminal mouse handler, not just menu construction.
    cx.simulate_mouse_down(position, MouseButton::Right, Modifiers::default());
    cx.update(|window, cx| window.draw(cx).clear(cx));
    // A second press before release must not dismiss the menu just opened.
    cx.simulate_mouse_down(position, MouseButton::Right, Modifiers::default());
    assert!(view.read_with(cx, |v, _| v.menu.page == Some(Page::Pane)));
    cx.simulate_mouse_up(position, MouseButton::Right, Modifiers::default());
    view.read_with(cx, |v, _| {
        assert!(!v.menu.opening_right_click);
        assert_eq!(v.menu.pane.as_ref().unwrap().target.pane, "inactive");
        assert!(v.pending_navigation.is_none());
        assert_ne!(
            v.live.snapshot.as_ref().unwrap().focused_pane_id.as_deref(),
            Some("inactive")
        );
    });
    cx.update(|window, cx| {
        view.update(cx, |v, cx| {
            for action in [Action::SplitRight, Action::SplitDown, Action::Zoom] {
                v.activate_pane_menu(action, window, cx);
                assert_eq!(v.menu.page, Some(Page::Pane));
                assert!(v.menu.pane.as_ref().unwrap().error.is_some());
            }
            v.dismiss_menu(window, cx);
            let surface = v.live.surface.clone().unwrap();
            // Retain the presented picture, but never use it to aim a new action.
            assert!(v.presentation.frame(&v.live).is_some());
            v.live.surface = None;
            assert!(v.presentation.frame(&v.live).is_some());
            v.open_pane_menu_at(position, window, cx);
            assert!(v.menu.page.is_none());
            v.live.surface = Some(surface.clone());
            Arc::make_mut(v.live.snapshot.as_mut().unwrap()).revision += 1;
            v.open_pane_menu_at(position, window, cx);
            assert!(v.menu.page.is_none());
            Arc::make_mut(v.live.snapshot.as_mut().unwrap()).revision -= 1;
            v.options.surface_size.cols += 1;
            v.open_pane_menu_at(position, window, cx);
            assert!(v.menu.page.is_none());
            v.options.surface_size.cols -= 1;
            Arc::make_mut(v.live.surface.as_mut().unwrap()).popup =
                Some(Box::new(herdr_client::protocol::ClientShellPopupSurface {
                    terminal_id: "popup".into(),
                    title: String::new(),
                    width: None,
                    height: None,
                    frame: surface.frame.clone(),
                    mouse_reporting: false,
                    sgr_pixel_mouse: false,
                    pixel_width: 0,
                    pixel_height: 0,
                }));
            assert!(v.input_ready());
            v.open_pane_menu_at(position, window, cx);
            assert!(v.menu.page.is_none());
            v.live.surface = Some(surface);
            Arc::make_mut(v.live.snapshot.as_mut().unwrap())
                .panes
                .truncate(1);
            assert!(v.input_ready());
            v.open_pane_menu_at(position, window, cx);
            assert!(v.menu.page.is_none());
        })
    });
}

/// Herdr's per-pane routing decides where a plain right-click goes, even
/// for a mouse-aware application; a modifier always reaches the menu so the
/// routing can be switched back, and a pane without mouse reporting cannot
/// take the click, so it falls back to the menu.
#[gpui::test]
fn right_click_follows_the_panes_routing(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(|window, cx| {
        crate::bind_keys(cx);
        crate::sidebar::layout_tests::fixture_window(window, cx)
    });
    cx.simulate_resize(size(px(800.), px(600.)));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    let route = |view: &Entity<HerdrWindow>, cx: &mut VisualTestContext, routed: bool| {
        cx.update(|window, cx| {
            view.update(cx, |v, cx| {
                v.dismiss_menu(window, cx);
                // Only the click under test may report a send failure.
                v.last_queued_options = Some(v.options);
                v.local_error = None;
                let snapshot = Arc::make_mut(v.live.snapshot.as_mut().unwrap());
                for pane in &mut snapshot.panes {
                    pane.right_click_passthrough = routed && pane.pane_id == "inactive";
                }
            });
            window.draw(cx).clear(cx);
        });
    };
    let position = cx.update(|window, cx| view.update(cx, |v, cx| live_pane(v, true, window, cx)));
    // The cancelled test connection reports a click it was asked to send,
    // which tells a forwarded click from one the window kept.
    let forwarded = |view: &Entity<HerdrWindow>, cx: &mut VisualTestContext| {
        view.read_with(cx, |v, _| {
            v.local_error
                .as_deref()
                .is_some_and(|error| error.starts_with("Mouse input not sent"))
        })
    };
    let menu_target = |view: &Entity<HerdrWindow>, cx: &mut VisualTestContext| {
        view.read_with(cx, |v, _| {
            (v.menu.page == Some(Page::Pane))
                .then(|| v.menu.pane.as_ref().unwrap().target.right_click_passthrough)
        })
    };

    route(&view, cx, false);
    cx.simulate_mouse_down(position, MouseButton::Right, Modifiers::default());
    cx.simulate_mouse_up(position, MouseButton::Right, Modifiers::default());
    assert_eq!(menu_target(&view, cx), Some(false));
    assert!(!forwarded(&view, cx));

    route(&view, cx, true);
    cx.simulate_mouse_down(position, MouseButton::Right, Modifiers::default());
    cx.simulate_mouse_up(position, MouseButton::Right, Modifiers::default());
    assert_eq!(menu_target(&view, cx), None);
    assert!(forwarded(&view, cx));

    for modifiers in [Modifiers::shift(), Modifiers::control(), Modifiers::alt()] {
        route(&view, cx, true);
        cx.simulate_mouse_down(position, MouseButton::Right, modifiers);
        cx.simulate_mouse_up(position, MouseButton::Right, modifiers);
        assert_eq!(menu_target(&view, cx), Some(true));
        assert!(!forwarded(&view, cx));
    }

    route(&view, cx, true);
    cx.update(|window, cx| {
        view.update(cx, |v, _| {
            Arc::make_mut(v.live.surface.as_mut().unwrap()).panes[0].mouse_reporting = false;
        });
        window.draw(cx).clear(cx);
    });
    cx.simulate_mouse_down(position, MouseButton::Right, Modifiers::default());
    cx.simulate_mouse_up(position, MouseButton::Right, Modifiers::default());
    assert_eq!(menu_target(&view, cx), Some(true));
    assert!(!forwarded(&view, cx));
}

#[gpui::test]
fn pane_rename_correlates_responses_and_preserves_other_dialogs(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = crate::sidebar::layout_tests::fixture_window(window, cx);
        view.live.snapshot = Some(Arc::new(snapshot()));
        view
    });
    cx.update(|window, cx| {
        view.update(cx, |v, cx| {
            v.open_pane_menu("inactive", Point::default(), window, cx);
            v.activate_pane_menu(Action::Rename, window, cx);
            v.live.dialog_response = Some(("removal".into(), None));
            for outcome in ["rejected", "daemon-error", "success"] {
                v.menu.pane.as_mut().unwrap().pending = Some(outcome.into());
                v.live.pane_rename = Some(crate::state::RenameResult {
                    request: outcome.into(),
                    result: None,
                });
                v.live.apply(ClientEvent::Response {
                    request_id: "unrelated".into(),
                    response: json!({"error":"unrelated"}),
                });
                v.poll_pane_rename(window, cx);
                assert!(v.menu.pane.as_ref().unwrap().pending.is_some());
                if outcome == "rejected" {
                    v.live.apply(ClientEvent::CommandRejected {
                        request_id: Some(outcome.into()),
                        reason: herdr_client::Error::UnsupportedMethod,
                    });
                } else {
                    v.live.apply(ClientEvent::Response {
                        request_id: outcome.into(),
                        response: if outcome == "success" {
                            json!({"result":{}})
                        } else {
                            json!({"error":{"message":"Invalid label"}})
                        },
                    });
                }
                v.live.apply(ClientEvent::Response {
                    request_id: "removal".into(),
                    response: json!({"result":{}}),
                });
                // A rename response must survive an unrelated response and invalidated surface.
                assert!(!v.input_ready());
                v.poll_pane_rename(window, cx);
                if outcome == "success" {
                    assert!(v.menu.page.is_none());
                } else {
                    let pane = v.menu.pane.as_ref().unwrap();
                    assert!(pane.pending.is_none());
                    assert!(
                        pane.error
                            .as_ref()
                            .unwrap()
                            .contains(if outcome == "rejected" {
                                "method not advertised"
                            } else {
                                "Invalid label"
                            })
                    );
                }
            }
            assert!(matches!(&v.live.dialog_response, Some((id, Some(Ok(_)))) if id == "removal"));
            for fence in ["selection", "generation", "boot", "membership"] {
                v.live.snapshot = Some(Arc::new(snapshot()));
                v.open_pane_menu("inactive", Point::default(), window, cx);
                v.activate_pane_menu(Action::Rename, window, cx);
                v.menu.pane.as_mut().unwrap().pending = Some("late".into());
                v.live.pane_rename = Some(crate::state::RenameResult {
                    request: "late".into(),
                    result: Some(Ok(())),
                });
                match fence {
                    "selection" => v.selection_epoch += 1,
                    "generation" => v.endpoints[0].generation += 1,
                    "boot" => Arc::make_mut(v.live.snapshot.as_mut().unwrap())
                        .boot_id
                        .push('x'),
                    _ => Arc::make_mut(v.live.snapshot.as_mut().unwrap())
                        .panes
                        .truncate(1),
                }
                v.poll_pane_rename(window, cx);
                assert_eq!(v.menu.page, Some(Page::RenamePane));
                assert!(v.menu.pane.as_ref().unwrap().error.is_some());
                assert!(v.menu.pane.as_ref().unwrap().pending.is_none());
                v.dismiss_menu(window, cx);
            }
        })
    });
}
