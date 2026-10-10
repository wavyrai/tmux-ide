use super::*;

#[gpui::test]
fn multi_host_rows_scope_duplicate_ids_and_keep_agents_when_host_collapses(
    cx: &mut gpui::TestAppContext,
) {
    let (fixture, cx) = cx.add_window_view(|window, cx| {
        let view = cx.new(|cx| {
            let mut view = fixture_window(window, cx);
            view.live.snapshot = Some(Arc::new(snapshot(1)));
            let mut remote = crate::endpoint::Endpoint::new(
                "ssh:test".into(),
                "Remote".into(),
                ConnectTarget::Ssh {
                    target: "unused".into(),
                    session: "default".into(),
                },
                true,
            );
            remote.live.snapshot = view.live.snapshot.clone();
            let remote_snapshot = Arc::make_mut(remote.live.snapshot.as_mut().unwrap());
            remote_snapshot.workspaces[0].label = "remote workspace".into();
            remote_snapshot.workspaces[0].branch = Some("remote branch".into());
            view.endpoints.push(remote);
            view
        });
        cx.observe(&view, |_, _, cx| cx.notify()).detach();
        SidebarFixture(view)
    });
    cx.simulate_resize(size(px(800.), px(600.)));
    cx.run_until_parked();
    cx.update(|window, cx| {
        let _ = full_draw(window, cx);
    });
    for selector in [
        "host-local",
        "host-ssh:test",
        "workspace-local-w0",
        "workspace-ssh:test-w0",
        "agent-local-p0",
        "agent-ssh:test-p0",
        "github-herdr",
        "github-remote workspace",
    ] {
        assert!(cx.debug_bounds(selector).is_some(), "missing {selector}");
    }
    // Each host header ends in a status dot, never a status word.
    for (header, dot) in [
        ("host-local", "host-status-local"),
        ("host-ssh:test", "host-status-ssh:test"),
    ] {
        let header = cx.debug_bounds(header).unwrap();
        let dot = cx.debug_bounds(dot).unwrap();
        assert_eq!(
            dot.size,
            size(
                px(super::super::STATUS_WIDTH),
                px(super::super::STATUS_WIDTH)
            )
        );
        assert!(header.contains(&dot.center()));
    }
    cx.update(|_, cx| {
        for word in ["online", "connecting", "reconnecting"] {
            assert!(!cx.global::<TextProbes>().0.contains_key(word), "{word}");
        }
    });
    for (icon, title) in [
        ("github-herdr", "name-herdr"),
        ("github-remote workspace", "name-remote workspace"),
    ] {
        let icon = cx.debug_bounds(icon).unwrap();
        let title = cx.debug_bounds(title).unwrap();
        assert_eq!(icon.size, size(px(12.), px(12.)));
        assert_eq!(title.left(), icon.right() + px(6.));
        // Rows under a host header step in by the nest indent, which the
        // label gives up.
        let nest = super::super::layout::for_mode(crate::config::LayoutMode::from(
            crate::config::Density::Comfortable,
        ))
        .nest_indent();
        assert_eq!(
            title.size.width,
            px(super::super::LABEL_WIDTH - super::super::ICON_RESERVE - nest)
        );
    }
    fixture.update(cx, |fixture, cx| {
        fixture.0.update(cx, |view, cx| {
            view.endpoints[1].collapsed = true;
            cx.notify();
        });
    });
    cx.run_until_parked();
    cx.update(|window, cx| {
        cx.default_global::<TextProbes>().0.clear();
        window.refresh();
        let _ = full_draw(window, cx);
        // The remote workspace row folds away -- its branch goes with it -- while
        // its agent keeps naming the host it runs on.
        assert!(!cx.global::<TextProbes>().0.contains_key("remote branch"));
        for part in ["Remote", "remote workspace", "tab 1"] {
            assert!(
                cx.global::<TextProbes>().0.contains_key(part),
                "{part}: {:?}",
                cx.global::<TextProbes>().0.keys()
            );
        }
    });
    assert!(cx.debug_bounds("workspace-local-w0").is_some());
    assert!(cx.debug_bounds("agent-ssh:test-p0").is_some());
}

/// A second main checkout of the fixture repository stays a top-level parent
/// in every row layout and on every host: both parents lead the group, each
/// with its own fold arrow, ahead of the linked worktrees.
#[gpui::test]
fn duplicate_repository_parents_lead_one_group_in_every_layout_and_host(
    cx: &mut gpui::TestAppContext,
) {
    for mode in crate::config::LayoutMode::ALL {
        let (_view, cx) = cx.add_window_view(|window, cx| {
            let mut view = fixture_window(window, cx);
            view.config.layout.mode = mode;
            let mut local = snapshot(7);
            let mut duplicate = local.workspaces[3].clone();
            duplicate.workspace_id = "w7".into();
            duplicate.label = "agent-launcher-copy".into();
            duplicate.focused = false;
            local.workspaces.push(duplicate);
            let mut remote = crate::endpoint::Endpoint::new(
                "ssh:test".into(),
                "Remote".into(),
                ConnectTarget::Ssh {
                    target: "unused".into(),
                    session: "default".into(),
                },
                true,
            );
            remote.live.snapshot = Some(Arc::new(local.clone()));
            view.live.snapshot = Some(Arc::new(local));
            view.endpoints.push(remote);
            view
        });
        cx.simulate_resize(size(px(800.), px(1600.)));
        cx.run_until_parked();
        cx.update(|window, cx| full_draw(window, cx).clear(cx));
        // Debug selectors must be static, so each host's rows are spelled out.
        for (host, rows) in [
            (
                "local",
                [
                    "workspace-local-w3",
                    "workspace-local-w7",
                    "workspace-local-w4",
                    "workspace-local-w5",
                    "workspace-local-w6",
                ],
            ),
            (
                "ssh:test",
                [
                    "workspace-ssh:test-w3",
                    "workspace-ssh:test-w7",
                    "workspace-ssh:test-w4",
                    "workspace-ssh:test-w5",
                    "workspace-ssh:test-w6",
                ],
            ),
        ] {
            let order = rows.map(|row| {
                cx.debug_bounds(row)
                    .unwrap_or_else(|| panic!("{mode:?} {host}: missing {row}"))
                    .top()
            });
            assert!(
                order.windows(2).all(|pair| pair[0] < pair[1]),
                "{mode:?} {host}: {order:?}"
            );
        }
        for arrow in ["collapse-3", "collapse-7"] {
            assert!(
                cx.debug_bounds(arrow).is_some(),
                "{mode:?}: missing {arrow}"
            );
        }
    }
}
