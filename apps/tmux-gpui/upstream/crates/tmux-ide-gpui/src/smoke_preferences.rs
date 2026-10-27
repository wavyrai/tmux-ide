//! Native Preferences fixture checks run by the sidebar smoke driver.
use super::*;

pub(super) async fn sidebar_preferences(
    handle: WindowHandle<HerdrWindow>,
    cx: &mut AsyncApp,
) -> Result<()> {
    use crate::settings_panel::Tab;

    let original_size = handle.update(cx, |_, window, _| window.viewport_size())?;
    handle.update(cx, |view, window, cx| {
        view.open_preferences_fixture(window, cx);
    })?;
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        let loaded = handle.update(cx, |view, _, _| -> Result<bool> {
            if let Some(error) = &view.settings.error {
                bail!("shared settings load: {error}");
            }
            Ok(view.settings.loaded
                && view.settings.task.is_none()
                && view.settings.shared.is_some())
        })??;
        if loaded {
            break;
        }
        if Instant::now() >= deadline {
            bail!("Preferences settings load timed out");
        }
        cx.background_executor()
            .timer(Duration::from_millis(10))
            .await;
    }
    for (width, height) in [(800., 600.), (320., 400.)] {
        handle.update(cx, |_, window, _| {
            window.resize(fixture_size(width, height))
        })?;
        let deadline = Instant::now() + Duration::from_secs(2);
        while !handle.update(cx, |_, window, _| {
            window.viewport_size() == fixture_size(width, height)
        })? {
            if Instant::now() >= deadline {
                bail!("Preferences resize timed out: {width}");
            }
            cx.background_executor()
                .timer(Duration::from_millis(10))
                .await;
        }
        handle.update(cx, |view, window, cx| {
            view.select_settings_tab(Tab::Theme, window, cx)
        })?;
        for (index, tab) in Tab::ALL.into_iter().enumerate() {
            for right_edge in [false, true] {
                handle.update(cx, |view, window, cx| {
                    view.select_settings_tab(
                        if tab == Tab::General {
                            Tab::Theme
                        } else {
                            Tab::General
                        },
                        window,
                        cx,
                    );
                    // Selection reveals the other tab; reveal the click target instead.
                    view.settings.tabs_scroll.scroll_to_item(index);
                })?;
                let (target, bounds) = AnyWindowHandle::from(handle).update(
                    cx,
                    |root, window, cx| -> Result<_> {
                        window.refresh();
                        window.draw(cx).clear(cx);
                        let entity = root
                            .downcast::<HerdrWindow>()
                            .map_err(|_| anyhow!("unexpected root"))?;
                        let view = entity.read(cx);
                        let scroll = &view.settings.tabs_scroll;
                        let viewport = scroll.bounds();
                        let first = scroll.bounds_for_item(0).context("missing first tab")?;
                        let mut previous_right = first.left();
                        for item in 0..Tab::ALL.len() {
                            let bounds = scroll.bounds_for_item(item).context("missing tab")?;
                            if bounds.top() != first.top()
                                || bounds.bottom() != first.bottom()
                                || bounds.left() < previous_right
                            {
                                bail!("Preferences tabs not in a single row: {item} {bounds:?}");
                            }
                            previous_right = bounds.right();
                        }
                        let mut bounds = scroll.bounds_for_item(index).context("missing tab")?;
                        bounds.origin += scroll.offset();
                        if viewport.left() < px(0.)
                            || viewport.right() > window.viewport_size().width
                            || viewport.top() < px(0.)
                            || viewport.bottom() > window.viewport_size().height
                            || bounds.size.width <= px(8.)
                            || bounds.size.height <= px(0.)
                            || bounds.left() < viewport.left()
                            || bounds.right() > viewport.right()
                            || bounds.top() < viewport.top()
                            || bounds.bottom() > viewport.bottom()
                        {
                            bail!("Preferences tab clipped: {tab:?} {bounds:?} in {viewport:?}");
                        }
                        Ok((sidebar::native_tests::Target::acquire(window)?, bounds))
                    },
                )??;
                let x = if right_edge {
                    bounds.right() - px(4.)
                } else {
                    bounds.left() + px(4.)
                };
                target.click(x.to_f64(), bounds.center().y.to_f64())?;
                drop(target);
                handle.update(cx, |view, _, _| -> Result<()> {
                    if view.settings.tab != tab {
                        bail!("native Preferences tab {tab:?} not reachable at {x:?}, {bounds:?}");
                    }
                    Ok(())
                })??;
            }
            AnyWindowHandle::from(handle).update(cx, |root, window, cx| -> Result<()> {
                window.refresh();
                window.draw(cx).clear(cx);
                let entity = root
                    .downcast::<HerdrWindow>()
                    .map_err(|_| anyhow!("unexpected root"))?;
                let view = entity.read(cx);
                if view.menu.page != Some(menu::Page::Preferences)
                    || view.settings.tab != tab
                    || !view.menu.focus.is_focused(window)
                {
                    bail!("Preferences tab/focus mismatch: {tab:?}");
                }
                // Integrations owns a separate private scroll handle; the
                // preferences handle would report stale bounds for that tab.
                if tab != Tab::Integrations {
                    let body = view.menu.preferences_scroll.bounds();
                    if body.size.width <= px(0.)
                        || body.size.height <= px(0.)
                        || body.left() < px(0.)
                        || body.right() > window.viewport_size().width
                        || body.top() < px(0.)
                        || body.bottom() > window.viewport_size().height
                    {
                        bail!("Preferences body out of viewport: {tab:?} {body:?}");
                    }
                }
                if tab == Tab::Indicators {
                    // Probe the actual UI font on the native text system, not the
                    // terminal's Nerd Font cascade or the headless fixed glyphs.
                    let glyphs = |text: &str| {
                        window
                            .text_system()
                            .shape_line(
                                text.to_owned().into(),
                                px(view.config.ui.size),
                                &[TextRun {
                                    len: text.len(),
                                    font: view.config.ui.font(),
                                    color: rgb(view.theme.foreground).into(),
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
                    let missing = glyphs("\u{f0000}");
                    for symbol in ["\u{25d0}", "\u{d7}", "\u{2713}", "\u{25cb}", "\u{b7}"] {
                        let shaped = glyphs(symbol);
                        if shaped.is_empty() || shaped == missing {
                            bail!("Preferences indicator missing native glyph: {symbol:?}");
                        }
                    }
                }
                eprintln!("SIDEBAR native preferences tab={tab:?} width={width}");
                Ok(())
            })??;
            if tab == Tab::Font {
                let (target, point, before) =
                    handle.update(cx, |view, window, _| -> Result<_> {
                        // The All fonts row follows the heading. Its center
                        // lands in the installed-font chooser, not the label.
                        let row = view
                            .menu
                            .preferences_scroll
                            .bounds_for_item(1)
                            .context("missing All fonts row")?;
                        let body = view.menu.preferences_scroll.bounds();
                        if row.left() < body.left()
                            || row.right() > body.right()
                            || !body.contains(&row.center())
                        {
                            bail!("first font editor clipped: {row:?} in {body:?}");
                        }
                        Ok((
                            sidebar::native_tests::Target::acquire(window)?,
                            row.center(),
                            view.input_probe,
                        ))
                    })??;
                target.click(point.x.to_f64(), point.y.to_f64())?;
                drop(target);
                AnyWindowHandle::from(handle).update(cx, |root, window, cx| -> Result<()> {
                    window.draw(cx).clear(cx);
                    let entity = root
                        .downcast::<HerdrWindow>()
                        .map_err(|_| anyhow!("unexpected root"))?;
                    let editor_focus = window.focused(cx).context("font editor has no focus")?;
                    if entity.read(cx).menu.focus.is_focused(window)
                        || entity.read(cx).focus.is_focused(window)
                    {
                        bail!("native font click did not focus editor");
                    }
                    for key in ["cmd-a", "M", "e", "n", "l", "o", "tab"] {
                        window.dispatch_keystroke(Keystroke::parse(key)?, cx);
                    }
                    window.draw(cx).clear(cx);
                    if entity.read(cx).menu.page != Some(menu::Page::Fonts)
                        || entity.read(cx).settings.tab != Tab::Font
                        || !editor_focus.is_focused(window)
                    {
                        bail!("font typing/Tab lost editor focus");
                    }
                    window.dispatch_keystroke(Keystroke::parse("escape")?, cx);
                    if !entity.read(cx).menu.focus.is_focused(window) {
                        bail!("font Escape did not return focus to Preferences");
                    }
                    window.draw(cx).clear(cx);
                    window.dispatch_keystroke(Keystroke::parse("tab")?, cx);
                    if entity.read(cx).settings.tab != Tab::General {
                        bail!("Tab did not resume Preferences section navigation");
                    }
                    let after = entity.read(cx).input_probe;
                    if after.text != before.text
                        || after.keys != before.keys
                        || after.actions != before.actions
                    {
                        bail!("Preferences font input leaked to terminal");
                    }
                    Ok(())
                })??;
            }
        }
    }
    AnyWindowHandle::from(handle).update(cx, |root, window, cx| -> Result<()> {
        window.draw(cx).clear(cx);
        window.dispatch_keystroke(Keystroke::parse("escape")?, cx);
        let entity = root
            .downcast::<HerdrWindow>()
            .map_err(|_| anyhow!("unexpected root"))?;
        let view = entity.read(cx);
        if view.menu.page.is_some()
            || !view.focus.is_focused(window)
            || view.settings.task.is_some()
            || view.native_settings_save_in_flight()
        {
            bail!("Preferences dismissal lost focus or unexpectedly saved settings");
        }
        Ok(())
    })??;
    handle.update(cx, |_, window, _| window.resize(original_size))?;
    let deadline = Instant::now() + Duration::from_secs(2);
    while !handle.update(cx, |_, window, _| window.viewport_size() == original_size)? {
        if Instant::now() >= deadline {
            bail!("Preferences fixture viewport restoration timed out");
        }
        cx.background_executor()
            .timer(Duration::from_millis(10))
            .await;
    }
    eprintln!(
        "SIDEBAR native legacy preferences PASS: all 7 tabs in a single scrolling row at 800/320px, indicator glyphs, font editor focus, Tab/Escape isolation; no saves"
    );

    crate::settings_window::verify_native(handle, cx).await?;
    Ok(())
}
