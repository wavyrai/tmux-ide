//! Native font section checks: inline role rows, picker, and size editing.
use super::super::themes;
use super::*;
use crate::{config::FontFace, font_picker::FontTarget};

fn inside(inner: Bounds<Pixels>, outer: Bounds<Pixels>) -> Result<()> {
    ensure!(
        inner.left() >= outer.left()
            && inner.right() <= outer.right()
            && inner.top() >= outer.top()
            && inner.bottom() <= outer.bottom()
            && inner.size.width > px(0.)
            && inner.size.height > px(0.),
        "native font control clipped: {inner:?} outside {outer:?}"
    );
    Ok(())
}

async fn font_click(
    settings: WindowHandle<SettingsWindow>,
    id: &str,
    row_label: bool,
    cx: &mut AsyncApp,
) -> Result<()> {
    let (target, position) =
        AnyWindowHandle::from(settings).update(cx, |root, window, cx| -> Result<_> {
            window.draw(cx).clear(cx);
            let view = root
                .downcast::<SettingsWindow>()
                .map_err(|_| anyhow::anyhow!("unexpected Settings root"))?;
            let bounds = view
                .read(cx)
                .native_font_bounds(id, cx)
                .with_context(|| format!("missing native font paint: {id}"))?;
            let position = if row_label {
                point(bounds.left() + px(20.), bounds.center().y)
            } else {
                bounds.center()
            };
            Ok((Target::acquire(window)?, position))
        })??;
    target.click(
        f64::from(f32::from(position.x)),
        f64::from(f32::from(position.y)),
    )?;
    Ok(())
}

pub(super) async fn verify_fonts(
    settings: WindowHandle<SettingsWindow>,
    source: WindowHandle<HerdrWindow>,
    expected: Size<Pixels>,
    cx: &mut AsyncApp,
) -> Result<()> {
    let deadline = Instant::now() + Duration::from_secs(3);
    while !settings.update(cx, |view, _, cx| {
        !view.busy() && !view.native_font_search(cx).4
    })? {
        ensure!(Instant::now() < deadline, "native font discovery timed out");
        cx.background_executor()
            .timer(Duration::from_millis(10))
            .await;
    }
    let original_sizes = settings.update(cx, |view, _, _| {
        [
            view.config.terminal.size,
            view.config.sidebar.size,
            view.config.tabs.size,
            view.config.ui.size,
        ]
    })?;
    let input_before = source.update(cx, |view, _, _| view.input_probe)?;
    let (path, bytes_before) = cx
        .background_executor()
        .spawn(async {
            let path = Config::local_path()?;
            let bytes = std::fs::read(&path)?;
            anyhow::Ok((path, bytes))
        })
        .await?;
    #[cfg(feature = "mockup")]
    if expected.width == px(960.) && std::env::var_os("HERDR_TEST_SETTINGS_CAPTURE").is_some() {
        settings.update(cx, |view, _, cx| {
            view.accept_theme_choice(
                themes::Choice {
                    scope: themes::Scope::App,
                    name: "Catppuccin Latte".into(),
                },
                cx,
            )
        })?;
    }
    AnyWindowHandle::from(settings).update(cx, |root, window, cx| -> Result<()> {
        window.draw(cx).clear(cx);
        let view = root
            .downcast::<SettingsWindow>()
            .map_err(|_| anyhow::anyhow!("unexpected Settings root"))?;
        let view = view.read(cx);
        ensure!(
            view.native_font_bounds("settings-font-picker", cx)
                .is_none()
                && view
                    .native_font_bounds("settings-font-results", cx)
                    .is_none(),
            "closed font catalog was painted"
        );
        let body = view.body_scroll.bounds();
        let mut bottom = body.top();
        for name in ["terminal", "sidebar", "tabs", "ui"] {
            let row = view
                .native_font_bounds(&format!("settings-font-row-{name}"), cx)
                .context("font role row missing")?;
            let family = view
                .native_font_bounds(&format!("settings-font-family-{name}"), cx)
                .context("font family missing")?;
            let size = view
                .native_font_bounds(&format!("settings-size-{name}"), cx)
                .context("font stepper missing")?;
            inside(row, body)?;
            inside(family, row)?;
            inside(size, row)?;
            ensure!(
                row.top() >= bottom
                    // The canvas measures inside the row's two 1px borders.
                    && row.size.height == px(50.)
                    && family.right() <= size.left()
                    && (family.center().y - size.center().y).abs() < px(1.),
                "compact font rows overlap or are not inline: {row:?}, {family:?}, {size:?}"
            );
            bottom = row.bottom();
        }
        Ok(())
    })??;
    for (name, face) in [
        ("sidebar", FontFace::Sidebar),
        ("tabs", FontFace::Tabs),
        ("ui", FontFace::Ui),
        ("terminal", FontFace::Terminal),
    ] {
        font_click(settings, &format!("settings-font-row-{name}"), true, cx).await?;
        let deadline = Instant::now() + Duration::from_secs(2);
        while !settings.update(cx, |view, _, _| view.native_font_selection().1 == face)? {
            ensure!(
                Instant::now() < deadline,
                "native specimen role click {face:?} timed out"
            );
            cx.background_executor()
                .timer(Duration::from_millis(10))
                .await;
        }
        settings.update(cx, |view, _, _| -> Result<()> {
            let (_, selected, specimen) = view.native_font_selection();
            ensure!(
                selected == face && specimen.size == face.size(&view.config),
                "specimen role/size mismatch"
            );
            Ok(())
        })??;
    }
    #[cfg(feature = "mockup")]
    if expected.width == px(960.) {
        capture_settings(settings, "fonts.png", cx).await?;
    }
    for target in [FontTarget::Face(FontFace::Terminal), FontTarget::All] {
        font_click(
            settings,
            if target == FontTarget::All {
                "settings-font-all"
            } else {
                "settings-font-family-terminal"
            },
            false,
            cx,
        )
        .await?;
        let deadline = Instant::now() + Duration::from_secs(2);
        while !settings.update(cx, |view, _, _| {
            view.native_font_selection().0 == Some(target)
        })? {
            ensure!(
                Instant::now() < deadline,
                "native font picker click timed out"
            );
            cx.background_executor()
                .timer(Duration::from_millis(10))
                .await;
        }
        AnyWindowHandle::from(settings).update(cx, |root, window, cx| -> Result<()> {
            window.draw(cx).clear(cx);
            let view = root
                .downcast::<SettingsWindow>()
                .map_err(|_| anyhow::anyhow!("unexpected Settings root"))?;
            let view = view.read(cx);
            let picker = view
                .native_font_bounds("settings-font-picker", cx)
                .context("picker not painted")?;
            inside(picker, view.body_scroll.bounds())?;
            for id in [
                "settings-font-search",
                "settings-font-results",
                "settings-font-default",
                "settings-font-result-0",
            ] {
                inside(
                    view.native_font_bounds(id, cx)
                        .with_context(|| format!("missing {id}"))?,
                    picker,
                )?;
            }
            let (focus, query, filtered, total, discovering) = view.native_font_search(cx);
            ensure!(
                !discovering
                    && total > 1
                    && filtered == total
                    && query.is_empty()
                    && focus.is_focused(window),
                "picker did not open with the full installed catalog and search focus"
            );
            Ok(())
        })??;
        if target != FontTarget::All {
            AnyWindowHandle::from(settings).update(cx, |_, window, cx| -> Result<()> {
                for key in ["m", "e", "n", "l", "o"] {
                    ensure!(
                        window.dispatch_keystroke(Keystroke::parse(key)?, cx),
                        "font query key not handled"
                    );
                }
                Ok(())
            })??;
            let deadline = Instant::now() + Duration::from_secs(2);
            loop {
                let ready = settings.update(cx, |view, window, cx| {
                    let (focus, query, filtered, total, _) = view.native_font_search(cx);
                    focus.is_focused(window) && query == "menlo" && filtered > 0 && filtered < total
                })?;
                if ready {
                    break;
                }
                ensure!(
                    Instant::now() < deadline,
                    "native installed Menlo search did not narrow catalog"
                );
                cx.background_executor()
                    .timer(Duration::from_millis(10))
                    .await;
            }
            #[cfg(feature = "mockup")]
            if expected.width == px(960.) {
                capture_settings(settings, "font-picker.png", cx).await?;
            }
            AnyWindowHandle::from(settings).update(cx, |_, window, cx| -> Result<()> {
                window.dispatch_keystroke(Keystroke::parse("escape")?, cx);
                Ok(())
            })??;
        } else {
            let target = AnyWindowHandle::from(settings)
                .update(cx, |_, window, _| Target::acquire(window))??;
            target.click(190., 50.)?;
        }
        let deadline = Instant::now() + Duration::from_secs(2);
        while !settings.update(cx, |view, window, _| {
            view.native_font_selection().0.is_none() && view.focus.is_focused(window)
        })? {
            ensure!(
                Instant::now() < deadline,
                "font picker dismissal did not restore focus"
            );
            cx.background_executor()
                .timer(Duration::from_millis(10))
                .await;
        }
    }
    font_click(settings, "settings-size-value-terminal", false, cx).await?;
    let deadline = Instant::now() + Duration::from_secs(2);
    while !settings.update(cx, |view, window, cx| {
        view.native_font_editor(cx)
            .is_some_and(|(focus, _)| focus.is_focused(window))
    })? {
        ensure!(
            Instant::now() < deadline,
            "native numeric field click did not focus editor"
        );
        cx.background_executor()
            .timer(Duration::from_millis(10))
            .await;
    }
    AnyWindowHandle::from(settings).update(cx, |root, window, cx| -> Result<()> {
        window.draw(cx).clear(cx);
        for key in ["1", "8"] {
            window.dispatch_keystroke(Keystroke::parse(key)?, cx);
        }
        let view = root
            .downcast::<SettingsWindow>()
            .map_err(|_| anyhow::anyhow!("unexpected Settings root"))?;
        ensure!(
            view.read(cx)
                .native_font_editor(cx)
                .is_some_and(|(_, text)| text == "18"),
            "native numeric typing did not replace selected value"
        );
        window.dispatch_keystroke(Keystroke::parse("escape")?, cx);
        Ok(())
    })??;
    settings.update(cx, |view, window, cx| -> Result<()> {
        ensure!(
            view.native_font_editor(cx).is_none()
                && view.focus.is_focused(window)
                && !view.saving
                && view.native_font_sizes_idle()
                && [
                    view.config.terminal.size,
                    view.config.sidebar.size,
                    view.config.tabs.size,
                    view.config.ui.size
                ] == original_sizes,
            "cancelled native size edit changed sizes, queued a save, or lost focus"
        );
        Ok(())
    })??;
    source.update(cx, |view, _, _| -> Result<()> {
        ensure!(
            view.input_probe.text == input_before.text
                && view.input_probe.keys == input_before.keys
                && view.input_probe.actions == input_before.actions,
            "font controls leaked source input"
        );
        Ok(())
    })??;
    let bytes_after = cx
        .background_executor()
        .spawn(async move { std::fs::read(path) })
        .await?;
    ensure!(
        bytes_after == bytes_before,
        "native font browsing/cancellation wrote config"
    );
    eprintln!(
        "SIDEBAR native compact fonts PASS at {expected:?}: four inline roles, live specimen selection, installed Menlo search, scoped/default and All picker, Escape/outside dismissal, cancelled size 18; no source input or config writes"
    );
    Ok(())
}
