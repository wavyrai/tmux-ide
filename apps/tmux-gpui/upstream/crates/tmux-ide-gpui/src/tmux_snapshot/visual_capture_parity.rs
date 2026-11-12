//! Dev-only pixel parity for the terminal painter's glyph path: each case is
//! painted once through `Window::paint_glyph` per glyph (the legacy path) and
//! once through the batched sprites, offscreen on real Metal and the real
//! text system, and the two screenshots must match byte for byte. Built only
//! with `visual-capture`; run through `examples/glyph_parity.rs`.
use crate::config::Theme;
use crate::terminal::{BOLD, ITALIC, STRIKETHROUGH, UNDERLINE};
use crate::terminal_painter::{ImageTarget, NativeFrame, PlacedImages, TerminalPainter};
use anyhow::{Context as _, anyhow};
use gpui::*;
use herdr_client::{
    SurfaceImages,
    protocol::{
        CellData, CursorState, SurfaceGraphicsAsset, SurfaceGraphicsAssetKey,
        SurfaceGraphicsFormat, SurfaceGraphicsPlacement, SurfaceGraphicsSource,
        SurfaceGraphicsTarget,
    },
};
use std::{cell::RefCell, path::Path, rc::Rc, sync::Arc};

const LINES: [&str; 9] = [
    "fn main() { println!(\"hello, world\"); } // ascii",
    "Compiling tmux-ide-gpui v0.1.17 (bold italic below)",
    "wide: 界面 テスト 한국어 ｶﾞ and emoji: 🙂🚀✅ 👍🏽 🇳🇱",
    "box: ┌──┬──┐ ║ ▛▀▜ ░▒▓ powerline:  ",
    "underline and strike through, then dim/rev",
    "colours: red green blue 256 truecolor",
    "    indented text after spaces    and tabs",
    "ligature-ish: -> => != === <= >= :: ..",
    "accents: café naïve Ωμέγα привет עברית",
];

fn cells(cols: usize) -> Vec<Arc<[CellData]>> {
    LINES
        .iter()
        .enumerate()
        .map(|(y, line)| {
            let mut row = Vec::with_capacity(cols);
            for (x, ch) in line.chars().enumerate() {
                if row.len() >= cols {
                    break;
                }
                let modifier = match y {
                    1 => [0, BOLD, ITALIC, BOLD | ITALIC][x % 4],
                    4 if x < 20 => UNDERLINE,
                    4 if x < 34 => STRIKETHROUGH,
                    4 => [1 << 1, 1 << 6][x % 2],
                    _ => 0,
                };
                let fg = match y {
                    5 => [
                        0x0100_0001,
                        0x0100_0002,
                        0x0100_0004,
                        0x0100_00c4,
                        0x02ff_8800,
                    ][x % 5],
                    _ if x % 11 == 3 => 0x0240_a0ff,
                    _ => 0,
                };
                let bg = if y == 6 && x % 9 == 0 { 0x0100_0005 } else { 0 };
                row.push(CellData {
                    symbol: ch.to_string(),
                    fg,
                    bg,
                    modifier,
                    skip: false,
                    hyperlink: None,
                });
                let wide = unicode_width::UnicodeWidthChar::width(ch) == Some(2);
                if wide && row.len() < cols {
                    row.push(CellData {
                        symbol: String::new(),
                        fg,
                        bg,
                        modifier: 0,
                        skip: true,
                        hyperlink: None,
                    });
                }
            }
            row.resize_with(cols, || CellData {
                symbol: " ".into(),
                fg: 0,
                bg: 0,
                modifier: 0,
                skip: false,
                hyperlink: None,
            });
            Arc::from(row)
        })
        .collect()
}

struct Case {
    name: &'static str,
    theme: Theme,
    background: WindowBackgroundAppearance,
    cell_height: f32,
    origin: Point<Pixels>,
    images: bool,
    /// Earlier frames show the rows one line lower, so retained rows are
    /// queued again at another height in the captured frame.
    scrolled: bool,
}

fn cases() -> Vec<Case> {
    let dark = Theme::default();
    let light = Theme {
        background: 0xfbfbf8,
        foreground: 0x1c1c1c,
        ..Theme::default()
    };
    let mut out = Vec::new();
    for (theme_name, theme) in [("dark", dark), ("light", light)] {
        for (bg_name, background) in [
            ("opaque", WindowBackgroundAppearance::Opaque),
            ("transparent", WindowBackgroundAppearance::Transparent),
        ] {
            for (h_name, cell_height, origin) in [
                ("h20", 20., point(px(12.), px(8.))),
                ("h17.35", 17.35, point(px(12.3), px(7.7))),
            ] {
                for (images, scrolled) in
                    [(false, false), (true, false), (false, true), (true, true)]
                {
                    let name: &'static str = Box::leak(
                        format!(
                            "{theme_name}-{bg_name}-{h_name}{}{}",
                            if images { "-images" } else { "" },
                            if scrolled { "-scrolled" } else { "" }
                        )
                        .into_boxed_str(),
                    );
                    out.push(Case {
                        name,
                        theme: theme.clone(),
                        background,
                        cell_height,
                        origin,
                        images,
                        scrolled,
                    });
                }
            }
        }
    }
    out
}

fn image_key(image_id: u32) -> SurfaceGraphicsAssetKey {
    SurfaceGraphicsAssetKey {
        source: SurfaceGraphicsSource::Terminal {
            target: SurfaceGraphicsTarget::Pane {
                pane_id: "p1".into(),
            },
            image_id,
        },
        image_width: 2,
        image_height: 2,
        format: SurfaceGraphicsFormat::Rgba,
        data_len: 16,
        data_fingerprint: u64::from(image_id),
    }
}

fn placement(key: &SurfaceGraphicsAssetKey, x: u16, y: u16, z: i32) -> SurfaceGraphicsPlacement {
    SurfaceGraphicsPlacement {
        asset: key.clone(),
        logical_placement_id: u32::from(x) + 1,
        x,
        y,
        cols: 6,
        rows: 2,
        source_x: 0,
        source_y: 0,
        source_width: 0,
        source_height: 0,
        x_offset: 0,
        y_offset: 0,
        z,
        scrollback_offset: 0,
    }
}

/// Paints `case` with the legacy or batched glyph path and returns the
/// screenshot.
fn render(cx: &mut VisualTestAppContext, case: &Case, legacy: bool) -> Result<image::RgbaImage> {
    const COLS: usize = 60;
    let rows = cells(COLS);
    let mut earlier = rows.clone();
    earlier.rotate_right(1);
    let earlier = Arc::new(NativeFrame {
        rows: earlier,
        width: COLS as u16,
        height: LINES.len() as u16,
        cursor: None,
    });
    let frame = Arc::new(NativeFrame {
        rows,
        width: COLS as u16,
        height: LINES.len() as u16,
        cursor: Some(CursorState {
            x: 7,
            y: 2,
            visible: true,
            shape: 2,
        }),
    });
    let (below, above) = (image_key(1), image_key(2));
    let images: Arc<SurfaceImages> = Arc::new(
        [(&below, [255u8, 0, 0, 255]), (&above, [0, 0, 255, 128])]
            .into_iter()
            .map(|(key, pixel)| SurfaceGraphicsAsset {
                key: key.clone(),
                data: pixel.repeat(4),
            })
            .collect(),
    );
    let placements: Arc<[SurfaceGraphicsPlacement]> =
        Arc::from([placement(&below, 2, 0, -1), placement(&above, 20, 2, 5)]);
    let painter = Rc::new(RefCell::new(TerminalPainter::default()));
    {
        let mut painter = painter.borrow_mut();
        painter.set_appearance(14., case.cell_height, case.theme.clone());
        painter.legacy_glyphs = legacy;
    }
    let (origin, with_images, background, scrolled) = (
        case.origin,
        case.images,
        case.theme.background,
        case.scrolled,
    );
    let handle = cx.update(|cx| {
        cx.open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(Bounds {
                    origin: point(px(-10000.), px(-10000.)),
                    size: size(px(640.), px(220.)),
                })),
                window_background: case.background,
                focus: false,
                show: false,
                ..Default::default()
            },
            |_, cx| {
                cx.new(|_| Painted {
                    painter: painter.clone(),
                    frame: if scrolled {
                        earlier.clone()
                    } else {
                        frame.clone()
                    },
                    origin,
                    images: with_images.then(|| (images.clone(), placements.clone())),
                    background,
                })
            },
        )
    })?;
    // Image decodes finish off the main thread; later frames paint them.
    for _ in 0..4 {
        cx.run_until_parked();
        cx.update_window(handle.into(), |_, window, _| window.refresh())?;
    }
    if scrolled {
        cx.update_window(handle.into(), |root, window, cx| {
            if let Ok(view) = root.downcast::<Painted>() {
                view.update(cx, |view, _| view.frame = frame.clone());
            }
            window.refresh();
        })?;
        for _ in 0..2 {
            cx.run_until_parked();
            cx.update_window(handle.into(), |_, window, _| window.refresh())?;
        }
    }
    cx.run_until_parked();
    // The macOS window never draws subpixel sprites (its
    // `is_subpixel_rendering_supported` is false, and the Metal renderer has
    // no pass for them), so `GlyphKind::Subpixel` is never resolved and these
    // cases can't compare its pixels. If a GPUI update turns it on, fail
    // here rather than pass without covering it.
    let subpixel = cx.update_window(handle.into(), |_, window, _| {
        window.glyph_raster_state().subpixel_supported
    })?;
    if subpixel {
        return Err(anyhow!(
            "{}: this window draws subpixel sprites, which no parity case covers yet",
            case.name
        ));
    }
    let image = cx.capture_screenshot(handle.into())?;
    cx.update_window(handle.into(), |_, window, _| window.remove_window())?;
    cx.run_until_parked();
    Ok(image)
}

type Images = (Arc<SurfaceImages>, Arc<[SurfaceGraphicsPlacement]>);

struct Painted {
    painter: Rc<RefCell<TerminalPainter>>,
    frame: Arc<NativeFrame>,
    origin: Point<Pixels>,
    images: Option<Images>,
    background: u32,
}

impl Render for Painted {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        let (painter, frame, origin, images) = (
            self.painter.clone(),
            self.frame.clone(),
            self.origin,
            self.images.clone(),
        );
        div().size_full().bg(rgb(self.background)).child(
            canvas(
                |_, _, _| (),
                move |_, _, window, cx| {
                    let font = font("Menlo");
                    let mut painter = painter.borrow_mut();
                    let width = painter.cell_width(&font, window, cx);
                    painter.paint_view(
                        (&*frame).into(),
                        origin,
                        None,
                        width,
                        &font,
                        &[],
                        &[],
                        None,
                        images.as_ref().map(|(images, placements)| PlacedImages {
                            placements,
                            images,
                            target: ImageTarget::Main,
                            cell_pixels: None,
                        }),
                        window,
                        cx,
                    );
                },
            )
            .size_full(),
        )
    }
}

/// Renders every case both ways; returns one line per case, and writes both
/// screenshots of any case that differs to `dir`.
#[doc(hidden)]
pub fn glyph_parity(dir: &Path) -> Result<Vec<String>> {
    let mut cx = VisualTestAppContext::with_asset_source(
        gpui_platform::current_platform(false),
        Arc::new(crate::icons::Icons),
    );
    let mut lines = Vec::new();
    let mut failed = 0;
    for case in cases() {
        let legacy = render(&mut cx, &case, true)?;
        let hits = crate::terminal_painter::ROW_HITS.load(std::sync::atomic::Ordering::Relaxed);
        let batched = render(&mut cx, &case, false)?;
        let hits =
            crate::terminal_painter::ROW_HITS.load(std::sync::atomic::Ordering::Relaxed) - hits;
        // The batched path without retained rows: the frame a row's first
        // paint draws, which the retained frames above never show.
        let retain = &crate::terminal_painter::RETAIN_ROWS;
        retain.store(false, std::sync::atomic::Ordering::Relaxed);
        let unretained = render(&mut cx, &case, false);
        retain.store(true, std::sync::atomic::Ordering::Relaxed);
        let unretained = unretained?;
        let differing = legacy
            .pixels()
            .zip(batched.pixels())
            .filter(|(a, b)| a != b)
            .count();
        let same = legacy.dimensions() == batched.dimensions()
            && legacy.as_raw() == batched.as_raw()
            && legacy.as_raw() == unretained.as_raw();
        let inked = legacy
            .pixels()
            .filter(|p| p.0 != legacy.get_pixel(0, 0).0)
            .count();
        lines.push(format!(
            "{:<40} {}x{} identical={same} differing_pixels={differing} non_background_pixels={inked} retained_row_hits={hits}",
            case.name,
            legacy.width(),
            legacy.height(),
        ));
        if !same {
            failed += 1;
            for (suffix, image) in [
                ("legacy", &legacy),
                ("batched", &batched),
                ("unretained", &unretained),
            ] {
                let path = dir.join(format!("{}-{suffix}.png", case.name));
                image
                    .save_with_format(&path, image::ImageFormat::Png)
                    .with_context(|| format!("save {}", path.display()))?;
            }
        }
    }
    if failed > 0 {
        return Err(anyhow!("{failed} case(s) differ:\n{}", lines.join("\n")));
    }
    lines.push(
        "subpixel sprites: no window here draws them (checked per case), so that branch has no pixels to compare"
            .into(),
    );
    Ok(lines)
}
