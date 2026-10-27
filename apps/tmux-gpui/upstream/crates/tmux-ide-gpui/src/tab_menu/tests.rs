#![allow(clippy::unwrap_used)]
use super::*;
use core::prelude::v1::test;
use gpui::VisualTestContext;
use std::sync::Arc;

#[test]
fn tab_target_retains_membership_and_rejects_stale_snapshots() {
    let original: ClientShellSnapshot = serde_json::from_str(include_str!(
        "../../../herdr-protocol/tests/fixtures/endpoint-snapshot-v1.json"
    ))
    .unwrap();
    let target = Target::capture(&original, &original.tabs[0].tab_id).unwrap();
    let mut snapshot = original.clone();
    snapshot.focused_tab_id = None;
    snapshot.focused_workspace_id = None;
    assert!(target.validate(&snapshot).is_ok());
    assert_eq!(
        target.rename_params("  \u{4e2d}  ").unwrap(),
        json!({"tab_id": target.tab, "label": "\u{4e2d}"})
    );
    assert!(target.rename_params(" \u{2003}\t").is_err());
    snapshot.boot_id.push_str("-replaced");
    assert!(target.validate(&snapshot).is_err());
    snapshot = original.clone();
    snapshot.tabs[0].workspace_id.push_str("-moved");
    assert!(target.validate(&snapshot).is_err());
    snapshot = original.clone();
    snapshot.workspaces.clear();
    assert!(target.validate(&snapshot).is_err());
    snapshot = original;
    snapshot.tabs.clear();
    assert!(target.validate(&snapshot).is_err());
}

#[gpui::test]
fn inactive_tab_menu_rename_composition_cancel_and_fences(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(|window, cx| {
        crate::bind_keys(cx);
        let mut view = crate::sidebar::layout_tests::fixture_window(window, cx);
        view.live.snapshot = Some(Arc::new(
            serde_json::from_str(include_str!(
                "../../../herdr-protocol/tests/fixtures/endpoint-snapshot-v1.json"
            ))
            .unwrap(),
        ));
        let snapshot = Arc::make_mut(view.live.snapshot.as_mut().unwrap());
        let mut tab = snapshot.tabs[0].clone();
        tab.tab_id = "inactive".into();
        tab.label = "Original label".into();
        tab.focused = false;
        snapshot.tabs.push(tab);
        view
    });
    cx.simulate_resize(size(px(800.), px(600.)));
    cx.update(|window, cx| {
        window.draw(cx).clear(cx);
    });
    let original_focus = view.read_with(cx, |view, _| {
        view.live.snapshot.as_ref().unwrap().focused_tab_id.clone()
    });
    let tab_bounds = cx.debug_bounds("tab-inactive").unwrap();
    cx.simulate_mouse_down(
        tab_bounds.center(),
        MouseButton::Right,
        Modifiers::default(),
    );
    cx.update(|window, cx| window.draw(cx).clear(cx));
    // A second press before release must not dismiss the menu just opened.
    cx.simulate_mouse_down(
        tab_bounds.center(),
        MouseButton::Right,
        Modifiers::default(),
    );
    assert!(view.read_with(cx, |v, _| v.menu.page == Some(Page::Tab)));
    cx.simulate_mouse_up(
        tab_bounds.center(),
        MouseButton::Right,
        Modifiers::default(),
    );
    assert!(view.read_with(cx, |v, _| !v.menu.opening_right_click));
    view.read_with(cx, |view, _| {
        let tab = view.menu.tab.as_ref().unwrap();
        assert_eq!(tab.target.tab, "inactive");
        assert_eq!(tab.selected, None);
        assert_eq!(
            view.live.snapshot.as_ref().unwrap().focused_tab_id,
            original_focus
        );
        assert!(view.pending_navigation.is_none());
    });
    cx.simulate_keystrokes("enter");
    assert!(view.read_with(cx, |v, _| v.menu.page == Some(Page::Tab)));
    cx.simulate_keystrokes("down down enter");
    let input = view.read_with(cx, |v, _| {
        assert!(v.menu.page == Some(Page::RenameTab));
        v.menu.tab.as_ref().unwrap().input.clone().unwrap()
    });
    cx.update(|window, cx| {
        input.update(cx, |input, cx| {
            assert_eq!(input.text(), "Original label");
            assert_eq!(
                input.selected_text_range(false, window, cx).unwrap().range,
                0..14
            );
            input.replace_and_mark_text_in_range(None, "\u{4e2d}", Some(0..1), window, cx);
        })
    });
    cx.update(|window, cx| {
        window.draw(cx).clear(cx);
    });
    cx.simulate_keystrokes("enter");
    assert!(view.read_with(cx, |v, _| v.menu.page == Some(Page::RenameTab)));
    cx.update(|window, cx| {
        input.update(cx, |input, cx| {
            input.set_text_selected("", cx);
            input.replace_and_mark_text_in_range(None, "\u{4e2d}", Some(0..1), window, cx);
        });
        window.draw(cx).clear(cx);
    });
    cx.simulate_keystrokes("escape");
    assert!(view.read_with(cx, |v, _| v.menu.page == Some(Page::RenameTab)));
    assert!(view.read_with(cx, |v, _| v.menu.tab.as_ref().unwrap().pending.is_none()));
    cx.update(|window, cx| {
        input.update(cx, |input, cx| {
            input.replace_text_in_range(None, "", window, cx)
        })
    });
    cx.simulate_keystrokes("enter");
    assert_eq!(
        view.read_with(cx, |v, _| v.menu.tab.as_ref().unwrap().error.clone()),
        Some("Enter a tab name.".into())
    );
    cx.simulate_input("new label");
    cx.simulate_keystrokes("cmd-t cmd-w cmd-b");
    assert!(view.read_with(cx, |v, _| v.sidebar_visible
        && v.menu.page == Some(Page::RenameTab)));
    cx.simulate_keystrokes("escape");
    assert!(view.read_with(cx, |v, _| v.menu.tab.is_none()));
    cx.update(|window, cx| assert!(view.read(cx).focus.is_focused(window)));

    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.open_tab_menu("inactive", None, tab_bounds.center(), window, cx)
        });
        window.draw(cx).clear(cx);
    });
    assert!(cx.debug_bounds("tab-menu-2").is_some());
    assert!(cx.debug_bounds("tab-menu-3").is_none());
    let new_tab_row = cx.debug_bounds("tab-menu-0").unwrap();
    cx.simulate_mouse_move(new_tab_row.center(), None, Modifiers::default());
    assert_eq!(
        view.read_with(cx, |v, _| v.menu.tab.as_ref().unwrap().selected),
        Some(0)
    );
    cx.simulate_keystrokes("down enter");
    assert!(view.read_with(cx, |v, _| v.menu.page == Some(Page::RenameTab)));
    cx.simulate_keystrokes("escape");
    assert!(view.read_with(cx, |v, _| v.menu.page.is_none()));

    for generation in [false, true] {
        cx.update(|window, cx| {
            view.update(cx, |view, cx| {
                view.open_tab_menu("inactive", None, point(px(799.), px(599.)), window, cx);
                if generation {
                    view.endpoints[0].generation += 1;
                } else {
                    view.selection_epoch += 1;
                }
                assert!(!view.menu_target_current());
                for (action, _) in ACTIONS {
                    view.activate_tab_menu(action, window, cx);
                    assert!(view.menu.page == Some(Page::Tab));
                    assert!(view.menu.tab.as_ref().unwrap().error.is_some());
                }
            })
        });
        cx.simulate_keystrokes("escape");
    }

    for button in [MouseButton::Left, MouseButton::Right] {
        cx.update(|window, cx| {
            view.update(cx, |view, cx| {
                view.open_tab_menu("inactive", None, point(px(799.), px(599.)), window, cx)
            });
            window.draw(cx).clear(cx);
        });
        let panel = cx.debug_bounds("menu-panel").unwrap();
        assert_eq!(panel.left(), (px(788.) - panel.size.width).round());
        assert_eq!(panel.top(), (px(588.) - panel.size.height).round());
        assert!(panel.right() <= px(800.) && panel.bottom() <= px(600.));
        assert!(panel.left() >= px(12.) && panel.top() >= px(12.));
        cx.simulate_mouse_down(point(px(5.), px(5.)), button, Modifiers::default());
        assert!(view.read_with(cx, |v, _| v.menu.page.is_none()));
    }
}

fn group_window(cx: &mut TestAppContext) -> (Entity<HerdrWindow>, &mut VisualTestContext) {
    use crate::sidebar::layout_tests::{fixture_window, snapshot};
    cx.add_window_view(|window, cx| {
        let mut view = fixture_window(window, cx);
        let mut shown = snapshot(1);
        shown.focused_workspace_id = Some("w0".into());
        shown.focused_tab_id = Some("t0".into());
        view.live.snapshot = Some(Arc::new(shown));
        view
    })
}

fn draw(cx: &mut VisualTestContext) {
    cx.update(|window, cx| crate::sidebar::layout_tests::full_draw(window, cx).clear(cx));
}

/// Right-clicks `tab`, then clicks the menu's `row`.
fn choose(cx: &mut VisualTestContext, tab: &'static str, row: &'static str) {
    draw(cx);
    let tab = cx.debug_bounds(tab).unwrap();
    cx.simulate_mouse_down(tab.center(), MouseButton::Right, Modifiers::default());
    cx.simulate_mouse_up(tab.center(), MouseButton::Right, Modifiers::default());
    draw(cx);
    let row = cx.debug_bounds(row).unwrap();
    cx.simulate_click(row.center(), Modifiers::none());
    draw(cx);
}

#[gpui::test]
fn close_tab_confirms_closing_that_tab_in_herdr(cx: &mut TestAppContext) {
    let (view, cx) = group_window(cx);
    choose(cx, "tab-t1", "tab-menu-2");
    view.read_with(cx, |view, _| {
        assert_eq!(view.menu.page, Some(Page::ConfirmClose));
        let snapshot = view.live.snapshot.as_ref().unwrap();
        assert_eq!(
            view.menu.close,
            crate::close_modal::CloseConfirmation::capture_tab(snapshot, "t1")
        );
    });
}

#[gpui::test]
fn close_tab_in_a_split_lets_only_its_group_go(cx: &mut TestAppContext) {
    let (view, cx) = group_window(cx);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.command(Command::SplitEditor, window, cx)
        })
    });
    draw(cx);
    let [left, right] = view.read_with(cx, |view, _| {
        view.group_slots()
            .into_iter()
            .map(|slot| slot.id)
            .collect::<Vec<_>>()
    })[..] else {
        panic!("two groups")
    };
    let tabs = |view: &Entity<HerdrWindow>, cx: &mut VisualTestContext, group| {
        cx.update(|_, cx| view.read(cx).group_tabs(group, cx))
    };
    choose(cx, "g1-tab-t1", "tab-menu-2");
    // No confirmation and nothing for Herdr: the tab left one strip.
    view.read_with(cx, |view, _| {
        assert!(view.menu.page.is_none() && view.menu.close.is_none());
        assert_eq!(view.live.snapshot.as_ref().unwrap().tabs.len(), 2);
    });
    assert!(!tabs(&view, cx, right).contains(&Pick::Herdr("t1".into())));
    assert!(tabs(&view, cx, left).contains(&Pick::Herdr("t1".into())));

    // New Tab opens in the group whose strip asked for it.
    choose(cx, "g1-tab-t0", "tab-menu-0");
    view.read_with(cx, |view, _| {
        assert!(view.menu.page.is_none());
        assert_eq!(view.expected_new_tab_group(), Some(right));
    });
}

#[gpui::test]
fn rename_response_is_correlated_and_survives_surface_invalidation(cx: &mut TestAppContext) {
    use crate::state::RenameResult;
    use herdr_client::ClientEvent;
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = crate::sidebar::layout_tests::fixture_window(window, cx);
        view.live.snapshot = Some(Arc::new(
            serde_json::from_str(include_str!(
                "../../../herdr-protocol/tests/fixtures/endpoint-snapshot-v1.json"
            ))
            .unwrap(),
        ));
        view
    });
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            let id = view.live.snapshot.as_ref().unwrap().tabs[0].tab_id.clone();
            view.open_tab_menu(&id, None, Point::default(), window, cx);
            view.activate_tab_menu(Action::Rename, window, cx);
            view.menu.tab.as_mut().unwrap().pending = Some("rename-1".into());
            view.live.tab_rename = Some(RenameResult {
                request: "rename-1".into(),
                result: None,
            });
            view.live.apply(ClientEvent::Response {
                request_id: "unrelated".into(),
                response: json!({"error":"unrelated failure"}),
            });
            view.poll_tab_rename(window, cx);
            assert!(view.menu.tab.as_ref().unwrap().pending.is_some());
            view.live.apply(ClientEvent::CommandRejected {
                request_id: Some("rename-1".into()),
                reason: herdr_client::Error::UnsupportedMethod,
            });
            view.poll_tab_rename(window, cx);
            assert_eq!(
                view.menu.tab.as_ref().unwrap().error.as_deref(),
                Some("method not advertised by endpoint")
            );
            assert!(view.menu.tab.as_ref().unwrap().pending.is_none());
            view.menu.tab.as_mut().unwrap().pending = Some("rename-error".into());
            view.live.tab_rename = Some(RenameResult {
                request: "rename-error".into(),
                result: None,
            });
            view.live.apply(ClientEvent::Response {
                request_id: "rename-error".into(),
                response: json!({"error":{"message":"Invalid label"}}),
            });
            // A later, unrelated response must not overwrite the modal's result.
            view.live.apply(ClientEvent::Response {
                request_id: "other".into(),
                response: json!({"result":{}}),
            });
            view.poll_tab_rename(window, cx);
            assert!(
                view.menu
                    .tab
                    .as_ref()
                    .unwrap()
                    .error
                    .as_ref()
                    .unwrap()
                    .contains("Invalid label")
            );
            view.menu.tab.as_mut().unwrap().pending = Some("rename-2".into());
            view.live.tab_rename = Some(RenameResult {
                request: "rename-2".into(),
                result: None,
            });
            view.live.apply(ClientEvent::Response {
                request_id: "rename-2".into(),
                response: json!({"result":{}}),
            });
            assert!(!view.input_ready());
            view.poll_tab_rename(window, cx);
            assert!(view.menu.page.is_none());
        })
    });
}
