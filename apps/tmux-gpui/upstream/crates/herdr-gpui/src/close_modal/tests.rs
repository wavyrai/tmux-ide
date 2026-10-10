#![allow(clippy::unwrap_used)]
use super::*;
use core::prelude::v1::test;
use std::sync::Arc;

mod pane_option;

#[gpui::test]
fn skipping_tab_confirmation_keeps_connection_checks_and_pane_prompt(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = crate::sidebar::layout_tests::fixture_window(window, cx);
        view.config.confirm_close_tab = false;
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
            view.open_tab_close(&id, window, cx);
            // The disconnected fixture must attempt the close immediately but refuse to send it.
            assert!(view.menu.close.as_ref().unwrap().error.is_some());
            assert!(view.pending_navigation.is_none());
            view.dismiss_menu(window, cx);
            view.open_close_confirmation(Command::CloseTab, window, cx);
            assert!(view.menu.close.as_ref().unwrap().error.is_some());
            view.dismiss_menu(window, cx);
            view.open_close_confirmation(Command::ClosePane, window, cx);
            assert!(view.menu.close.as_ref().unwrap().error.is_none());
            view.dismiss_menu(window, cx);
            view.config.confirm_close_tab = true;
            view.open_tab_close(&id, window, cx);
            assert!(view.menu.close.as_ref().unwrap().error.is_none());
        })
    });
}

#[gpui::test]
fn tab_icon_bounds_and_inactive_cross_confirmation(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(|window, cx| {
        crate::bind_keys(cx);
        let mut view = crate::sidebar::layout_tests::fixture_window(window, cx);
        let mut snapshot: ClientShellSnapshot = serde_json::from_str(include_str!(
            "../../../herdr-protocol/tests/fixtures/endpoint-snapshot-v1.json"
        ))
        .unwrap();
        // No status dots, so both tabs fit the narrow strip and the new
        // tab button still follows the last one rather than scrolling.
        snapshot.tabs[0].agent_status = AgentStatus::Unknown;
        let mut tab = snapshot.tabs[0].clone();
        tab.tab_id = "inactive".into();
        tab.focused = false;
        snapshot.tabs.push(tab);
        // A blocked agent in the inactive tab keeps its close behind the
        // confirmation this test exercises.
        let mut agent = snapshot.agents[0].clone();
        agent.tab_id = "inactive".into();
        snapshot.agents.push(agent);
        view.live.snapshot = Some(Arc::new(snapshot));
        view
    });
    // The window's least width still leaves both tabs room beside the title bar's
    // drag room and account slot.
    for width in [800., 640.] {
        cx.simulate_resize(size(px(width), px(600.)));
        cx.update(|window, cx| window.draw(cx).clear(cx));
        let button = cx.debug_bounds("new-tab").unwrap();
        let icon = cx.debug_bounds("new-tab-icon").unwrap();
        assert!(button.size.width >= px(34.));
        // As tall as the strip, which stands in for the title bar.
        assert_eq!(button.size.height, px(crate::titlebar::HEIGHT));
        assert_eq!(icon.size, size(px(14.), px(14.)));
        // Centred within the content box, which the divider insets by a pixel.
        assert!((button.center().x - icon.center().x).abs() <= px(1.));
        assert_eq!(button.center().y, icon.center().y);
        assert!(button.right() <= px(width));
        // The button follows the last tab rather than the window's right edge,
        // within the rounding of the tab's own one-pixel divider.
        let last = cx.debug_bounds("tab-inactive").unwrap();
        assert!((button.left() - last.right()).abs() <= px(1.), "{last:?}");
    }
    cx.simulate_resize(size(px(800.), px(600.)));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    let original_focus = view.read_with(cx, |view, _| {
        view.live.snapshot.as_ref().unwrap().focused_tab_id.clone()
    });
    let button = cx.debug_bounds("close-tab-inactive").unwrap();
    let icon = cx.debug_bounds("close-tab-icon-inactive").unwrap();
    assert_eq!(button.size, size(px(18.), px(18.)));
    assert_eq!(icon.size, size(px(12.), px(12.)));
    assert_eq!(button.center(), icon.center());
    // Hugging the tab's inner right edge, clear of the label beside it:
    // three pixels of padding inside the one-pixel divider.
    let tab = cx.debug_bounds("tab-inactive").unwrap();
    assert_eq!(tab.right() - button.right(), px(4.));
    assert!(button.left() - tab.left() >= px(24.));
    for fence in ["cancel", "selection", "generation", "boot"] {
        cx.simulate_mouse_down(button.center(), MouseButton::Left, Modifiers::default());
        cx.simulate_mouse_up(button.center(), MouseButton::Left, Modifiers::default());
        view.read_with(cx, |view, _| {
            assert!(view.menu.page == Some(Page::ConfirmClose));
            let close = view.menu.close.as_ref().unwrap();
            assert_eq!(close.tab, "inactive");
            assert!(!close.confirm_selected);
            assert_eq!(
                close.request(view.live.snapshot.as_ref().unwrap()).unwrap(),
                (Method::TabClose, json!({"tab_id": "inactive"}))
            );
            assert_eq!(
                view.live.snapshot.as_ref().unwrap().focused_tab_id,
                original_focus
            );
            assert!(view.pending_navigation.is_none());
        });
        if fence != "cancel" {
            cx.update(|window, cx| {
                view.update(cx, |view, cx| {
                    match fence {
                        "selection" => view.selection_epoch += 1,
                        "generation" => view.endpoints[0].generation += 1,
                        _ => {
                            let snapshot = Arc::make_mut(view.live.snapshot.as_mut().unwrap());
                            snapshot.boot_id.push_str("-new");
                            assert!(view.menu.close.as_ref().unwrap().request(snapshot).is_err());
                        }
                    }
                    view.confirm_close(window, cx);
                    assert!(view.menu.close.as_ref().unwrap().error.is_some());
                    assert!(view.pending_navigation.is_none());
                });
            });
        }
        cx.simulate_keystrokes("enter");
        assert!(view.read_with(cx, |view, _| view.menu.page.is_none()));
        cx.update(|window, cx| window.draw(cx).clear(cx));
    }
}

#[test]
fn only_a_working_or_blocked_agent_holds_a_tab_close() -> anyhow::Result<()> {
    let mut snapshot: ClientShellSnapshot = serde_json::from_str(include_str!(
        "../../../herdr-protocol/tests/fixtures/endpoint-snapshot-v1.json"
    ))?;
    let close = CloseConfirmation::capture_tab(&snapshot, "w1:t1")
        .ok_or_else(|| anyhow::anyhow!("missing tab"))?;
    use AgentStatus::*;
    for (tab, agent, expected) in [
        (Working, Idle, true),
        (Blocked, Idle, true),
        // A finished agent can outrank a working one in the tab's status.
        (Done, Working, true),
        (Idle, Blocked, true),
        (Idle, Idle, false),
        (Done, Done, false),
        (Unknown, Unknown, false),
    ] {
        snapshot.tabs[0].agent_status = tab;
        snapshot.agents[0].agent_status = agent;
        assert_eq!(
            close.interrupts_agent(&snapshot),
            expected,
            "{tab:?} {agent:?}"
        );
    }
    // A working agent in another tab does not hold this one.
    snapshot.agents[0].agent_status = Working;
    snapshot.agents[0].tab_id = "w1:t2".into();
    assert!(!close.interrupts_agent(&snapshot));
    snapshot.agents.clear();
    assert!(!close.interrupts_agent(&snapshot));
    Ok(())
}

#[gpui::test]
fn idle_tab_closes_without_asking_but_panes_still_ask(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = crate::sidebar::layout_tests::fixture_window(window, cx);
        let mut snapshot: ClientShellSnapshot = serde_json::from_str(include_str!(
            "../../../herdr-protocol/tests/fixtures/endpoint-snapshot-v1.json"
        ))
        .unwrap();
        snapshot.tabs[0].agent_status = AgentStatus::Idle;
        snapshot.agents[0].agent_status = AgentStatus::Done;
        view.live.snapshot = Some(Arc::new(snapshot));
        view
    });
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            assert!(view.config.confirm_close_tab);
            view.open_tab_close("w1:t1", window, cx);
            // The disconnected fixture attempts the close at once and refuses it.
            assert!(view.menu.close.as_ref().unwrap().error.is_some());
            view.dismiss_menu(window, cx);
            view.open_close_confirmation(Command::CloseTab, window, cx);
            assert!(view.menu.close.as_ref().unwrap().error.is_some());
            view.dismiss_menu(window, cx);
            view.open_close_confirmation(Command::ClosePane, window, cx);
            assert!(view.menu.close.as_ref().unwrap().error.is_none());
        })
    });
}

#[test]
fn explicit_pane_close_retains_inactive_target_and_membership() {
    let mut snapshot: ClientShellSnapshot = serde_json::from_str(include_str!(
        "../../../herdr-protocol/tests/fixtures/endpoint-snapshot-v1.json"
    ))
    .unwrap();
    let mut pane = snapshot.panes[0].clone();
    pane.pane_id = "inactive".into();
    snapshot.panes.push(pane);
    let close = CloseConfirmation::capture_pane(&snapshot, "inactive").unwrap();
    assert!(!close.confirm_selected);
    snapshot.focused_pane_id = None;
    assert_eq!(
        close.request(&snapshot).unwrap(),
        (Method::PaneClose, json!({"pane_id":"inactive"}))
    );
    let original = snapshot.clone();
    for case in 0..6 {
        let mut snapshot = original.clone();
        match case {
            0 => snapshot.boot_id.push('x'),
            1 => snapshot.workspaces.clear(),
            2 => snapshot.tabs.clear(),
            3 => snapshot.panes[1].tab_id.push('x'),
            4 => snapshot.panes[1].workspace_id.push('x'),
            _ => snapshot.panes.truncate(1),
        }
        assert!(matches!(
            close.request(&snapshot),
            Err(Error::StaleCloseTarget)
        ));
    }
}

#[test]
fn explicit_tab_close_does_not_follow_focus() -> anyhow::Result<()> {
    let mut snapshot: ClientShellSnapshot = serde_json::from_str(include_str!(
        "../../../herdr-protocol/tests/fixtures/endpoint-snapshot-v1.json"
    ))?;
    let mut inactive = snapshot.tabs[0].clone();
    inactive.tab_id = "inactive".into();
    inactive.focused = false;
    snapshot.tabs.push(inactive);
    let close = CloseConfirmation::capture_tab(&snapshot, "inactive")
        .ok_or_else(|| anyhow::anyhow!("missing tab"))?;
    assert!(!close.confirm_selected);
    assert_eq!(
        close.request(&snapshot)?,
        (Method::TabClose, json!({"tab_id":"inactive"}))
    );
    snapshot.tabs.retain(|tab| tab.tab_id != "inactive");
    assert!(close.request(&snapshot).is_err());
    Ok(())
}
#[test]
fn close_retains_original_target_and_rejects_replaced_sessions() -> anyhow::Result<()> {
    let mut snapshot: ClientShellSnapshot = serde_json::from_str(include_str!(
        "../../../herdr-protocol/tests/fixtures/endpoint-snapshot-v1.json"
    ))?;
    for command in [Command::ClosePane, Command::CloseTab] {
        let close = CloseConfirmation::capture(command, &snapshot)
            .ok_or_else(|| anyhow::anyhow!("missing target"))?;
        assert!(!close.confirm_selected, "Cancel is the safe default");
        let expected = close.request(&snapshot)?;
        let original = snapshot.clone();
        snapshot.focused_pane_id = None;
        snapshot.focused_tab_id = None;
        assert_eq!(close.request(&snapshot)?, expected);
        snapshot.boot_id = "new-boot".into();
        assert!(close.request(&snapshot).is_err());
        snapshot = original.clone();
        snapshot.tabs.clear();
        assert!(close.request(&snapshot).is_err());
        snapshot = original;
    }
    Ok(())
}
