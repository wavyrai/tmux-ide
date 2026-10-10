//! Native event-dispatch + scene-construction benchmark; never connects to a daemon.
use crate::{HerdrWindow, sidebar, smoke};
use anyhow::{Context as _, Result, anyhow, bail};
use gpui::*;
use herdr_client::protocol::*;
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
#[cfg(target_os = "macos")]
#[path = "performance_native.rs"]
mod native;

#[derive(Default, Debug, Clone, Copy)]
pub(crate) struct Counts {
    pub shapes: usize,
    pub quads: usize,
    pub glyphs: usize,
    /// Cell-geometry paths, such as prompt separators.
    pub paths: usize,
    pub decorations: usize,
    pub paint_errors: usize,
    pub metric_shapes: usize,
    pub paints: usize,
    pub sidebar_renders: usize,
}
impl Global for Counts {}

fn surface() -> PaneSurfaceFrame {
    let lines = [
        "$ cargo test --workspace  # verify sidebar rendering and terminal grid",
        "Inspecting src/main.rs: cached transcript paint, unchanged cells, exact colors.",
        "  pub fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) {",
        "+ assert_eq!(actual, expected); // regression coverage for agent output",
        "test terminal::tests::wire_colors_are_not_argb ... ok (1256789 tokens)",
        "Review: preserve wide glyphs, combining marks, cursor and popup positioning.",
    ];
    let cells = (0..8000)
        .map(|i| {
            let row = i / 160;
            let col = i % 160;
            let line = lines[row % lines.len()].as_bytes();
            CellData {
                symbol: if col == 156 {
                    "\u{754c}".into()
                } else if col == 158 {
                    "e\u{301}".into()
                } else {
                    (line[col % line.len()] as char).to_string()
                },
                skip: col == 157,
                fg: [0, 0x0298c379, 0x01000067, 0x02e5c07b][row % 4],
                bg: if row % 7 == 0 { 0x02232b36 } else { 0 },
                modifier: [0, 1, 4, 8, 256, 2, 64, 128][row % 8],
                hyperlink: None,
            }
        })
        .collect();
    PaneSurfaceFrame {
        boot_id: "layout-test".into(),
        projection_revision: 1,
        surface_revision: 1,
        frame: FrameData {
            width: 160,
            height: 50,
            cells,
            cursor: Some(CursorState {
                x: 12,
                y: 25,
                visible: true,
                shape: 5,
            }),
            hyperlinks: vec![],
            graphics: vec![],
        },
        panes: vec![],
        splits: vec![],
        popup: None,
        graphics: Default::default(),
    }
}

fn report(label: &str, samples: &mut [f64]) -> f64 {
    samples.sort_by(f64::total_cmp);
    let percentile = |p: usize| samples[(samples.len() * p).div_ceil(100).saturating_sub(1)];
    eprintln!(
        "PERF {label} n={} ms p50={:.3} p95={:.3} max={:.3}",
        samples.len(),
        percentile(50),
        percentile(95),
        samples[samples.len() - 1]
    );
    percentile(95)
}

pub fn start(handle: WindowHandle<HerdrWindow>, cx: &mut App) {
    // AppKit termination can exit(0) inside cx.quit(), before main returns its
    // ExitCode. This daemon-free driver must exit explicitly on pass AND fail.
    smoke::EXIT_CODE.store(1, std::sync::atomic::Ordering::SeqCst);
    let uncached = std::env::var_os("HERDR_PERF_UNCACHED").is_some();
    let budget = match std::env::var("HERDR_PERF_P95_MS") {
        Ok(value) => value.parse::<f64>().unwrap_or(f64::NAN),
        Err(std::env::VarError::NotPresent) => {
            if cfg!(debug_assertions) {
                1000.
            } else {
                250.
            }
        }
        Err(_) => f64::NAN,
    };
    if budget.is_nan() || budget < 0. {
        eprintln!("HERDR_PERF_P95_MS must be nonnegative milliseconds or inf");
        std::process::exit(2);
    }
    eprintln!(
        "PERF mode={} profile={} p95_budget_ms={budget}",
        if uncached { "reference" } else { "cached" },
        if cfg!(debug_assertions) {
            "debug"
        } else {
            "release"
        }
    );
    let timer = cx.background_executor().clone();
    cx.spawn(async move |cx| {
        let mut cold = vec![];
        let mut cache_cold = vec![];
        let mut hover = vec![];
        let mut scroll = vec![];
        for frame in 0..141 {
            timer.timer(Duration::from_millis(20)).await;
            let prepared = AnyWindowHandle::from(handle).update(cx, |root, window, cx| {
                if (1..=10).contains(&frame) {
                    root.downcast::<HerdrWindow>()
                        .map_err(|_| anyhow!("unexpected root"))?
                        .update(cx, |view, _| {
                            view.painter.borrow_mut().reset_cache();
                        });
                }
                *cx.default_global::<Counts>() = Counts::default();
                Ok::<_, anyhow::Error>(
                    if frame > 110 {
                        window.viewport_size().height.to_f64() / 2.
                    } else {
                        0.
                    } + 60.
                        + (frame % 5) as f64 * 40.,
                )
            });
            let Ok(Ok(y)) = prepared else {
                eprintln!("PERF FAIL preparing frame: {prepared:?}");
                std::process::exit(1);
            };
            let start = Instant::now();
            #[cfg(target_os = "macos")]
            if frame > 0
                && let Err(error) = native::dispatch(
                    y,
                    (frame > 80).then_some(if frame % 20 < 10 { -32 } else { 32 }),
                )
            {
                eprintln!("PERF FAIL: {error:#}");
                std::process::exit(1);
            }
            let result =
                AnyWindowHandle::from(handle).update(cx, |root, window, cx| -> Result<()> {
                    if frame == 0 {
                        let mut snapshot = sidebar::layout_tests::snapshot(40);
                        let agent = snapshot.agents[0].clone();
                        snapshot.agents = (0..40)
                            .map(|i| {
                                let mut a = agent.clone();
                                a.pane_id = format!("perf-p{i}");
                                a.name = Some(format!("Review transcript {i}"));
                                a
                            })
                            .collect();
                        root.clone()
                            .downcast::<HerdrWindow>()
                            .map_err(|_| anyhow!("unexpected root"))?
                            .update(cx, |view, cx| {
                                view.live.snapshot = Some(Arc::new(snapshot));
                                view.live.surface = Some(Arc::new(surface()));
                                view.painter.borrow_mut().uncached = uncached;
                                cx.notify();
                            });
                        window.resize(size(px(1640.), px(1100.)));
                    }
                    window.refresh();
                    window.draw(cx).clear(cx);
                    let elapsed = start.elapsed().as_secs_f64() * 1000.;
                    let counts = *cx.global::<Counts>();
                    if frame > 0
                        && (window.mouse_position().x != px(100.)
                            || (window.mouse_position().y.to_f64() - y).abs() > 1.)
                    {
                        bail!(
                            "native hover missed: {:?}, expected y={y}",
                            window.mouse_position()
                        );
                    }
                    if frame == 89 || frame == 129 {
                        let view = root
                            .clone()
                            .downcast::<HerdrWindow>()
                            .map_err(|_| anyhow!("unexpected root"))?;
                        let list = usize::from(frame > 110);
                        let offset = view.read(cx).sidebar_scroll[list].offset();
                        eprintln!("PERF native scroll list={list} offset={offset:?}");
                        if offset.y >= px(0.) {
                            bail!("native scroll did not move workspace list");
                        }
                    }
                    if counts.glyphs < 6000 || counts.paint_errors != 0 {
                        bail!("text was not painted: {counts:?}");
                    }
                    if !uncached {
                        if frame > 20 && (counts.shapes != 0 || counts.metric_shapes != 0) {
                            bail!("unchanged terminal reshaped: {counts:?}");
                        }
                        if counts.shapes > 400
                            || counts.paints == 0
                            || counts.quads != 50 * counts.paints
                            || counts.decorations != 1921 * counts.paints
                            || counts.glyphs != 6981 * counts.paints
                        {
                            bail!("terminal deterministic budget: {counts:?}");
                        }
                    }
                    if frame == 0 {
                        cold.push(elapsed);
                    } else if frame <= 10 {
                        cache_cold.push(elapsed);
                    } else if frame > 20 && frame <= 80 {
                        hover.push(elapsed);
                    } else if frame > 80 {
                        scroll.push(elapsed);
                    }
                    if frame == 0 || frame == 80 || frame == 140 {
                        eprintln!(
                            "PERF frame={frame} {counts:?} viewport={:?}",
                            window.viewport_size()
                        );
                    }
                    if frame == 140 && !uncached {
                        let view = root
                            .downcast::<HerdrWindow>()
                            .map_err(|_| anyhow!("unexpected root"))?;
                        let verified =
                            view.read(cx).painter.borrow().verify_native_cache(window)?;
                        // Every symbol of the fixture in each face it is drawn in;
                        // color is not part of a glyph's shape.
                        if verified < 140 {
                            bail!("insufficient native cache coverage: {verified}");
                        }
                        eprintln!("PERF native cached/fresh glyph layouts identical: {verified}");
                        // Outside timing: a changed cell and centered popup must use the
                        // same cache without freezing content or reusing absolute positions.
                        view.update(cx, |view, _| -> Result<()> {
                            let surface = Arc::make_mut(
                                view.live
                                    .surface
                                    .as_mut()
                                    .context("missing fixture surface")?,
                            );
                            surface.frame.cells[0].fg = 0x02ff55ee;
                            surface.popup = Some(Box::new(ClientShellPopupSurface {
                                terminal_id: "perf-popup".into(),
                                title: "Review".into(),
                                width: None,
                                height: None,
                                mouse_reporting: false,
                                sgr_pixel_mouse: false,
                                pixel_width: 0,
                                pixel_height: 0,
                                frame: FrameData {
                                    width: 20,
                                    height: 4,
                                    cells: surface.frame.cells[..80].to_vec(),
                                    cursor: Some(CursorState {
                                        x: 1,
                                        y: 1,
                                        visible: true,
                                        shape: 3,
                                    }),
                                    hyperlinks: vec![],
                                    graphics: vec![],
                                },
                            }));
                            Ok(())
                        })?;
                        for redraw in 0..2 {
                            *cx.default_global::<Counts>() = Counts::default();
                            window.refresh();
                            window.draw(cx).clear(cx);
                            let c = cx.global::<Counts>();
                            if c.quads != 54
                                || c.decorations != 1922
                                || c.glyphs <= 6981
                                || c.paint_errors != 0
                                || (redraw == 1 && c.shapes != 0)
                            {
                                bail!("popup redraw {redraw}: {c:?}");
                            }
                        }
                        view.read(cx).painter.borrow().verify_native_cache(window)?;
                        eprintln!(
                            "PERF native changed-cell + centered popup + underline cursor verified"
                        );
                    }
                    Ok(())
                });
            if !matches!(result, Ok(Ok(()))) {
                eprintln!("PERF FAIL: {result:?}");
                std::process::exit(1);
            }
        }
        // Terminal output: a surface-only update redraws the window while the
        // cached sidebar keeps its layout. Alternate frames refresh the whole
        // window, as every update did before, for comparison in the same run.
        let mut terminal = vec![];
        let mut terminal_full = vec![];
        for step in 0..120_usize {
            timer.timer(Duration::from_millis(20)).await;
            let full = step % 2 == 1;
            let result =
                AnyWindowHandle::from(handle).update(cx, |root, window, cx| -> Result<f64> {
                    let view = root
                        .downcast::<HerdrWindow>()
                        .map_err(|_| anyhow!("unexpected root"))?;
                    view.update(cx, |view, cx| -> Result<()> {
                        let surface = Arc::make_mut(
                            view.live
                                .surface
                                .as_mut()
                                .context("missing fixture surface")?,
                        );
                        surface.popup = None;
                        let cell = &mut surface.frame.cells[step % 160];
                        cell.fg = if cell.fg == 0x02ff55ee { 0 } else { 0x02ff55ee };
                        view.redraw_terminal(cx);
                        Ok(())
                    })?;
                    if full {
                        window.refresh();
                    }
                    *cx.default_global::<Counts>() = Counts::default();
                    let start = Instant::now();
                    window.draw(cx).clear(cx);
                    let elapsed = start.elapsed().as_secs_f64() * 1000.;
                    let counts = *cx.global::<Counts>();
                    if counts.paints != 1
                        || counts.glyphs != 6981
                        || counts.paint_errors != 0
                        || (!uncached && counts.shapes != 0)
                        || counts.sidebar_renders != usize::from(full)
                    {
                        bail!("terminal redraw (full={full}): {counts:?}");
                    }
                    Ok(elapsed)
                });
            match result {
                Ok(Ok(elapsed)) if full => terminal_full.push(elapsed),
                Ok(Ok(elapsed)) => terminal.push(elapsed),
                result => {
                    eprintln!("PERF FAIL: {result:?}");
                    std::process::exit(1);
                }
            }
        }
        report("first-content", &mut cold);
        report("cache-cold", &mut cache_cold);
        report("terminal-full-window", &mut terminal_full);
        let p95 = report("warm-hover", &mut hover)
            .max(report("warm-scroll", &mut scroll))
            .max(report("warm-terminal", &mut terminal));
        if p95 <= budget {
            eprintln!("PERF PASS p95_budget_ms={budget}");
            std::process::exit(0);
        } else {
            eprintln!("PERF FAIL p95_budget_ms={budget}");
            std::process::exit(1);
        }
    })
    .detach();
}
