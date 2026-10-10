#![allow(clippy::unwrap_used)]

use super::*;
use crate::{
    config::LayoutMode,
    herdr_settings::Settings,
    sidebar::layout_tests::{SidebarFixture, fixture_window, full_draw, snapshot},
};
use core::prelude::v1::test;
use gpui::{Modifiers, TestAppContext, VisualTestContext, size};
use herdr_client::ConnectTarget;
use std::sync::Arc;

fn rail_window(
    cx: &mut TestAppContext,
    hosts: usize,
) -> (Entity<HerdrWindow>, &mut VisualTestContext) {
    let (fixture, cx) = cx.add_window_view(move |window, cx| {
        let view = cx.new(|cx| {
            let mut view = fixture_window(window, cx);
            view.live.snapshot = Some(Arc::new(snapshot(6)));
            view.endpoints[0].live = view.live.clone();
            for host in 1..hosts {
                let mut remote = crate::endpoint::Endpoint::new(
                    format!("ssh:host{host}"),
                    format!("build{host}"),
                    ConnectTarget::Ssh {
                        target: "unused".into(),
                        session: "default".into(),
                    },
                    true,
                );
                remote.live.snapshot = Some(Arc::new(snapshot(2)));
                view.endpoints.push(remote);
            }
            view.sidebar_visible = false;
            view
        });
        cx.observe(&view, |_, _, cx| cx.notify()).detach();
        SidebarFixture(view)
    });
    let view = cx.update(|_, cx| fixture.read(cx).0.clone());
    cx.simulate_resize(size(px(900.), px(600.)));
    cx.run_until_parked();
    cx.update(|window, cx| full_draw(window, cx).clear(cx));
    (view, cx)
}

fn set_shared(view: &Entity<HerdrWindow>, text: &str, cx: &mut VisualTestContext) {
    view.update(cx, |view, cx| {
        view.settings.shared = Some(Settings::parse_text(text).unwrap());
        cx.notify();
    });
    cx.update(|window, cx| full_draw(window, cx).clear(cx));
}

#[gpui::test]
fn collapsed_sidebar_is_a_rail_in_every_layout_that_navigates(cx: &mut TestAppContext) {
    let (view, cx) = rail_window(cx, 1);
    for mode in LayoutMode::ALL {
        view.update(cx, |view, cx| {
            view.config.layout.mode = mode;
            view.pending_navigation = None;
            cx.notify();
        });
        cx.update(|window, cx| full_draw(window, cx).clear(cx));
        assert!(cx.debug_bounds("sidebar").is_none(), "{mode:?}");
        let rail = cx.debug_bounds("sidebar-rail").unwrap();
        assert_eq!(rail.size.width, px(RAIL_WIDTH), "{mode:?}");
        let terminal = cx.debug_bounds("terminal").unwrap();
        assert!(terminal.left() >= rail.right(), "{mode:?}");
        // Every workspace, and every agent, keeps a mark inside the rail.
        for selector in [
            "rail-workspace-local-w0",
            "rail-workspace-local-w5",
            "rail-agent-local-p0",
            "rail-agent-local-p1",
            "rail-new-workspace",
        ] {
            let mark = cx.debug_bounds(selector).unwrap_or_else(|| {
                panic!("{mode:?}: missing {selector}");
            });
            assert!(
                mark.left() >= rail.left() && mark.right() <= rail.right(),
                "{mode:?} {selector}: {mark:?} outside {rail:?}"
            );
        }
        // No host header for a single host.
        assert!(cx.debug_bounds("rail-host-local").is_none());
        let workspace = cx.debug_bounds("rail-workspace-local-w3").unwrap();
        cx.simulate_click(workspace.center(), Modifiers::default());
        view.read_with(cx, |view, _| {
            assert_eq!(
                view.pending_navigation,
                Some(NavigationTarget::Workspace("w3".into())),
                "{mode:?}"
            );
        });
        cx.update(|window, cx| full_draw(window, cx).clear(cx));
        let agent = cx.debug_bounds("rail-agent-local-p1").unwrap();
        cx.simulate_click(agent.center(), Modifiers::default());
        view.read_with(cx, |view, _| {
            assert_eq!(
                view.pending_navigation,
                Some(NavigationTarget::Pane("p1".into())),
                "{mode:?}"
            );
            assert!(!view.sidebar_visible);
        });
    }
    // The rail has no expand control of its own; the one sidebar toggle,
    // leading the tab row, expands the sidebar again.
    assert!(cx.debug_bounds("rail-expand").is_none());
    let expand = cx.debug_bounds("toggle-sidebar").unwrap();
    assert!(expand.left() >= cx.debug_bounds("sidebar-rail").unwrap().right());
    cx.simulate_click(expand.center(), Modifiers::default());
    cx.update(|window, cx| full_draw(window, cx).clear(cx));
    assert!(view.read_with(cx, |view, _| view.sidebar_visible));
    assert!(cx.debug_bounds("sidebar").is_some());
    assert!(cx.debug_bounds("sidebar-rail").is_none());
}

#[gpui::test]
fn rail_follows_shared_collapsed_mode(cx: &mut TestAppContext) {
    let (view, cx) = rail_window(cx, 1);
    let rail_right = cx.debug_bounds("sidebar-rail").unwrap().right();
    set_shared(&view, "[ui]\nsidebar_collapsed_mode = 'hidden'\n", cx);
    assert!(cx.debug_bounds("sidebar-rail").is_none());
    assert!(cx.debug_bounds("sidebar").is_none());
    // Hidden gives the rail's room and the sidebar gap back to the terminal.
    let terminal = cx.debug_bounds("terminal").unwrap();
    assert!(terminal.left() < rail_right);
    set_shared(&view, "[ui]\nsidebar_collapsed_mode = 'compact'\n", cx);
    assert!(cx.debug_bounds("sidebar-rail").is_some());
    // Expanding ignores the collapsed mode.
    view.update(cx, |view, cx| {
        view.toggle_sidebar();
        cx.notify();
    });
    cx.update(|window, cx| full_draw(window, cx).clear(cx));
    assert!(cx.debug_bounds("sidebar").is_some());
}

#[gpui::test]
fn rail_shows_a_header_per_host_and_skips_collapsed_hosts(cx: &mut TestAppContext) {
    let (view, cx) = rail_window(cx, 3);
    let rail = cx.debug_bounds("sidebar-rail").unwrap();
    for selector in [
        "rail-host-local",
        "rail-host-ssh:host1",
        "rail-host-ssh:host2",
        "rail-host-status-ssh:host1",
        "rail-workspace-local-w0",
        "rail-workspace-ssh:host1-w0",
        "rail-workspace-ssh:host2-w1",
        "rail-agent-ssh:host2-p0",
    ] {
        let mark = cx
            .debug_bounds(selector)
            .unwrap_or_else(|| panic!("missing {selector}"));
        assert!(mark.right() <= rail.right(), "{selector}");
    }
    // Hosts list in order, each above its own workspaces.
    let first = cx.debug_bounds("rail-host-ssh:host1").unwrap().top();
    let second = cx.debug_bounds("rail-host-ssh:host2").unwrap().top();
    let workspace = cx.debug_bounds("rail-workspace-ssh:host1-w1").unwrap();
    assert!(first < workspace.top() && workspace.top() < second);
    view.update(cx, |view, cx| {
        view.endpoints[1].collapsed = true;
        cx.notify();
    });
    cx.update(|window, cx| full_draw(window, cx).clear(cx));
    assert!(cx.debug_bounds("rail-host-ssh:host1").is_some());
    assert!(cx.debug_bounds("rail-workspace-ssh:host1-w0").is_none());
    assert!(cx.debug_bounds("rail-agent-ssh:host1-p0").is_none());
    assert!(cx.debug_bounds("rail-workspace-ssh:host2-w0").is_some());
    // A host header selects its host, as the expanded header does, even
    // while its rows are folded away.
    let host = cx.debug_bounds("rail-host-ssh:host1").unwrap();
    cx.simulate_click(host.center(), Modifiers::default());
    view.read_with(cx, |view, _| {
        assert_eq!(view.endpoints[view.selected_endpoint].id, "ssh:host1");
    });
}

#[gpui::test]
fn narrow_windows_keep_the_terminal_reserve(cx: &mut TestAppContext) {
    let (_, cx) = rail_window(cx, 2);
    for (width, rail) in [(900., RAIL_WIDTH), (270., 30.), (200., 0.)] {
        cx.simulate_resize(size(px(width), px(400.)));
        cx.update(|window, cx| full_draw(window, cx).clear(cx));
        assert_eq!(
            cx.debug_bounds("sidebar-rail")
                .map_or(px(0.), |bounds| bounds.size.width),
            px(rail),
            "{width}"
        );
    }
}

#[gpui::test]
fn start_collapsed_applies_once_and_yields_to_an_earlier_toggle(cx: &mut TestAppContext) {
    let (view, cx) = rail_window(cx, 1);
    let collapsed = Settings::parse_text("[ui]\nsidebar_start_collapsed = true\n").unwrap();
    view.update(cx, |view, _| {
        // A fresh window stays expanded until the first shared load.
        view.sidebar_visible = true;
        view.sidebar_start_pending = true;
        view.settings.shared = Some(Settings::parse_text("").unwrap());
        view.apply_sidebar_start();
        assert!(view.sidebar_visible);
        // Only the first load counts; a later edit waits for a restart.
        view.settings.shared = Some(collapsed.clone());
        view.apply_sidebar_start();
        assert!(view.sidebar_visible);

        view.sidebar_start_pending = true;
        view.apply_sidebar_start();
        assert!(!view.sidebar_visible);
        // Expanding afterwards sticks across reloads.
        view.toggle_sidebar();
        view.apply_sidebar_start();
        assert!(view.sidebar_visible);

        // Toggling before the settings arrive keeps the user's choice.
        view.sidebar_start_pending = true;
        view.toggle_sidebar();
        view.toggle_sidebar();
        view.apply_sidebar_start();
        assert!(view.sidebar_visible);
    });
}

#[test]
fn tooltips_name_host_place_and_status() {
    assert_eq!(
        describe(
            Some("build"),
            "review",
            Some("herdr / tab 2"),
            status_word(AgentStatus::Blocked)
        ),
        "build: review in herdr / tab 2 (blocked)"
    );
    assert_eq!(
        describe(None, "herdr", None, status_word(AgentStatus::Unknown)),
        "herdr"
    );
    let mut snapshot = snapshot(1);
    let agent = &mut snapshot.agents[0];
    assert_eq!(agent_status_word(agent).as_deref(), Some("working"));
    agent.state_labels = vec![("working".into(), "deep in the mines".into())];
    assert_eq!(
        agent_status_word(agent).as_deref(),
        Some("deep in the mines")
    );
    agent.agent_status = AgentStatus::Unknown;
    assert_eq!(agent_status_word(agent), None);
    agent.state_labels = vec![("unknown".into(), "resting".into())];
    assert_eq!(agent_status_word(agent).as_deref(), Some("resting"));
    assert_eq!(host_initial("  ssh box"), "S");
    assert_eq!(host_initial(""), "?");
    assert_eq!(host_initial("éclair"), "É");
}
