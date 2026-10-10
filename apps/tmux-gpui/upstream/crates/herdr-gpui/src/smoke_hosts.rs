//! Native host routing, scoped repository, and decoy-window sidebar checks.
use super::*;

pub(super) async fn sidebar_hosts(
    handle: WindowHandle<HerdrWindow>,
    cx: &mut AsyncApp,
) -> Result<()> {
    use sidebar::{layout_tests::PaintedProbes, native_tests::Target};
    const REMOTE: &str = "Synthetic host with a deliberately long label";
    let decoy = cx
        .update(|cx| {
            cx.open_window(WindowOptions::default(), |window, cx| {
                cx.new(|cx| {
                    HerdrWindow::new(
                        ConnectTarget::Socket("/unused-decoy.sock".into()),
                        window,
                        cx,
                        true,
                    )
                })
            })
        })
        .context("opening decoy window")?;
    handle
        .update(cx, |view, window, cx| {
            view.endpoints.clear();
            for (index, label) in ["Local", REMOTE, "Disabled"].into_iter().enumerate() {
                let mut endpoint = endpoint::Endpoint::new(
                    if index == 0 {
                        endpoint::LOCAL.into()
                    } else {
                        format!("fixture-{index}")
                    },
                    label.into(),
                    ConnectTarget::Socket(format!("/unused-sidebar-{index}.sock").into()),
                    index != 2,
                );
                let mut snapshot = sidebar::layout_tests::snapshot(6);
                snapshot.workspaces.drain(0..3);
                snapshot.workspaces[0].label = format!("repository-{index}");
                snapshot.workspaces[1].custom_label = true;
                snapshot.workspaces[1].label = format!("child-{index}");
                snapshot.workspaces.truncate(2);
                snapshot.agents.truncate(1);
                // This fixture tests the name fallback, not the shared fixture's
                // higher-priority "Claude Code" display name.
                snapshot.agents[0].display_agent = None;
                snapshot.agents[0].name =
                    Some(format!("agent-{index}-with-a-deliberately-long-label"));
                endpoint.live.snapshot = Some(Arc::new(snapshot));
                if let Ok(mut inbox) = endpoint.connection.inbox.lock() {
                    *inbox = endpoint.live.clone();
                }
                view.endpoints.push(endpoint);
            }
            view.selected_endpoint = 0;
            view.live = view.endpoints[0].live.clone();
            view.collapsed_repos.clear();
            view.marked = "preserve collapse composition".into();
            window.resize(fixture_size(480., 780.));
            cx.notify();
        })
        .context("preparing sidebar host fixtures")?;
    cx.update(|cx| cx.activate(true));
    decoy
        .update(cx, |_, window, _| window.activate_window())
        .context("activating decoy window")?;
    // GPUI schedules AppKit activation. Wait for its result, not a guessed delay
    // followed by a synchronous makeKeyWindow call on a possibly unordered window.
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        let target = decoy
            .update(cx, |_, window, _| Target::acquire(window))
            .context("acquiring decoy target")??;
        let key = target.is_key();
        drop(target);
        let resized = handle
            .update(cx, |_, window, _| {
                window.viewport_size() == fixture_size(480., 780.)
            })
            .context("checking sidebar resize")?;
        if key && resized {
            break;
        }
        if Instant::now() >= deadline {
            let mtm = objc2::MainThreadMarker::new()
                .context("fixture activation requires main thread")?;
            let app = objc2_app_kit::NSApplication::sharedApplication(mtm);
            bail!(
                "decoy activation/resize deadline: key={key}, resized={resized}, app_active={}, app_hidden={}",
                app.isActive(),
                app.isHidden()
            );
        }
        cx.background_executor()
            .timer(Duration::from_millis(10))
            .await;
    }
    // The decoy is deliberately key. Neither acquisition nor delivery may use it.
    let target = decoy
        .update(cx, |_, window, _| Target::acquire(window))
        .context("acquiring decoy target")??;
    if !target.is_key() {
        bail!("decoy did not become key");
    }
    drop(target);
    let viewport = handle
        .update(cx, |_, window, _| window.viewport_size())
        .context("reading sidebar viewport")?;
    if viewport != fixture_size(480., 780.) {
        bail!("narrow resize not settled: {viewport:?}");
    }
    for (step, label, expected) in [
        (0, REMOTE, 0), // collapse unselected host
        (1, REMOTE, 0), // expand
        (2, REMOTE, 1),
        (3, "Local", 0),
        (4, "Disabled", 0),
        (5, "child-1", 1),
        (6, "child-0", 0),
        (7, "agent-1-with-a-deliberately-long-label", 1),
        (8, "agent-0-with-a-deliberately-long-label", 0),
        (9, "repository-1", 0),
    ] {
        let decoy_target = decoy
            .update(cx, |_, window, _| Target::acquire(window))
            .context("checking decoy target")??;
        if !decoy_target.is_key() {
            bail!("decoy lost key status at step {step}");
        }
        drop(decoy_target);
        let (target, point) = AnyWindowHandle::from(handle)
            .update(cx, |_, window, cx| -> Result<_> {
                cx.default_global::<PaintedProbes>().0.clear();
                window.refresh();
                window.draw(cx).clear(cx);
                let probes = &cx.global::<PaintedProbes>().0;
                for (name, prefix) in [
                    (REMOTE, "Synthetic host"),
                    ("agent-1-with-a-deliberately-long-label", "agent-1-with-a"),
                ] {
                    let p = probes
                        .get(name)
                        .with_context(|| format!("missing {name}"))?;
                    if p.clipped
                        || p.glyph_text != p.cached
                        || !p.glyph_text.ends_with('\u{2026}')
                        || !p.glyph_text.starts_with(prefix)
                        || p.bounds.size.width < px(110.)
                        || p.width > p.bounds.size.width
                    {
                        bail!("narrow native label: {name}: {p:?}");
                    }
                }
                let p = probes
                    .get(label)
                    .with_context(|| format!("missing target {label}"))?;
                let mut point = p.bounds.center();
                if step < 2 {
                    point.x =
                        p.bounds.left() - px(sidebar::HOST_GAP + sidebar::HOST_ARROW_WIDTH / 2.);
                }
                if step == 9 {
                    // The title ends at the label column's edge, even with an avatar.
                    point.x =
                        p.bounds.right() + px((sidebar::LABEL_GAP + sidebar::ARROW_RESERVE) / 2.);
                }
                Ok((Target::acquire(window)?, point))
            })
            .context("locating sidebar host click target")??;
        target.click(point.x.to_f64(), point.y.to_f64())?;
        drop(target);
        AnyWindowHandle::from(handle)
            .update(cx, |root, window, cx| -> Result<()> {
                cx.default_global::<PaintedProbes>().0.clear();
                window.refresh();
                window.draw(cx).clear(cx);
                let entity = root
                    .downcast::<HerdrWindow>()
                    .map_err(|_| anyhow!("unexpected root"))?;
                let view = entity.read(cx);
                if view.selected_endpoint != expected {
                    bail!(
                        "step {step}: selected {} expected {expected}",
                        view.selected_endpoint
                    );
                }
                if step < 2
                    && (view.endpoints[1].collapsed != (step == 0)
                        || view.marked != "preserve collapse composition")
                {
                    bail!("host collapse changed selection/composition");
                }
                if (5..=8).contains(&step) {
                    let expected = if step < 7 {
                        NavigationTarget::Workspace("w4".to_owned())
                    } else {
                        NavigationTarget::Pane("p0".to_owned())
                    };
                    if view.pending_navigation.as_ref() != Some(&expected) {
                        bail!("wrong duplicate-ID route at step {step}");
                    }
                }
                if step == 9
                    && (!view.endpoints[1]
                        .collapsed_repos
                        .contains("/fixture/agent-launcher/.git")
                        || !view.collapsed_repos.is_empty())
                {
                    bail!("repository collapse escaped endpoint scope");
                }
                let probes = &cx.global::<PaintedProbes>().0;
                if step == 0
                    && (probes.contains_key("child-1")
                        || !probes.contains_key("agent-1-with-a-deliberately-long-label"))
                {
                    bail!("host collapse hid agents or left workspace visible");
                }
                if step == 9 && (probes.contains_key("child-1") || !probes.contains_key("child-0"))
                {
                    bail!("repository visibility not scoped");
                }
                Ok(())
            })
            .context("verifying sidebar host interaction")??;
        eprintln!("SIDEBAR native host step={step} verified");
    }
    // Exercise wider, narrower, then restored native allocations. This catches
    // stale truncated font runs as well as host labels left at the default width.
    // Host and agent labels each reserve 57px in the comfortable flat layout:
    // hosts use border + padding + arrow + two gaps + status; agents use their icon.
    for (window_width, preferred, host_width, agent_width, host_prefix, agent_prefix) in [
        (
            800.,
            Some(400.),
            343.,
            343.,
            "Synthetic host",
            "agent-1-with-a",
        ),
        (360., None, 63., 63., "Synthe", "agent-1"),
        (
            800.,
            Some(160.),
            103.,
            103.,
            "Synthetic",
            "agent-1-with\u{2026}",
        ),
        (
            800.,
            Some(480.),
            423.,
            423.,
            REMOTE,
            "agent-1-with-a-deliberately-long-label",
        ),
        (480., None, 175., 175., "Synthetic host", "agent-1-with-a"),
    ] {
        handle
            .update(cx, |view, window, cx| {
                view.sidebar_width = preferred;
                window.resize(fixture_size(window_width, 780.));
                cx.notify();
            })
            .context("resizing sidebar fixture")?;
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            let settled = AnyWindowHandle::from(handle)
            .update(cx, |_, window, cx| -> Result<bool> {
                if window.viewport_size() != fixture_size(window_width, 780.) {
                    return Ok(false);
                }
                cx.default_global::<PaintedProbes>().0.clear();
                window.refresh();
                window.draw(cx).clear(cx);
                for (name, prefix, expected_width) in [
                    (REMOTE, host_prefix, host_width),
                    ("agent-1-with-a-deliberately-long-label", agent_prefix, agent_width),
                ] {
                    let p = cx
                        .global::<PaintedProbes>()
                        .0
                        .get(name)
                        .context("missing narrow label")?;
                    if p.clipped
                        || p.glyph_text != p.cached
                        || (p.glyph_text != name && !p.glyph_text.ends_with('\u{2026}'))
                        || !p.glyph_text.starts_with(prefix)
                        || p.bounds.size.width != px(expected_width)
                        || p.mask.size.width != px(expected_width)
                        || p.width > p.bounds.size.width
                    {
                        bail!("resized native label window={window_width} preferred={preferred:?}: {p:?}");
                    }
                }
                Ok(true)
            })
            .context("verifying resized sidebar labels")??;
            if settled {
                break;
            }
            if Instant::now() >= deadline {
                bail!("{window_width}px resize timed out");
            }
            cx.background_executor()
                .timer(Duration::from_millis(16))
                .await;
        }
        eprintln!(
            "SIDEBAR native resized labels verified: window={window_width} preferred={preferred:?} host={host_width} agent={agent_width}"
        );
    }
    for font_size in [16., 20., 12.] {
        AnyWindowHandle::from(handle)
            .update(cx, |root, window, cx| -> Result<()> {
                let entity = root
                    .downcast::<HerdrWindow>()
                    .map_err(|_| anyhow!("unexpected root"))?;
                entity.update(cx, |view, _| -> Result<()> {
                    view.config.sidebar.size = font_size;
                    view.config.theme = if font_size == 12. { "Default" } else { "Nord" }.into();
                    view.theme = view.config.theme(false)?;
                    Ok(())
                })?;
                cx.default_global::<PaintedProbes>().0.clear();
                window.refresh();
                window.draw(cx).clear(cx);
                for name in [REMOTE, "agent-1-with-a-deliberately-long-label"] {
                    let probe = cx
                        .global::<PaintedProbes>()
                        .0
                        .get(name)
                        .context("missing scaled label")?;
                    if probe.clipped
                        || probe.glyph_text != probe.cached
                        || !probe.glyph_text.ends_with('\u{2026}')
                        || probe.width > probe.bounds.size.width
                        // Native layout snaps fractional line heights to device pixels.
                        || (probe.bounds.size.height - px(font_size * 4. / 3.)).abs()
                            > px(1. / window.scale_factor())
                    {
                        bail!("scaled native label size={font_size}: {probe:?}");
                    }
                }
                eprintln!("SIDEBAR native themed font labels verified: size={font_size}");
                Ok(())
            })
            .context("verifying scaled sidebar labels")??;
    }
    handle
        .update(cx, |view, _, cx| -> Result<()> {
            let snapshot = Arc::make_mut(
                view.live
                    .snapshot
                    .as_mut()
                    .context("missing scroll snapshot")?,
            );
            let agent = snapshot.agents[0].clone();
            let workspace = snapshot.workspaces[0].clone();
            for index in 0..40 {
                let mut agent = agent.clone();
                agent.pane_id = format!("scroll-p{index}");
                snapshot.agents.push(agent);
                let mut workspace = workspace.clone();
                workspace.workspace_id = format!("scroll-w{index}");
                workspace.worktree = None;
                snapshot.workspaces.push(workspace);
            }
            cx.notify();
            Ok(())
        })
        .context("preparing sidebar scroll fixture")??;
    for list in 0..2 {
        AnyWindowHandle::from(handle)
            .update(cx, |root, window, cx| -> Result<()> {
                window.refresh();
                window.draw(cx).clear(cx);
                let entity = root
                    .downcast::<HerdrWindow>()
                    .map_err(|_| anyhow!("unexpected root"))?;
                let scroll = entity.read(cx).sidebar_scroll.clone();
                let other = scroll[1 - list].offset();
                scroll[list].set_offset(point(px(0.), px(-80.)));
                window.refresh();
                window.draw(cx).clear(cx);
                if scroll[list].offset().y != px(-80.) || scroll[1 - list].offset() != other {
                    bail!("scroll handles are not independent: list={list}");
                }
                Ok(())
            })
            .context("verifying independent sidebar scrolling")??;
    }
    decoy
        .update(cx, |view, window, _| -> Result<()> {
            if view.selected_endpoint != 0
                || !view.collapsed_repos.is_empty()
                || view.menu.page.is_some()
                || view.pending_navigation.is_some()
                || view.selection_epoch != 0
            {
                bail!("fixture click affected decoy");
            }
            window.remove_window();
            Ok(())
        })
        .context("verifying and closing decoy window")??;
    Ok(())
}
