use super::*;

#[gpui::test]
fn agent_icons_follow_names_and_reserve_narrow_label_width(cx: &mut gpui::TestAppContext) {
    use crate::config::{Density, LayoutMode, Style};
    let label = "Custom agent name with a deliberately long label";
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = fixture_window(window, cx);
        let mut snapshot = snapshot(6);
        for agent in &mut snapshot.agents {
            agent.display_agent = Some(label.into());
        }
        snapshot.agents[1].workspace_id = "missing-workspace".into();
        view.live.snapshot = Some(Arc::new(snapshot));
        view
    });
    cx.simulate_resize(size(px(800.), px(900.)));
    cx.run_until_parked();
    for mode in [Density::Compact, Density::Normal, Density::Comfortable]
        .into_iter()
        .flat_map(|density| {
            [Style::Flat, Style::Rounded].map(|style| LayoutMode::new(density, style))
        })
    {
        for width in [160., 232., 480.] {
            for identity in [
                Some("opencode"),
                Some("claude"),
                Some("codex"),
                Some("gemini"),
                Some("cursor"),
                Some("copilot"),
                Some("unknown"),
                None,
            ] {
                view.update(cx, |view, cx| {
                    view.config.layout.mode = mode;
                    view.sidebar_width = Some(width);
                    let snapshot = Arc::make_mut(view.live.snapshot.as_mut().unwrap());
                    for agent in &mut snapshot.agents {
                        agent.agent = identity.map(str::to_owned);
                    }
                    cx.notify();
                });
                cx.update(|window, cx| {
                    cx.default_global::<TextProbes>().0.clear();
                    full_draw(window, cx).clear(cx);
                    let (bounds, rendered, glyphs) = &cx.global::<TextProbes>().0[label];
                    assert!(*glyphs <= bounds.size.width);
                    if width == 160. {
                        assert!(rendered.ends_with('…'));
                    }
                });
                for (icon, name, column) in [
                    ("agent-icon-agent-p0", "detail-agent-p0", "column-agent-p0"),
                    ("agent-icon-agent-p1", "name-agent-p1", "column-agent-p1"),
                ] {
                    let icon = cx.debug_bounds(icon).unwrap();
                    let name = cx.debug_bounds(name).unwrap();
                    let column = cx.debug_bounds(column).unwrap();
                    assert_eq!(icon.size, size(px(12.), px(12.)));
                    assert_eq!(icon.left(), column.left());
                    assert_eq!(name.left(), icon.right() + px(4.));
                    assert_eq!(name.right(), column.right());
                    assert_eq!(icon.center().y, name.center().y);
                    assert!(icon.right() <= column.right());
                }
                let location = cx.debug_bounds("name-agent-p0").unwrap();
                let column = cx.debug_bounds("column-agent-p0").unwrap();
                assert_eq!(location.left(), column.left());
            }
        }
    }
}

/// The daemon's `state_text` token shows a status word beside each agent, in
/// every layout, and nothing at all when the daemon's rows do not ask for it.
/// An agent's own `rows_by_agent` entry decides for it instead of `rows`.
#[gpui::test]
fn agent_status_words_follow_the_daemon_sidebar_config(cx: &mut gpui::TestAppContext) {
    use crate::config::{Density, LayoutMode};
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = fixture_window(window, cx);
        view.live.snapshot = Some(Arc::new(snapshot(2)));
        view
    });
    cx.simulate_resize(size(px(800.), px(900.)));
    cx.run_until_parked();
    // The fixture's agents are Claude.
    let settings = [
        ("", false),
        ("rows = [[\"state_text\"]]", true),
        ("rows_by_agent.claude = [[\"state_text\"]]", true),
        (
            "rows = [[\"state_text\"]]\nrows_by_agent.claude = [[\"agent\"]]",
            false,
        ),
        ("rows_by_agent.codex = [[\"state_text\"]]", false),
    ];
    for mode in [
        LayoutMode::from(Density::Comfortable),
        LayoutMode::Superset,
        LayoutMode::Orca,
        LayoutMode::Minimal,
    ] {
        for (setting, shown) in &settings {
            view.update(cx, |view, cx| {
                view.config.layout.mode = mode;
                view.config.sidebar.size = 12.;
                view.sidebar_width = Some(320.);
                view.config.sidebar_layout.agents = toml::from_str(setting).unwrap();
                view.config.usage.inline = false;
                cx.notify();
            });
            let rendered = cx.update(|window, cx| {
                cx.default_global::<TextProbes>().0.clear();
                full_draw(window, cx).clear(cx);
                cx.global::<TextProbes>()
                    .0
                    .get("working")
                    .map(|(_, text, _)| text.clone())
            });
            assert_eq!(
                cx.debug_bounds("status-agent-p0").is_some(),
                *shown,
                "{mode:?} {setting:?}"
            );
            assert_eq!(
                rendered.as_deref(),
                shown.then_some("working"),
                "{mode:?} {setting:?}"
            );
        }
    }
}

/// An integration's `state_labels` replace the status word for the status
/// it names, in every layout, as the terminal client's sidebar does; agents
/// without one keep the plain word.
#[gpui::test]
fn agent_status_words_use_the_agents_state_labels(cx: &mut gpui::TestAppContext) {
    use crate::config::{Density, LayoutMode};
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = fixture_window(window, cx);
        let mut snapshot = snapshot(2);
        snapshot.agents[0].state_labels = vec![
            ("blocked".into(), "stuck".into()),
            ("working".into(), "deep in the mines".into()),
        ];
        view.live.snapshot = Some(Arc::new(snapshot));
        view
    });
    cx.simulate_resize(size(px(800.), px(900.)));
    cx.run_until_parked();
    for mode in [
        LayoutMode::from(Density::Comfortable),
        LayoutMode::Superset,
        LayoutMode::Orca,
        LayoutMode::Minimal,
    ] {
        view.update(cx, |view, cx| {
            view.config.layout.mode = mode;
            view.config.sidebar.size = 12.;
            view.sidebar_width = Some(320.);
            view.config.sidebar_layout.agents =
                toml::from_str("rows = [[\"state_text\"]]").unwrap();
            view.config.usage.inline = false;
            cx.notify();
        });
        let probes = cx.update(|window, cx| {
            cx.default_global::<TextProbes>().0.clear();
            full_draw(window, cx).clear(cx);
            let probes = &cx.global::<TextProbes>().0;
            ["deep in the mines", "stuck", "working"].map(|text| probes.contains_key(text))
        });
        // The second agent sets no labels, so it keeps the daemon's word.
        assert_eq!(probes, [true, false, true], "{mode:?}");
    }
}

/// A sidebar too narrow for the status word clips it within the row rather
/// than letting it paint past the row's edge onto the terminal.
#[gpui::test]
fn agent_status_words_stay_inside_narrow_rows(cx: &mut gpui::TestAppContext) {
    use crate::config::{Density, LayoutMode};
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = fixture_window(window, cx);
        view.live.snapshot = Some(Arc::new(snapshot(2)));
        view
    });
    cx.simulate_resize(size(px(800.), px(900.)));
    cx.run_until_parked();
    for density in [Density::Compact, Density::Normal, Density::Comfortable] {
        for (width, font) in [(160., 12.), (160., 36.), (160., 48.), (240., 48.)] {
            view.update(cx, |view, cx| {
                view.config.layout.mode = LayoutMode::from(density);
                view.config.sidebar.size = font;
                view.sidebar_width = Some(width);
                view.config.sidebar_layout.agents =
                    toml::from_str("rows = [[\"state_text\"]]").unwrap();
                view.config.usage.inline = false;
                cx.notify();
            });
            cx.update(|window, cx| {
                cx.default_global::<TextProbes>().0.clear();
                full_draw(window, cx).clear(cx);
            });
            let sidebar = cx.debug_bounds("sidebar").unwrap();
            for key in ["status-agent-p0", "status-agent-p1"] {
                let status = cx.debug_bounds(key).unwrap();
                assert!(
                    status.right() <= sidebar.right(),
                    "{density:?} {width} {font}: {key} {status:?} past {sidebar:?}"
                );
            }
        }
    }
}

#[gpui::test]
fn the_agents_header_toggles_between_grouped_and_priority(cx: &mut gpui::TestAppContext) {
    use crate::preferences::AgentSort;
    let (fixture, cx) = cx.add_window_view(|window, cx| {
        crate::bind_keys(cx);
        let view = cx.new(|cx| fixture_window(window, cx));
        cx.observe(&view, |_, _, cx| cx.notify()).detach();
        SidebarFixture(view)
    });
    let view = cx.update(|_, cx| fixture.read(cx).0.clone());
    // The second agent wants attention; only priority floats it to the top.
    cx.update(|_, cx| {
        view.update(cx, |view, _| {
            let snapshot = Arc::make_mut(view.live.snapshot.as_mut().unwrap());
            snapshot.agents[0].state_change_seq = 9;
            snapshot.agents[1].agent_status = AgentStatus::Blocked;
            snapshot.agents[1].state_change_seq = 1;
        })
    });
    cx.simulate_resize(size(px(800.), px(600.)));
    cx.run_until_parked();
    cx.update(|window, cx| full_draw(window, cx).clear(cx));
    let (first, second) = ("row-agent-p0", "row-agent-p1");
    let sort = cx.debug_bounds("agents-sort").unwrap();
    let header = cx.debug_bounds("sidebar").unwrap();
    // The label ends at the sidebar's inner edge, opposite the "agents" title.
    assert_eq!(sort.right(), header.right() - px(13.));
    for (expected, top) in [(AgentSort::Grouped, first), (AgentSort::Priority, second)] {
        cx.update(|_, cx| {
            assert_eq!(view.read(cx).agent_sort, expected);
            let probes = &cx.global::<TextProbes>().0;
            assert!(
                probes.contains_key(expected.to_string().as_str()),
                "{:?}",
                probes.keys()
            );
        });
        let (a, b) = (
            cx.debug_bounds(first).unwrap(),
            cx.debug_bounds(second).unwrap(),
        );
        let ordered = if top == first {
            a.top() < b.top()
        } else {
            b.top() < a.top()
        };
        assert!(ordered, "{expected:?}: {a:?} {b:?}");
        cx.simulate_click(sort.center(), Default::default());
        cx.update(|window, cx| {
            cx.default_global::<TextProbes>().0.clear();
            window.refresh();
            full_draw(window, cx).clear(cx);
        });
    }
    // Toggling twice returns to the stored default without a daemon request.
    cx.update(|_, cx| {
        let view = view.read(cx);
        assert_eq!(view.agent_sort, AgentSort::Grouped);
        assert!(view.agent_sort_modified);
    });
}

/// A plugin's agent view names the panel and decides its rows: the daemon's
/// `agent_order` replaces the local sort, agents it leaves out stay hidden,
/// and the local toggle neither shows nor changes while the view holds.
#[gpui::test]
fn a_plugin_agent_view_orders_and_filters_the_agents(cx: &mut gpui::TestAppContext) {
    use crate::preferences::AgentSort;
    let (fixture, cx) = cx.add_window_view(|window, cx| {
        crate::bind_keys(cx);
        let view = cx.new(|cx| fixture_window(window, cx));
        cx.observe(&view, |_, _, cx| cx.notify()).detach();
        SidebarFixture(view)
    });
    let view = cx.update(|_, cx| fixture.read(cx).0.clone());
    let set_view = |cx: &mut gpui::VisualTestContext, order: &[&str]| {
        let order = order.iter().map(|id| (*id).to_owned()).collect::<Vec<_>>();
        cx.update(|window, cx| {
            view.update(cx, |view, _| {
                let snapshot = Arc::make_mut(view.live.snapshot.as_mut().unwrap());
                snapshot.agent_view_label = Some("review".into());
                snapshot.agent_order = order;
            });
            cx.default_global::<TextProbes>().0.clear();
            window.refresh();
            full_draw(window, cx).clear(cx);
        });
    };
    cx.simulate_resize(size(px(800.), px(600.)));
    cx.run_until_parked();

    // Grouped would paint p0 first; the view puts p1 above it.
    set_view(cx, &["p1", "p0"]);
    let (first, second) = (
        cx.debug_bounds("row-agent-p1").unwrap(),
        cx.debug_bounds("row-agent-p0").unwrap(),
    );
    assert!(first.top() < second.top(), "{first:?} {second:?}");
    cx.update(|_, cx| {
        let probes = &cx.global::<TextProbes>().0;
        assert!(probes.contains_key("review"), "{:?}", probes.keys());
        assert!(!probes.contains_key("grouped"), "{:?}", probes.keys());
    });
    // The label is the plugin's, so clicking it must not flip the local sort.
    let sort = cx.debug_bounds("agents-sort").unwrap();
    cx.simulate_click(sort.center(), Default::default());
    cx.update(|_, cx| {
        let view = view.read(cx);
        assert_eq!(view.agent_sort, AgentSort::Grouped);
        assert!(!view.agent_sort_modified);
    });

    // An agent the view filtered out is not listed.
    set_view(cx, &["p1"]);
    assert!(cx.debug_bounds("row-agent-p1").is_some());
    assert!(cx.debug_bounds("row-agent-p0").is_none());

    // No match is the view's answer, not an absence of agents.
    set_view(cx, &[]);
    assert!(cx.debug_bounds("row-agent-p1").is_none());
    cx.update(|_, cx| {
        let probes = &cx.global::<TextProbes>().0;
        assert!(
            probes.contains_key("no matching agents"),
            "{:?}",
            probes.keys()
        );
    });
}

#[cfg(test)]
#[gpui::test]
fn hiding_agents_reclaims_sidebar_height(cx: &mut gpui::TestAppContext) {
    let (view, cx) = cx.add_window_view(fixture_window);
    for width in [800., 360.] {
        cx.simulate_resize(size(px(width), px(600.)));
        let mut visible_height = px(0.);
        for show_agents in [true, false, true] {
            cx.update(|window, cx| {
                view.update(cx, |view, cx| {
                    view.config.show_agents = show_agents;
                    cx.notify();
                });
                cx.default_global::<TextProbes>().0.clear();
                window.refresh();
                full_draw(window, cx).clear(cx);
            });
            cx.update(|_, cx| {
                assert_eq!(
                    cx.global::<TextProbes>().0.contains_key("Claude Code"),
                    show_agents
                );
            });
            let spaces = cx.debug_bounds("spaces-scroll").unwrap();
            if show_agents {
                visible_height = spaces.size.height;
            } else {
                assert!(spaces.size.height > visible_height + px(100.));
            }
            assert!(cx.debug_bounds("sidebar-menu").is_some());
            assert!(cx.debug_bounds("sidebar-resize").is_some());
        }
    }
}

#[cfg(test)]
#[gpui::test]
fn hiding_agents_preserves_scrolled_multi_endpoint_lists(cx: &mut gpui::TestAppContext) {
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = fixture_window(window, cx);
        let snapshot = Arc::make_mut(view.live.snapshot.as_mut().unwrap());
        snapshot.agents = (0..8)
            .map(|i| {
                let mut agent = snapshot.agents[0].clone();
                agent.pane_id = format!("p{i}");
                agent
            })
            .collect();
        let mut remote = crate::endpoint::Endpoint::new(
            "ssh:test".into(),
            "Remote".into(),
            ConnectTarget::Socket("/unused-remote-layout-test.sock".into()),
            true,
        );
        remote.live.snapshot = view.live.snapshot.clone();
        for agent in &mut Arc::make_mut(remote.live.snapshot.as_mut().unwrap()).agents {
            agent.display_agent = Some("Remote Agent".into());
        }
        view.endpoints.push(remote);
        view
    });
    for width in [800., 360.] {
        cx.simulate_resize(size(px(width), px(600.)));
        cx.update(|window, cx| {
            full_draw(window, cx).clear(cx);
            for scroll in &view.read(cx).sidebar_scroll {
                scroll.set_offset(point(px(0.), px(-40.)));
            }
            window.refresh();
            full_draw(window, cx).clear(cx);
        });
        let spaces_height = cx.debug_bounds("spaces-scroll").unwrap().size.height;
        for show_agents in [false, true] {
            cx.update(|window, cx| {
                view.update(cx, |view, cx| {
                    view.config.show_agents = show_agents;
                    cx.notify();
                });
                cx.default_global::<TextProbes>().0.clear();
                window.refresh();
                full_draw(window, cx).clear(cx);
                for label in ["Claude Code", "Remote Agent"] {
                    assert_eq!(
                        cx.global::<TextProbes>().0.contains_key(label),
                        show_agents,
                        "{label}"
                    );
                }
                let view = view.read(cx);
                for scroll in &view.sidebar_scroll {
                    assert_eq!(scroll.offset(), point(px(0.), px(-40.)));
                }
                assert_eq!(view.selected_endpoint, 0);
                assert_eq!(view.live.snapshot.as_ref().unwrap().agents.len(), 8);
                assert_eq!(
                    view.endpoints[1]
                        .live
                        .snapshot
                        .as_ref()
                        .unwrap()
                        .agents
                        .len(),
                    8
                );
            });
            let height = cx.debug_bounds("spaces-scroll").unwrap().size.height;
            if show_agents {
                assert_eq!(height, spaces_height);
                for selector in ["agent-local-p0", "agent-ssh:test-p0"] {
                    assert!(cx.debug_bounds(selector).is_some());
                }
            } else {
                assert!(height > spaces_height + px(100.));
            }
        }
    }
}
