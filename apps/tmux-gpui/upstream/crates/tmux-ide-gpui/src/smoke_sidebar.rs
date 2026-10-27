//! Daemon-free sidebar fixture driver.
use super::*;

/// Native check that the icon cascade reaches an installed Nerd Font. Prompts
/// draw powerline separators and icons from the Private Use Area, which no text
/// face and no platform default cascade covers, so without the cascade every
/// such cell shapes to the platform's missing-glyph box. Headless shaping
/// cannot show this: the test text system reports no installed families and
/// gives every glyph the same fixed advance.
fn symbol_cascade(window: &mut Window, cx: &mut App) -> Result<&'static str> {
    let detected = crate::config::symbol_fallbacks(cx.text_system().all_font_names());
    if detected.is_empty() {
        // An installed icon font is an external resource, like a daemon binary.
        return Ok("symbol cascade skipped (no Nerd Font installed)");
    }
    let font = crate::config::FontConfig {
        family: "Menlo".into(),
        size: crate::terminal::FONT_SIZE,
        fallbacks: Some(detected.clone()),
        line_height_multiple: None,
    }
    .font();
    // Fallback faces never enter `get_font_for_id`, and a cascade gives the
    // same family a new font id, so coverage is read from the glyphs: anything
    // no font carries shapes to the platform's missing-glyph box, and a covered
    // codepoint must not land on that same glyph.
    let glyphs = |symbol: &str, window: &mut Window| {
        window
            .text_system()
            .shape_line(
                symbol.to_owned().into(),
                px(crate::terminal::FONT_SIZE),
                &[TextRun {
                    len: symbol.len(),
                    font: font.clone(),
                    color: rgb(0xffffff).into(),
                    background_color: None,
                    underline: None,
                    strikethrough: None,
                }],
                None,
            )
            .runs
            .iter()
            .flat_map(|run| run.glyphs.iter().map(|glyph| glyph.id))
            .collect::<Vec<_>>()
    };
    // Plane 15 is private and unassigned by every shipped font, including the
    // Nerd Font patches, so it names the missing-glyph box for this machine.
    let missing = glyphs("\u{f0000}", window);
    if missing.is_empty() {
        bail!("no missing-glyph baseline to compare icons against");
    }
    // A separator, a branch and a clock: three prompt icons from three ranges.
    for symbol in ["\u{e0b0}", "\u{e0a0}", "\u{f017}"] {
        if glyphs(symbol, window) == missing {
            bail!("icon {symbol:?} stayed a missing-glyph box under cascade {detected:?}");
        }
    }
    if glyphs("A", window) == missing {
        bail!("cascade lost the configured face for plain text");
    }
    Ok("symbol cascade reaches installed Nerd Fonts")
}

pub fn start_sidebar(handle: WindowHandle<HerdrWindow>, cx: &mut App) {
    #[cfg(target_os = "linux")]
    if let Ok(field) = std::env::var("HERDR_TEST_INPUT_SHUTDOWN") {
        input_shutdown::start(handle, field, cx);
        return;
    }
    if std::env::var_os("HERDR_TEST_NOTIFICATIONS_ONLY").is_some() {
        start_notifications(handle, cx);
        return;
    }
    EXIT_CODE.store(1, Ordering::SeqCst);
    // AppKit may exit(0) inside cx.quit(), bypassing main's ExitCode. These
    // daemon-free fixtures exit explicitly, like the performance driver.
    #[cfg(target_os = "macos")]
    if let Err(error) = app_icon::verify_native().and_then(|()| crate::app_badge::verify_native()) {
        eprintln!("ICON native FAIL: {error:#}");
        std::process::exit(1);
    }
    cx.set_global(sidebar::layout_tests::PaintedProbes::default());
    cx.set_global(sidebar::layout_tests::VerifyChildGeometry(true));
    if std::env::var_os("HERDR_TEST_SIDEBAR_PROBE_FAILURE").is_some() {
        let _ = handle.update(cx, |view, _, cx| {
            // Exercise the real native paint failure path with a column that
            // intentionally violates the fixed-width initial fixture.
            view.sidebar_width = Some(180.);
            cx.notify();
        });
    }
    let timer = cx.background_executor().clone();
    cx.spawn(async move |cx| {
        // Shaping first: the cascade is independent of every layout probe below.
        let cascade = match handle.update(cx, |_, window, cx| symbol_cascade(window, cx)) {
            Ok(Ok(summary)) => summary,
            other => {
                eprintln!("SIDEBAR native symbol cascade FAIL: {other:?}");
                std::process::exit(1);
            }
        };
        eprintln!("SIDEBAR native symbol cascade: {cascade}");
        #[cfg(target_os = "macos")]
        if let Err(error) = sidebar_preferences(handle, cx).await {
            eprintln!("SIDEBAR native preferences FAIL: {error:#}");
            cx.update(|cx| cx.quit());
            return;
        }
        for frame in 0..72 {
            timer.timer(Duration::from_millis(100)).await;
            let result = AnyWindowHandle::from(handle).update(
                cx,
                |root, window, cx| -> Result<()> {
                    use crate::sidebar::layout_tests::PaintedProbes;
                    let (w, h) =
                        [(1200., 780.), (640., 400.), (1000., 650.), (800., 600.)][(frame % 12) / 3];
                    // Retain the glyph fixture's list viewport while reserving
                    // the fixed device footer below both scrollable sections.
                    use crate::config::{Density, LayoutMode, Style};
                    let density = [Density::Comfortable, Density::Normal, Density::Compact][frame / 12 % 3];
                    let style = [Style::Flat, Style::Rounded][frame / 36];
                    // Rounded rows are taller; grow both sections so the probed
                    // rows stay inside their lists at the smallest size too.
                    let h = h
                        + sidebar::DEVICE_FOOTER_HEIGHT
                        + if style == Style::Rounded { 160. } else { 0. };
                    let mode = LayoutMode::new(density, style);
                    let compact = density == Density::Compact;
                    if frame % 3 == 0 {
                        window.resize(fixture_size(w, h));
                    } else if window.viewport_size() != fixture_size(w, h) {
                        bail!(
                            "native resize did not settle: {:?}",
                            window.viewport_size()
                        );
                    }
                    cx.default_global::<PaintedProbes>().0.clear();
                    root.downcast::<HerdrWindow>()
                        .map_err(|_| anyhow!("unexpected root"))?
                        .update(cx, |view, cx| {
                            view.config.layout.mode = mode;
                            cx.notify();
                        });
                    window.refresh();
                    window.draw(cx).clear(cx);
                    cx.default_global::<PaintedProbes>().check()?;
                    let probes = &cx.global::<PaintedProbes>().0;
                    let mut failed = false;
                    for input in [
                        "herdr",
                        "main",
                        "Claude Code",
                        "agent",
                        "1256789",
                        "herdr-gpui-sidebar-rendering-regression-investigation",
                        "fix/sidebar-label-width-and-overflow-regression",
                    ] {
                        if compact && matches!(input, "main" | "1256789" | "fix/sidebar-label-width-and-overflow-regression") {
                            if probes.contains_key(input) {
                                bail!("compact layout painted branch: {input}");
                            }
                            continue;
                        }
                        let p = probes
                            .get(input)
                            .with_context(|| format!("missing paint: {input}"))?;
                        if frame == 0 {
                            eprintln!("SIDEBAR frame={frame} input={input:?} {p:?}");
                        }
                        let expected_short = input.len() < 20;
                        let title_icon = matches!(input, "herdr" | "herdr-gpui-sidebar-rendering-regression-investigation");
                        // Rounded rows give up the highlight's inset, the
                        // density's gap, on both edges.
                        let extra_width = match density {
                            Density::Comfortable => 0.,
                            Density::Normal => 10.,
                            Density::Compact => 16.,
                        } - match (style, density) {
                            (Style::Flat, _) => 0.,
                            (Style::Rounded, Density::Comfortable) => 16.,
                            (Style::Rounded, Density::Normal) => 12.,
                            (Style::Rounded, Density::Compact) => 8.,
                        };
                        let icon_reserve = if title_icon {
                            sidebar::ICON_RESERVE
                        } else if matches!(input, "Claude Code" | "agent") {
                            16. // 12px agent mark and 4px gap before its name.
                        } else {
                            0.
                        };
                        let expected_width = px(sidebar::LABEL_WIDTH + extra_width - icon_reserve);
                        if p.glyph_text != p.cached
                            || (expected_short && p.glyph_text != input)
                            || (!expected_short
                                && (p.width < px(150.) || !p.glyph_text.ends_with('\u{2026}')))
                            || p.clipped
                            || p.bounds.size.width != expected_width
                            || p.mask.size.width != expected_width
                            || p.width > p.bounds.size.width
                            || p.bounds.size.height != px(16.)
                        {
                            eprintln!("SIDEBAR bad paint frame={frame} input={input:?} {p:?}");
                            failed = true;
                        }
                    }
                    if failed {
                        bail!("incomplete/cropped native glyph output");
                    }
                    eprintln!(
                        "SIDEBAR verified frame={frame} mode={mode:?} viewport={:?} clipped=0",
                        window.viewport_size()
                    );
                    Ok(())
                },
            );
            if !matches!(result, Ok(Ok(()))) {
                eprintln!("SIDEBAR native FAIL: {result:?}");
                std::process::exit(1);
            }
        }
        // The other row layouts place text by their own geometry, so they are
        // held to what every layout owes: shaped glyphs match the text they
        // were given, and none is cropped or wider than its box.
        {
            use crate::config::LayoutMode;
            cx.update(|cx| cx.set_global(sidebar::layout_tests::VerifyChildGeometry(false)));
            for mode in [LayoutMode::Superset, LayoutMode::Orca, LayoutMode::Minimal] {
                        timer.timer(Duration::from_millis(100)).await;
                        let result = AnyWindowHandle::from(handle).update(
                            cx,
                            |root, window, cx| -> Result<()> {
                                use crate::sidebar::layout_tests::PaintedProbes;
                                cx.default_global::<PaintedProbes>().0.clear();
                                root.downcast::<HerdrWindow>()
                                    .map_err(|_| anyhow!("unexpected root"))?
                                    .update(cx, |view, cx| {
                                        view.config.layout.mode = mode;
                                        cx.notify();
                                    });
                                window.refresh();
                                window.draw(cx).clear(cx);
                                cx.default_global::<PaintedProbes>().check()?;
                                let probes = &cx.global::<PaintedProbes>().0;
                                // The long name must be cut short in every
                                // layout, which proves ellipsizing natively.
                                const LONG: &str =
                                    "herdr-gpui-sidebar-rendering-regression-investigation";
                                if !probes.get(LONG).is_some_and(|p| p.glyph_text.ends_with('\u{2026}')) {
                                    bail!("{mode}: {LONG:?} was not ellipsized");
                                }
                                for input in ["herdr", "Claude Code", LONG] {
                                    let p = probes
                                        .get(input)
                                        .with_context(|| format!("missing paint: {input}"))?;
                                    // Orca shares one line between an agent and
                                    // its place, so a name may end in an ellipsis.
                                    let shown = p.glyph_text == input
                                        || p.glyph_text.strip_suffix('\u{2026}').is_some_and(
                                            |kept| input.starts_with(kept.trim_end()),
                                        );
                                    if p.glyph_text != p.cached
                                        || !shown
                                        || p.clipped
                                        || p.width > p.bounds.size.width
                                    {
                                        bail!("{mode}: bad paint {input:?} {p:?}");
                                    }
                                }
                                eprintln!("SIDEBAR verified layout={mode}");
                                Ok(())
                            },
                        );
                        if !matches!(result, Ok(Ok(()))) {
                            eprintln!("SIDEBAR native FAIL: {result:?}");
                            std::process::exit(1);
                        }
            }
        }
        let _ = handle.update(cx, |view, _, cx| {
            // Later fixtures add PR badges and dialogs that change label budgets.
            cx.set_global(sidebar::layout_tests::VerifyChildGeometry(false));
            view.config.layout.mode = crate::config::LayoutMode::from(crate::config::Density::Comfortable);
            cx.notify();
        });
        #[cfg(target_os = "macos")]
        for step in 0..4 {
            let point = AnyWindowHandle::from(handle).update(cx, |root, window, cx| {
                let view = root
                    .downcast::<HerdrWindow>()
                    .map_err(|_| anyhow!("unexpected root"))?;
                view.update(cx, |view, _| {
                    if step == 0 {
                        if let Some(snapshot) = view.live.snapshot.as_mut() {
                            let snapshot = Arc::make_mut(snapshot);
                            snapshot.focused_workspace_id = Some("w4".into());
                            for workspace in &mut snapshot.workspaces {
                                workspace.focused = workspace.workspace_id == "w4";
                            }
                        }
                        view.marked = "preserve active child".into();
                    }
                });
                window.refresh();
                cx.default_global::<sidebar::layout_tests::PaintedProbes>()
                    .0
                    .clear();
                window.draw(cx).clear(cx);
                let label = match step {
                    0 => "\u{25be}",
                    1 => "\u{25b8}",
                    _ => "menu",
                };
                cx.global::<sidebar::layout_tests::PaintedProbes>()
                    .0
                    .get(label)
                    .map(|probe| probe.bounds.center())
                    .context("missing native click target")
                    .and_then(|point| Ok((sidebar::native_tests::Target::acquire(window)?, point)))
            });
            let result = point
                .context("updating native click target")
                .and_then(|point| point.context("native target"))
                .and_then(|(target, point)| target.click(point.x.to_f64(), point.y.to_f64()));
            timer.timer(Duration::from_millis(50)).await;
            let result = if step == 3 {
                result.and_then(|()| {
                    let (target, point) = AnyWindowHandle::from(handle)
                        .update(cx, |root, window, cx| -> Result<_> {
                            // Paint the reopened menu before targeting its outside hitbox.
                            window.draw(cx).clear(cx);
                            let view = root.downcast::<HerdrWindow>()
                                .map_err(|_| anyhow!("unexpected root"))?;
                            let state = view.read(cx);
                            if state.menu.page != Some(menu::Page::Menu) {
                                bail!("native footer click did not reopen menu");
                            }
                            let menu::Cover::Panel(panel) = state.menu.cover.get() else {
                                bail!("reopened native menu has no painted panel bounds");
                            };
                            let viewport = Bounds::new(Point::default(), window.viewport_size());
                            let x = if viewport.right() - panel.right() >= panel.left() {
                                (panel.right() + viewport.right()) / 2.
                            } else {
                                panel.left() / 2.
                            };
                            let point = gpui::point(x, viewport.center().y);
                            if !viewport.contains(&point) || panel.contains(&point) {
                                bail!("no outside click target: panel={panel:?} viewport={viewport:?}");
                            }
                            eprintln!("SIDEBAR native outside click: panel={panel:?} viewport={viewport:?} target={point:?}");
                            Ok((sidebar::native_tests::Target::acquire(window)?, point))
                        })
                        .context("acquiring outside-click target")??;
                    target.click(point.x.to_f64(), point.y.to_f64())
                })
            } else {
                result
            };
            let verified = AnyWindowHandle::from(handle).update(
                cx,
                |root, window, cx| -> Result<()> {
                    result?;
                    let view = root
                        .downcast::<HerdrWindow>()
                        .map_err(|_| anyhow!("unexpected root"))?;
                    let state = view.read(cx);
                    if step < 2 {
                        if state
                            .collapsed_repos
                            .contains("/fixture/agent-launcher/.git")
                            != (step == 0)
                            || state.marked != "preserve active child"
                            || state.live.snapshot.as_ref().is_none_or(|s| {
                                s.workspaces.len() != 40
                                    || s.focused_workspace_id.as_deref() != Some("w4")
                            })
                        {
                            bail!("collapse navigated, removed rows, or lost selection");
                        }
                    } else if step == 2 {
                        if state.menu.page != Some(menu::Page::Menu) {
                            bail!("native footer click did not open menu");
                        }
                        let before = state.input_probe;
                        window.dispatch_action(Box::new(RunCommand { command: Command::Tab }), cx);
                        for key in ["down", "down", "enter", "x", "escape"] {
                            window.dispatch_keystroke(
                                Keystroke {
                                    key: key.into(),
                                    ..Default::default()
                                },
                                cx,
                            );
                        }
                        let state = view.read(cx);
                        if state.menu.page.is_some()
                            || state.input_probe.text != before.text
                            || state.input_probe.keys != before.keys
                            || state.input_probe.actions != before.actions
                        {
                            bail!("menu keyboard handling leaked terminal input");
                        }
                    } else if state.menu.page.is_some() {
                        bail!("outside click did not dismiss native menu");
                    }
                    Ok(())
                },
            );
            if !matches!(verified, Ok(Ok(()))) {
                eprintln!("SIDEBAR native interaction FAIL: {verified:?}");
                std::process::exit(1);
            }
        }
        for show_agents in [false, true] {
            let result = AnyWindowHandle::from(handle).update(cx, |root, window, cx| {
                let view = root.downcast::<HerdrWindow>()
                    .map_err(|_| anyhow!("unexpected root"))?;
                view.update(cx, |view, cx| {
                    view.config.show_agents = show_agents;
                    cx.notify();
                });
                cx.default_global::<sidebar::layout_tests::PaintedProbes>().0.clear();
                window.refresh();
                window.draw(cx).clear(cx);
                let probes = &cx.global::<sidebar::layout_tests::PaintedProbes>().0;
                if probes.contains_key("Claude Code") != show_agents
                    || !probes.contains_key("herdr")
                    || !probes.contains_key("menu")
                {
                    bail!("native Agents visibility did not follow configuration");
                }
                Ok(())
            });
            if !matches!(result, Ok(Ok(()))) {
                eprintln!("SIDEBAR native visibility FAIL: {result:?}");
                std::process::exit(1);
            }
        }
        #[cfg(target_os = "macos")]
        for (width, height) in [(640., 400.), (1200., 780.)] {
            let _ = handle.update(cx, |_, window, _| window.resize(size(px(width), px(height))));
            timer.timer(Duration::from_millis(100)).await;
            for (keys, action) in [
                ("down enter", menu::WorkspaceAction::Rename),
                ("down down enter", menu::WorkspaceAction::Close),
                ("down down down enter", menu::WorkspaceAction::NewWorktree),
                // Linked checkouts offer NewWorktree before DeleteWorktree too.
                ("down down down down enter", menu::WorkspaceAction::DeleteWorktree),
            ] {
                let point = handle.update(cx, |view, window, cx| {
                    view.live.status = ConnectionStatus::Connected;
                    // Keep the clicked row inside the scroll viewport below the native titlebar.
                    view.sidebar_scroll[0].set_offset(point(px(0.), px(if action == menu::WorkspaceAction::DeleteWorktree { -140. } else { -80. })));
                    cx.default_global::<sidebar::layout_tests::PaintedProbes>().0.clear();
                    cx.notify();
                    window.refresh();
                });
                if let Err(error) = point {
                    eprintln!("SIDEBAR native dialog setup FAIL: {error}");
                    std::process::exit(1);
                }
                let point = AnyWindowHandle::from(handle).update(cx, |_, window, cx| {
                    window.draw(cx).clear(cx);
                    cx.global::<sidebar::layout_tests::PaintedProbes>().0.get(if action == menu::WorkspaceAction::DeleteWorktree { "sidebar-child" } else { "agent-launcher" }).map(|probe| {
                        eprintln!("DIALOG native {action:?} viewport={:?}", window.viewport_size());
                         probe.bounds.center()
                    })
                });
                let target = handle.update(cx, |_, window, _| sidebar::native_tests::Target::acquire(window));
                let clicked = match (point, target) {
                    (Ok(Some(point)), Ok(Ok(target))) => target.right_click(point.x.to_f64(), point.y.to_f64()),
                    _ => Err(anyhow!("missing native workspace")),
                };
                timer.timer(Duration::from_millis(50)).await;
                // Observe only this dialog's inputs without exposing menu-private fields.
                let inputs = std::rc::Rc::new(std::cell::RefCell::new(Vec::new()));
                let observed = inputs.clone();
                let subscription = cx.update(|cx| cx.observe_new::<crate::search_input::SearchInput>(
                    move |_, _, cx| observed.borrow_mut().push(cx.entity()),
                ));
                let opened = AnyWindowHandle::from(handle).update(cx, |root, window, cx| -> Result<_> {
                    clicked?;
                    let view = root.downcast::<HerdrWindow>().map_err(|_| anyhow!("unexpected root"))?;
                    if view.read(cx).menu.page != Some(menu::Page::Workspace) { bail!("right click did not open workspace menu"); }
                    view.update(cx, |view, _| -> Result<()> {
                        let mut pr = pull_request::fixture()?;
                        pr.head_ref_name = "feature/a-deliberately-long-branch-name-for-the-compact-popover".repeat(3);
                        view.workspace_pr_fixture(pr)?;
                        Ok(())
                    })?;
                    cx.default_global::<sidebar::layout_tests::PaintedProbes>().0.clear();
                    window.draw(cx).clear(cx);
                    let probes = &cx.global::<sidebar::layout_tests::PaintedProbes>().0;
                    for (text, probe) in probes.iter().filter(|(text, _)| text.starts_with("#8 ") || matches!(text.as_str(), "+1730" | "-31")) {
                        if probe.glyph_text != probe.cached || probe.clipped || probe.glyph_text.is_empty() {
                            bail!("native PR glyphs clipped: {text} {probe:?}");
                        }
                        if text.starts_with("#8 ") && (!probe.glyph_text.starts_with("#8 Improve") || !probe.glyph_text.ends_with('\u{2026}')) {
                            bail!("native PR title did not truncate correctly: {probe:?}");
                        }
                    }
                    if !probes.contains_key("+1730") || !probes.contains_key("-31") || !probes.keys().any(|text| text.starts_with("#8 ")) {
                        bail!("native PR summary was not painted");
                    }
                    let title = probes.iter().find(|(text, _)| text.starts_with("#8 ")).map(|(_, probe)| probe).context("missing PR title")?;
                    let additions = probes.get("+1730").context("missing PR additions")?;
                    if additions.bounds.bottom() - title.bounds.top() > px(160.)
                        || additions.bounds.bottom() > window.viewport_size().height
                        || title.bounds.right() > window.viewport_size().width
                    {
                        bail!("native PR summary is oversized or outside the viewport");
                    }
                    let before = view.read(cx).input_probe;
                    for key in keys.split(' ') {
                        window.dispatch_keystroke(Keystroke::parse(key)?, cx);
                    }
                    window.draw(cx).clear(cx);
                    if view.read(cx).menu.page != Some(menu::Page::Dialog(action)) {
                        bail!("workspace menu opened wrong dialog at {width}x{height} after {keys:?}: expected {:?}, actual {:?}", menu::Page::Dialog(action), view.read(cx).menu.page);
                    }
                    window.dispatch_action(Box::new(RunCommand { command: Command::Tab }), cx);
                    let branch = view.read(cx).menu.input.as_ref().map(|input| input.text.clone());
                    Ok((before, branch))
                });
                // Finish entity creation before inspecting the dialog's focused input.
                let verified = AnyWindowHandle::from(handle).update(cx, |root, window, cx| -> Result<()> {
                    let (before, branch) = opened.context("opening native dialog")??;
                    let view = root.downcast::<HerdrWindow>().map_err(|_| anyhow!("unexpected root"))?;
                    let name = if action == menu::WorkspaceAction::NewWorktree {
                        if !view.read(cx).worktree_name_focused(window, cx) {
                            bail!("new worktree did not focus its name field");
                        }
                        Some(inputs.borrow().iter()
                            .find(|input| input.read(cx).focus.is_focused(window))
                            .cloned().context("missing native worktree name editor")?)
                    } else {
                        None
                    };
                    // Only the editable dialogs carry a text field; confirmations do not.
                    if matches!(action, menu::WorkspaceAction::Rename | menu::WorkspaceAction::NewWorktree) {
                        window.dispatch_keystroke(Keystroke::parse("cmd-a")?, cx);
                        for ch in "long-label-\u{65e5}\u{672c}-\u{1f600}".repeat(4).chars() {
                            window.dispatch_keystroke(Keystroke::parse(&ch.to_string())?, cx);
                        }
                        window.draw(cx).clear(cx);
                        if let Some(name) = name {
                            if view.read(cx).menu.input.as_ref().map(|input| &input.text) != branch.as_ref() {
                                bail!("typing the worktree name changed its branch draft");
                            }
                            name.update(cx, |input, cx| -> Result<()> {
                                if input.text() != "long-label-\u{65e5}\u{672c}-\u{1f600}".repeat(4)
                                    || !input.focus.is_focused(window) {
                                    bail!("native worktree name editor lost Unicode text or focus");
                                }
                                let end = input.text().encode_utf16().count();
                                let field = input.bounds_for_range(0..end, Bounds::default(), window, cx)
                                    .context("missing native name field bounds")?;
                                let caret = input.bounds_for_range(end..end, Bounds::default(), window, cx)
                                    .context("missing native name IME bounds")?;
                                // Text-range bounds end at the caret; Bounds::contains
                                // excludes that right edge, unlike an input's padded box.
                                if caret.left() != field.right() || caret.top() != field.top()
                                    || caret.bottom() != field.bottom() || field.size.width <= px(0.)
                                    || field.left() < px(0.) || field.top() < px(0.)
                                    || field.right() > window.viewport_size().width || field.bottom() > window.viewport_size().height {
                                    bail!("native name caret/field out of bounds: field={field:?} caret={caret:?} viewport={:?}", window.viewport_size());
                                }
                                Ok(())
                            })?;
                        } else {
                            view.update(cx, |view, cx| -> Result<()> {
                            let input = view.menu.input.as_ref().context("missing native editor")?;
                            if input.text != "long-label-\u{65e5}\u{672c}-\u{1f600}".repeat(4) { bail!("native editor lost Unicode text"); }
                            let end = input.text.encode_utf16().count();
                            let field = input.bounds;
                            let caret = view.bounds_for_range(end..end, Bounds::default(), window, cx).context("missing native IME bounds")?;
                            if !field.contains(&caret.origin) || field.right() > window.viewport_size().width || field.bottom() > window.viewport_size().height { bail!("native dialog caret/field out of bounds"); }
                            Ok(())
                        })?;
                        }
                    }
                    window.dispatch_keystroke(Keystroke::parse("escape")?, cx);
                    let state = view.read(cx);
                    if state.menu.page.is_some() || state.input_probe.text != before.text || state.input_probe.keys != before.keys || state.input_probe.actions != before.actions || !state.focus.is_focused(window) { bail!("workspace dialog leaked input or lost focus"); }
                    Ok(())
                });
                drop(subscription);
                if !matches!(verified, Ok(Ok(()))) {
                    eprintln!("SIDEBAR native dialog FAIL: {verified:?}");
                    std::process::exit(1);
                }
            }
        }
        for (width, height) in [(640., 400.), (1200., 780.)] {
            let _ = handle.update(cx, |_, window, _| window.resize(size(px(width), px(height))));
            timer.timer(Duration::from_millis(100)).await;
            for state in 0..5 {
                let result = AnyWindowHandle::from(handle).update(cx, |root, window, cx| -> Result<()> {
                    let view = root.downcast::<HerdrWindow>().map_err(|_| anyhow!("unexpected root"))?;
                    view.update(cx, |view, cx| {
                        view.github_fixture(state == 1, window, cx);
                        if state == 2 {
                            view.menu.github.failed = true;
                            view.menu.github.message = Some("GitHub code expired. Sign in again. ".repeat(40));
                        } else if state == 3 {
                            view.menu.github = github::Auth::connected_fixture();
                        } else if state == 4 {
                            view.menu.github = github::Auth::requesting_fixture();
                        }
                    });
                    cx.default_global::<sidebar::layout_tests::PaintedProbes>().0.clear();
                    window.draw(cx).clear(cx);
                    if state == 1 {
                        let probe = cx.global::<sidebar::layout_tests::PaintedProbes>().0.get("ABCD-1234").context("GitHub device code not painted")?;
                        if probe.clipped || probe.glyph_text != "ABCD-1234" { bail!("GitHub device code clipped"); }
                    }
                    let probes = &cx.global::<sidebar::layout_tests::PaintedProbes>().0;
                    if probes.contains_key("Cancel (Esc)") || probes.contains_key("Close (Esc)") { bail!("redundant GitHub footer close"); }
                    let close = probes.get("Close").context("missing GitHub header close")?;
                    if close.clipped || close.glyph_text != "Close" || close.bounds.bottom() > window.viewport_size().height { bail!("GitHub header close clipped"); }
                    if state == 3 {
                        let signout = probes.get("Sign out (D)").context("missing signout action")?;
                        if signout.bounds.bottom() - close.bounds.top() > px(230.) { bail!("connected GitHub panel is oversized"); }
                    }
                    let before = view.read(cx).input_probe;
                    window.dispatch_keystroke(Keystroke::parse("c")?, cx);
                    window.dispatch_keystroke(Keystroke::parse("escape")?, cx);
                    let state = view.read(cx);
                    if state.menu.page.is_some() || state.input_probe.text != before.text || state.input_probe.keys != before.keys || !state.focus.is_focused(window) { bail!("GitHub sign-in leaked input or lost focus"); }
                    Ok(())
                });
                if !matches!(result, Ok(Ok(()))) {
                    eprintln!("SIDEBAR native GitHub auth FAIL: {result:?}");
                    std::process::exit(1);
                }
            }
        }
        #[cfg(target_os = "macos")]
        if let Err(error) = sidebar_hosts(handle, cx).await {
            eprintln!("SIDEBAR native hosts FAIL: {error:#}");
            std::process::exit(1);
        }
        let probes = cx.update(|cx| cx.default_global::<sidebar::layout_tests::PaintedProbes>().check());
        if !matches!(probes, Ok(())) {
            eprintln!("SIDEBAR native paint FAIL: {probes:?}");
            std::process::exit(1);
        }
        eprintln!("SIDEBAR native PASS: {cascade}; 72 Menlo draws, flat and rounded normal/compact/comfortable layouts at 4 sizes, collapse/expand, menu isolation, PR title/stats glyphs, GitHub auth fixtures, right-click dialogs and Unicode fields at 2 sizes; host routing, disabled selection, scoped repositories, resized host/agent glyphs, independent scroll and decoy key window");
        std::process::exit(0);
    })
    .detach();
}
