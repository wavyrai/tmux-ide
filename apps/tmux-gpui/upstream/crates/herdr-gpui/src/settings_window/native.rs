//! Native checks run only inside live_gui's isolated HOME/XDG fixture process.
use super::*;
use crate::sidebar::native_tests::Target;
use anyhow::{Context as _, Result, bail, ensure};
use std::time::{Duration, Instant};

mod fonts;
mod themes;
use fonts::verify_fonts;
use themes::verify_themes;

#[derive(Default)]
/// One probe per section, so the count follows the sections this build has.
struct Layout([Option<Bounds<Pixels>>; Section::ALL.len()]);
impl Global for Layout {}

pub(super) fn probe(index: usize) -> impl IntoElement {
    canvas(
        |_, _, _| (),
        move |bounds, _, _, cx| {
            cx.default_global::<Layout>().0[index] = Some(bounds);
        },
    )
    .absolute()
    .size_full()
}

#[cfg(feature = "mockup")]
async fn capture_settings(
    settings: WindowHandle<SettingsWindow>,
    extension: &str,
    cx: &mut AsyncApp,
) -> Result<()> {
    let Some(path) = std::env::var_os("HERDR_TEST_SETTINGS_CAPTURE") else {
        return Ok(());
    };
    let path = std::path::PathBuf::from(path).with_extension(extension);
    ensure!(
        path.is_absolute(),
        "HERDR_TEST_SETTINGS_CAPTURE must be absolute"
    );
    let deadline = Instant::now() + Duration::from_secs(3);
    let image = loop {
        let image =
            AnyWindowHandle::from(settings).update(cx, |root, window, cx| -> Result<_> {
                let view = root
                    .downcast::<SettingsWindow>()
                    .map_err(|_| anyhow::anyhow!("unexpected Settings root"))?;
                if view.read(cx).busy() || view.read(cx).native_font_search(cx).4 {
                    return Ok(None);
                }
                ensure!(
                    view.read(cx).section != Section::Fonts
                        || view.read(cx).config.theme == "Catppuccin Latte",
                    "font capture lost its light theme draft"
                );
                // Inspect readiness, draw, and capture without yielding to the watcher.
                window.draw(cx).clear(cx);
                Ok(Some(window.render_to_image()?))
            })??;
        if let Some(image) = image {
            break image;
        }
        ensure!(
            Instant::now() < deadline,
            "native Settings capture did not settle"
        );
        cx.background_executor()
            .timer(Duration::from_millis(10))
            .await;
    };
    let printed_path = path.clone();
    cx.background_executor()
        .spawn(async move {
            use image::codecs::png::{CompressionType, FilterType, PngEncoder};
            let mut png = Vec::new();
            // Avoid adaptive filtering's debug-build cost inside the native fixture budget.
            image.write_with_encoder(PngEncoder::new_with_quality(
                &mut png,
                CompressionType::Fast,
                FilterType::Sub,
            ))?;
            std::fs::write(path, png).context("save native Settings capture")?;
            anyhow::Ok(())
        })
        .await?;
    eprintln!("SIDEBAR Settings GPU capture: {}", printed_path.display());
    Ok(())
}

pub(crate) async fn verify_native(
    source: WindowHandle<HerdrWindow>,
    cx: &mut AsyncApp,
) -> Result<()> {
    #[cfg(feature = "mockup")]
    let capture = std::env::var_os("HERDR_TEST_SETTINGS_CAPTURE").map(std::path::PathBuf::from);
    let before = source.update(cx, |view, _, _| view.input_probe)?;
    AnyWindowHandle::from(source).update(cx, |_, window, cx| -> Result<()> {
        window.draw(cx).clear(cx);
        ensure!(
            window.dispatch_keystroke(Keystroke::parse("cmd-,")?, cx),
            "Settings shortcut was not handled"
        );
        Ok(())
    })??;
    let deadline = Instant::now() + Duration::from_secs(3);
    let settings = loop {
        let settings = cx.update(|cx| {
            cx.windows()
                .into_iter()
                .find_map(|window| window.downcast::<SettingsWindow>())
        });
        if let Some(settings) = settings
            && settings.update(cx, |view, _, _| !view.loading)?
        {
            break settings;
        }
        ensure!(
            Instant::now() < deadline,
            "standalone Settings open/load timed out"
        );
        cx.background_executor()
            .timer(Duration::from_millis(10))
            .await;
    };
    settings.update(cx, |view, window, _| -> Result<()> {
        ensure!(
            view.error.is_none() && !view.saving && view.focus.is_focused(window),
            "Settings load/focus mismatch: {:?}",
            view.error
        );
        Ok(())
    })??;
    let source_actions = source.update(cx, |view, _, _| view.input_probe.actions)?;

    for expected in [size(px(680.), px(560.)), size(px(960.), px(780.))] {
        settings.update(cx, |_, window, _| window.resize(expected))?;
        let deadline = Instant::now() + Duration::from_secs(2);
        while !settings.update(cx, |_, window, _| window.viewport_size() == expected)? {
            ensure!(
                Instant::now() < deadline,
                "Settings resize to {expected:?} timed out"
            );
            cx.background_executor()
                .timer(Duration::from_millis(10))
                .await;
        }
        for (index, section) in Section::ALL.iter().copied().enumerate() {
            let (target, bounds) =
                AnyWindowHandle::from(settings).update(cx, |_, window, cx| -> Result<_> {
                    window.draw(cx).clear(cx);
                    let bounds = cx.global::<Layout>().0[index]
                        .context("missing Settings category paint")?;
                    Ok((Target::acquire(window)?, bounds))
                })??;
            target.click(
                f64::from(f32::from(bounds.center().x)),
                f64::from(f32::from(bounds.center().y)),
            )?;
            let deadline = Instant::now() + Duration::from_secs(2);
            while !settings.update(cx, |view, _, _| view.section == section)? {
                ensure!(
                    Instant::now() < deadline,
                    "native category click {section:?} timed out"
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
                let body = view.body_scroll.bounds();
                ensure!(
                    (body.left() - px(184.)).abs() < px(1.)
                        && (body.right() - expected.width).abs() < px(1.),
                    "Settings body width at {expected:?}/{section:?}: {body:?}"
                );
                ensure!(
                    body.top() >= px(crate::titlebar::HEIGHT)
                        && body.bottom() <= expected.height - px(36.)
                        && body.size.height > px(400.),
                    "Settings body height: {body:?}"
                );
                let mut bottom = px(crate::titlebar::HEIGHT);
                for (index, bounds) in cx.global::<Layout>().0[..Section::ALL.len()]
                    .iter()
                    .enumerate()
                {
                    let bounds = bounds.context("unpainted sidebar category")?;
                    ensure!(
                        bounds.left() >= px(0.)
                            && bounds.right() <= body.left()
                            && bounds.top() >= bottom
                            && bounds.bottom() <= body.bottom()
                            && bounds.size.height >= px(35.),
                        "Settings category {index} clipped/overlapped: {bounds:?}"
                    );
                    bottom = bounds.bottom();
                }
                ensure!(!view.saving, "navigation started a settings write");
                Ok(())
            })??;
            if section == Section::Fonts {
                verify_fonts(settings, source, expected, cx).await?;
            }
            #[cfg(feature = "mockup")]
            if section == Section::Appearance
                && std::env::var_os("HERDR_TEST_SETTINGS_CAPTURE").is_some()
            {
                let offset = settings.update(cx, |view, _, cx| -> Result<_> {
                    let card =
                        cx.global::<Layout>().0[7].context("missing Sidebar layout paint")?;
                    Ok(f32::from(card.top() - view.body_scroll.bounds().top()) - 28.)
                })??;
                let captures: &[(f32, &str)] = if expected.width == px(960.) {
                    &[(0., "sidebar-normal.png")]
                } else {
                    &[
                        (0., "sidebar-narrow-list.png"),
                        (480., "sidebar-narrow-preview.png"),
                    ]
                };
                for &(extra, extension) in captures {
                    settings.update(cx, |view, _, cx| {
                        view.body_scroll
                            .set_offset(point(px(0.), px(-offset - extra)));
                        cx.notify();
                    })?;
                    capture_settings(settings, extension, cx).await?;
                }
                settings.update(cx, |view, _, cx| {
                    view.body_scroll.set_offset(Point::default());
                    cx.notify();
                })?;
            }
            if section == Section::Appearance {
                let columns = if expected.width == px(960.) { 4 } else { 2 };
                if columns == 2 {
                    settings.update(cx, |view, _, cx| {
                        view.body_scroll.set_offset(point(px(0.), px(-250.)));
                        cx.notify();
                    })?;
                }
                let deadline = Instant::now() + Duration::from_secs(3);
                loop {
                    let ready = AnyWindowHandle::from(settings).update(
                        cx,
                        |root, window, cx| -> Result<_> {
                            window.draw(cx).clear(cx);
                            let view = root
                                .downcast::<SettingsWindow>()
                                .map_err(|_| anyhow::anyhow!("unexpected Settings root"))?;
                            let view = view.read(cx);
                            let cards = view.native_theme_cards(cx);
                            // The unfiltered catalog scrolls to the saved theme.
                            let first = cards
                                .iter()
                                .map(|card| card.0)
                                .filter(|index| index % columns == 0)
                                .min()
                                .unwrap_or(0);
                            let bounds: Option<Vec<_>> = (first..=first + columns)
                                .map(|index| {
                                    cards.iter().find(|card| card.0 == index).map(|card| card.1)
                                })
                                .collect();
                            let Some(bounds) = bounds.filter(|_| !view.busy()) else {
                                return Ok(false);
                            };
                            // The outer body may clip the grid at the narrow size.
                            // Check row geometry, not containment in that viewport.
                            for pair in bounds[..columns].windows(2) {
                                ensure!(
                                    (pair[0].top() - pair[1].top()).abs() < px(1.)
                                        && pair[0].right() < pair[1].left()
                                        && pair[0].size.width > px(0.),
                                    "Settings grid is not {columns} columns at {expected:?}: {bounds:?}"
                                );
                            }
                            ensure!(
                                (bounds[columns].left() - bounds[0].left()).abs() < px(1.)
                                    && bounds[columns].top() >= bounds[0].bottom(),
                                "Settings grid card {columns} did not wrap at {expected:?}: {bounds:?}"
                            );
                            Ok(true)
                        },
                    )??;
                    if ready {
                        break;
                    }
                    ensure!(
                        Instant::now() < deadline,
                        "Settings grid geometry did not settle at {expected:?}"
                    );
                    cx.background_executor()
                        .timer(Duration::from_millis(10))
                        .await;
                }
            }
        }
    }
    let (filtered, unfiltered) = verify_themes(
        settings,
        source,
        #[cfg(feature = "mockup")]
        capture,
        cx,
    )
    .await?;
    source.update(cx, |view, window, _| -> Result<()> {
        let after = view.input_probe;
        if view.menu.page.is_some()
            || !view.focus.is_focused(window)
            || before.text != after.text
            || before.keys != after.keys
            || source_actions != after.actions
            || view.native_settings_save_in_flight()
        {
            bail!("Settings affected source input/focus or started a save");
        }
        Ok(())
    })??;
    eprintln!(
        "SIDEBAR native standalone settings PASS: all 7 category clicks and bounds at 680x560/960x780, 2/4-column theme grid, native Nord search {filtered}/{unfiltered} and clear, native Nord card click, singleton Cmd-comma, isolated Cmd-W; theme draft live across windows without config writes; final theme persisted on close in sandbox"
    );
    Ok(())
}
