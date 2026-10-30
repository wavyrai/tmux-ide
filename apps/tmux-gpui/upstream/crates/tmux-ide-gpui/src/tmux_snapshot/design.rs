//! Bezel-derived native component tokens. See BEZEL-NOTICE.md for provenance.
//! These colors belong to chrome; never use them to recolor canonical terminal cells.
use crate::{config::Theme, contrast::Contrast};
use gpui::*;

/// The tmux theme as the one Bezel palette. The terminal's background, surface,
/// text, cursor, selection and 16 ANSI colours are taken as they are; every
/// other grey in Bezel's palette for that appearance is tinted to the surface's
/// hue, so overlays and controls sit in the same family as the shell.
pub(crate) fn palette(theme: &Theme) -> bezel_theme::Theme {
    use bezel_theme::{Appearance, Brand, Ink, Tint};
    let appearance = if crate::contrast::luminance(theme.background) < 0.5 {
        Appearance::Dark
    } else {
        Appearance::Light
    };
    let high = theme.contrast == Contrast::High;
    let (hue, chroma) = oklch_hue_chroma(theme.surface);
    let brand = Brand {
        tint: Tint::new(hue, chroma),
        ink: if high { Ink::ACCESSIBLE } else { Ink::APPKIT },
        ..Default::default()
    };
    let mut result = bezel_theme::Theme::for_appearance(appearance);
    brand.apply(&mut result);
    let color = |value: u32| -> Hsla { rgb(value).into() };
    result.bg = color(theme.background);
    result.terminal_bg = color(theme.background);
    // What a pane card fills with when the window is frosted: the terminal's
    // own background, not Bezel's grey, so panes stay the theme's colour.
    result.content_background = color(theme.background);
    result.surface = color(theme.surface);
    // Terminal panes stay opaque under frosted chrome (owner, #666).
    result.content_opacity = 1.0;
    // The frost is the theme's own surface at Bezel's coverage; text drawn on
    // it goes through `chrome_text`.
    result.vibrancy_tone = color(theme.surface);
    result.vibrancy_alpha = frost_alpha(theme);
    result.cursor = color(theme.cursor);
    result.caret = color(theme.cursor);
    result.selection = color(theme.active);
    for (slot, value) in result.terminal_ansi.iter_mut().zip(theme.palette) {
        *slot = color(value);
    }
    // A foreground that can't be read on its own background (a half-edited
    // theme) keeps Bezel's ink rather than taking the chrome down with it.
    let foreground_reads = bezel_theme::contrast_ratio(color(theme.foreground), result.bg) >= 4.5;
    if foreground_reads {
        result.text = color(theme.foreground);
        brand.ink.for_appearance(appearance).paint(&mut result);
    }
    // Body text is drawn on the background and on the surface. Where Bezel's
    // translucent ink drops it under 4.5:1 on either (the saturated presets,
    // Solarized), it becomes the opaque foreground with its lightness moved
    // just far enough to read; muted and faint keep their alphas.
    let chrome = [theme.background, theme.surface];
    let reads = |text: Hsla| {
        chrome.iter().all(|&plate| {
            let plate = color(plate);
            bezel_theme::contrast_ratio(bezel_theme::flatten(text, plate), plate) >= 4.5
        })
    };
    if !reads(result.text) {
        let opaque = Hsla {
            a: 1.0,
            ..result.text
        };
        let packed = u32::from(Rgba::from(opaque)) >> 8;
        result.text = color(crate::contrast::ink(packed, &chrome, 4.5));
    }
    // Bezel's translucent text roles paint the titlebar's tab labels on the
    // frost; where they miss 4.5:1 on it, they take the inked chrome colour.
    let plates = chrome_plates(theme);
    let reads = |text: Hsla| {
        plates.iter().all(|&plate| {
            let plate = color(plate);
            bezel_theme::contrast_ratio(bezel_theme::flatten(text, plate), plate) >= 4.5
        })
    };
    // Only for a theme whose own ink is in use; a half-edited one keeps
    // Bezel's, as above.
    if foreground_reads && !reads(result.text) {
        result.text = color(chrome_text(theme, theme.foreground));
    }
    if foreground_reads && !reads(result.text_muted) {
        result.text_muted = color(chrome_text(theme, theme.muted));
    }
    if high {
        result.glass = false;
        result.vibrancy = false;
    }
    result
}

/// `color` as text on the window chrome: moved only as far as it needs, hue
/// kept, to read at 4.5:1 on the opaque surface and, in a dark theme (the one
/// Bezel frosts), on the frost over a white and over a black desktop, since the
/// desktop behind a translucent window can be either.
pub(crate) fn chrome_text(theme: &Theme, color: u32) -> u32 {
    // Cached per colour and plates: the sidebar asks for every row, every frame.
    // 4.6 rather than 4.5: the plates are rounded to 8-bit channels here, and
    // the frost Bezel paints is not, which costs up to a few hundredths.
    crate::contrast::ink_on_chrome(color, chrome_plates(theme), 4.6)
}

/// What row text is inked to. Further over 4.5 than `chrome_text`'s 4.6: a
/// row's plates are two flattenings deep (wash over frost over desktop), and
/// rounding each to 8-bit channels moves a dark plate by enough to cost 0.1:1
/// against a saturated label (Amber's selected row measured 4.49 at 4.6).
const ROW_TARGET: f32 = 4.75;

/// `color` as text on a sidebar row: [`chrome_text`]'s rule, also over the
/// fills a row paints under it, the selected wash and the hover wash, on each
/// of the chrome plates. The current session's row is always selected, so
/// this is the most-read text in the sidebar.
pub(crate) fn row_text(theme: &Theme, color: u32) -> u32 {
    thread_local! {
        static CACHE: std::cell::RefCell<std::collections::HashMap<(u32, u32, u32), u32>> =
            Default::default();
    }
    let key = (color, theme.surface, theme.background);
    if let Some(inked) = CACHE.with(|cache| cache.borrow().get(&key).copied()) {
        return inked;
    }
    let inked = crate::contrast::ink(color, &row_plates(theme), ROW_TARGET);
    CACHE.with(|cache| {
        let mut cache = cache.borrow_mut();
        // A theme inks a handful of colours; a long session of theme switching
        // starts over rather than growing without bound.
        if cache.len() > 256 {
            cache.clear();
        }
        cache.insert(key, inked);
    });
    inked
}

/// The frost's coverage: Bezel's 0.80, raised just far enough that the
/// theme's foreground and muted text, inked, can still reach 4.6:1 on a
/// selected or hovered row over a white desktop. A light frost under a 12% light wash otherwise leaves no colour
/// that reads there (Nord's selected row topped out at 4.31:1).
fn frost_alpha(theme: &Theme) -> f32 {
    thread_local! {
        static CACHE: std::cell::RefCell<std::collections::HashMap<(u32, u32), f32>> =
            Default::default();
    }
    let key = (theme.surface, theme.background);
    if let Some(alpha) = CACHE.with(|cache| cache.borrow().get(&key).copied()) {
        return alpha;
    }
    let start = (bezel_theme::Theme::VIBRANCY_ALPHA * 100.).round() as u32;
    let dark = crate::contrast::luminance(theme.background) < 0.5;
    let alpha = (start..=100)
        .filter(|_| dark)
        .map(|step| step as f32 / 100.)
        .find(|&alpha| {
            let plates = row_plates_at(theme, alpha);
            [theme.foreground, theme.muted].iter().all(|&text| {
                let inked = crate::contrast::ink(text, &plates, ROW_TARGET);
                plates
                    .iter()
                    .all(|&plate| crate::contrast::ratio(inked, plate) >= ROW_TARGET)
            })
        })
        .unwrap_or(if dark {
            1.0
        } else {
            bezel_theme::Theme::VIBRANCY_ALPHA
        });
    CACHE.with(|cache| {
        let mut cache = cache.borrow_mut();
        if cache.len() > 256 {
            cache.clear();
        }
        cache.insert(key, alpha);
    });
    alpha
}

/// The chrome plates, bare and under a row's selected and hover washes.
fn row_plates(theme: &Theme) -> Vec<u32> {
    row_plates_at(theme, frost_alpha(theme))
}

fn row_plates_at(theme: &Theme, alpha: f32) -> Vec<u32> {
    let appearance = if crate::contrast::luminance(theme.background) < 0.5 {
        bezel_theme::Appearance::Dark
    } else {
        bezel_theme::Appearance::Light
    };
    let stock = bezel_theme::Theme::for_appearance(appearance);
    let pack = |c: Hsla| u32::from(Rgba::from(c)) >> 8;
    plates_at(theme, alpha)
        .into_iter()
        .flat_map(|plate| {
            let under: Hsla = rgb(plate).into();
            [
                plate,
                pack(bezel_theme::flatten(stock.card_selected_bg(), under)),
                pack(bezel_theme::flatten(stock.element_hover, under)),
            ]
        })
        .collect()
}

/// A sidebar row's label and caption colours, as `render_row` paints them.
pub(crate) fn row_ink(theme: &Theme) -> (u32, u32) {
    (
        row_text(theme, theme.foreground),
        row_text(theme, theme.muted),
    )
}

/// The attention badge's count, on its filled `theme.active` pill.
pub(crate) fn badge_text(theme: &Theme) -> u32 {
    crate::contrast::ink_on_chrome(theme.foreground, [theme.active; 3], 4.6)
}

/// A dialog's secondary text (`popover::dialog_body`'s role), inked on the
/// dialog card's opaque `surface_dialog`.
pub(crate) fn dialog_muted(theme: &Theme) -> Hsla {
    let card = palette(theme).surface_dialog;
    let pack = u32::from(Rgba::from(Hsla { a: 1.0, ..card })) >> 8;
    rgb(crate::contrast::ink_on_chrome(theme.muted, [pack; 3], 4.6)).into()
}

/// The text colours painted in the last draw, by probe key. Tests only.
#[cfg(test)]
#[derive(Default)]
pub(crate) struct InkProbes(pub std::collections::BTreeMap<String, Hsla>);
#[cfg(test)]
impl Global for InkProbes {}

/// In tests, a zero-size child that records the text colour its parent
/// paints with, under `key`, so a test can check the colour text is
/// actually drawn in rather than the value a helper returns. Nothing in a
/// build that isn't a test.
pub(crate) fn ink_probe(key: impl Fn() -> String + 'static) -> Option<AnyElement> {
    #[cfg(test)]
    {
        Some(
            canvas(
                |_, _, _| (),
                move |_, (), window, cx| {
                    if cx.has_global::<InkProbes>() {
                        let color = window.text_style().color;
                        cx.global_mut::<InkProbes>().0.insert(key(), color);
                    }
                },
            )
            .size_0()
            .into_any_element(),
        )
    }
    #[cfg(not(test))]
    {
        let _ = key;
        None
    }
}

/// The overlay every modal dialog sits in: Bezel's scrim over the whole
/// shell body, the card centred, occluding and swallowing presses and wheel
/// events so nothing under it reacts. One recipe instead of four
/// hand-written ones (audit 04 finding 4).
pub(super) fn dialog_overlay(id: &'static str, theme: &Theme) -> Stateful<Div> {
    div()
        .id(id)
        .debug_selector(move || id.into())
        .absolute()
        .inset_0()
        .size_full()
        .flex()
        .items_center()
        .justify_center()
        .bg(palette(theme).scrim())
        .occlude()
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .on_scroll_wheel(|_, _, cx| cx.stop_propagation())
}

/// The palette's text, inked on its opaque plate (`surface_overlay`) and on
/// the selected row's wash over it. The palette floats over live terminal
/// content, so its plate is opaque rather than glass (PM, #671 round 2), and
/// Bezel's deliberately faint popover roles are lifted to 4.5:1 on it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct PopoverInk {
    /// The plate itself, opaque.
    pub plate: Hsla,
    /// Row labels and the card's own text.
    pub text: Hsla,
    /// Headings, keycaps, legends, notes and disabled rows.
    pub muted: Hsla,
}

pub(crate) fn popover_ink(theme: &Theme) -> PopoverInk {
    let bezel = palette(theme);
    let plate = Hsla {
        a: 1.0,
        ..bezel.surface_overlay
    };
    let pack = |c: Hsla| u32::from(Rgba::from(c)) >> 8;
    let plates = [
        pack(plate),
        pack(bezel_theme::flatten(bezel.card_selected_bg(), plate)),
        pack(bezel_theme::flatten(bezel.element_hover, plate)),
    ];
    let ink =
        |color: u32| -> Hsla { rgb(crate::contrast::ink_on_chrome(color, plates, 4.6)).into() };
    PopoverInk {
        plate,
        text: ink(theme.foreground),
        muted: ink(theme.muted),
    }
}

/// What chrome text is drawn on: the opaque surface and, in a dark theme (the
/// one Bezel frosts), the frost over a white and over a black desktop.
fn chrome_plates(theme: &Theme) -> [u32; 3] {
    plates_at(theme, frost_alpha(theme))
}

fn plates_at(theme: &Theme, alpha: f32) -> [u32; 3] {
    let mut plates = [theme.surface; 3];
    if crate::contrast::luminance(theme.background) < 0.5 {
        let frost = Hsla {
            a: alpha,
            ..rgb(theme.surface).into()
        };
        let pack = |c: Hsla| u32::from(Rgba::from(c)) >> 8;
        plates[1] = pack(bezel_theme::flatten(frost, white()));
        plates[2] = pack(bezel_theme::flatten(frost, black()));
    }
    plates
}

/// The oklch hue (degrees) and chroma of a packed sRGB colour, which is what a
/// Bezel [`bezel_theme::Tint`] is made of.
fn oklch_hue_chroma(value: u32) -> (f32, f32) {
    let linear = |shift: u32| {
        let c = ((value >> shift) & 0xff) as f32 / 255.;
        if c <= 0.04045 {
            c / 12.92
        } else {
            ((c + 0.055) / 1.055).powf(2.4)
        }
    };
    let (r, g, b) = (linear(16), linear(8), linear(0));
    let l = (0.412_221_47 * r + 0.536_332_55 * g + 0.051_445_99 * b).cbrt();
    let m = (0.211_903_5 * r + 0.680_699_5 * g + 0.107_396_96 * b).cbrt();
    let s = (0.088_302_46 * r + 0.281_718_85 * g + 0.629_978_7 * b).cbrt();
    let a = 1.977_998_5 * l - 2.428_592_2 * m + 0.450_593_7 * s;
    let b = 0.025_904_037 * l + 0.782_771_77 * m - 0.808_675_77 * s;
    (b.atan2(a).to_degrees().rem_euclid(360.), a.hypot(b))
}

/// The tmux theme the installed Bezel palette was built from, and whether that
/// palette paints glass.
struct Bridged(Theme, bool);
impl Global for Bridged {}

/// The daemon still chooses appearance. Bezel receives that choice, never persists
/// a second preference or modifies the canonical terminal palette.
///
/// Runs while a window renders, before anything reads the palette, so that
/// window needs no refresh. `install_custom` would refresh every window, and
/// two windows on different tmux themes would then reinstall each other's
/// palette forever; each window installs its own as it renders instead.
pub(super) fn prepare(theme: &Theme, native_glass: bool, cx: &mut App) {
    let build = {
        let source = theme.clone();
        move |_| {
            let mut next = palette(&source);
            next.glass &= native_glass;
            next.vibrancy &= native_glass;
            next
        }
    };
    let next = build(bezel_theme::Appearance::Dark);
    if cx
        .try_global::<Bridged>()
        .is_some_and(|Bridged(current, glass)| current == theme && *glass == next.glass)
    {
        return;
    }
    bezel_theme::set_current_appearance(next.appearance);
    // Any later rebuild by Bezel (a light/dark switch) starts from the same
    // tmux theme rather than from Bezel's stock palette.
    bezel_theme::AppExt::set_palette(cx, build);
    cx.set_global(Bridged(theme.clone(), next.glass));
    cx.set_global(next);
}

#[cfg(test)]
mod tests {
    use super::{badge_text, chrome_text, dialog_muted, palette, popover_ink, prepare, row_ink};
    use crate::{config::Theme, contrast::Contrast};
    use gpui::{Hsla, TestAppContext, black, rgb, white};

    fn color(value: u32) -> Hsla {
        rgb(value).into()
    }

    fn light() -> Theme {
        let mut theme = Theme {
            background: 0xfbfaf7,
            foreground: 0x1f2328,
            cursor: 0x0a69da,
            surface: 0xf1ede4,
            active: 0xd8e6fb,
            ..Theme::default()
        };
        theme.palette[1] = 0xcf222e;
        theme
    }

    #[test]
    fn popover_text_is_legible_in_both_appearances() {
        for background in [0x000000, 0xffffff] {
            let theme = Theme {
                background,
                ..Theme::default()
            };
            let bezel = palette(&theme);
            let overlay = bezel.surface_overlay;
            let text = bezel_theme::flatten(bezel.text, overlay);
            assert!(bezel_theme::contrast_ratio(text, overlay) >= 4.5);
            assert_eq!(overlay.a, 1.0, "No fake blur over live terminal text");
        }
    }

    #[test]
    fn light_and_dark_come_from_the_tmux_theme() {
        for theme in [Theme::default(), light()] {
            let bezel = palette(&theme);
            let dark = crate::contrast::luminance(theme.background) < 0.5;
            assert_eq!(bezel.appearance == bezel_theme::Appearance::Dark, dark);
            assert_eq!(bezel.bg, color(theme.background));
            assert_eq!(bezel.terminal_bg, color(theme.background));
            assert_eq!(bezel.surface, color(theme.surface));
            assert_eq!(bezel.cursor, color(theme.cursor));
            assert_eq!(bezel.selection, color(theme.active));
            assert_eq!(
                Hsla {
                    a: 1.0,
                    ..bezel.text
                },
                color(theme.foreground)
            );
            assert_ne!(bezel.text_muted, bezel.text);
            for (ansi, value) in bezel.terminal_ansi.iter().zip(theme.palette) {
                assert_eq!(*ansi, color(value));
            }
        }
    }

    #[test]
    fn overlays_take_the_surface_hue() {
        let theme = Theme {
            surface: 0x1e2235,
            ..Theme::default()
        };
        let overlay = palette(&theme).surface_overlay;
        let surface = color(theme.surface);
        assert!(overlay.s > 0.05, "overlay stayed neutral: {overlay:?}");
        assert!(
            (overlay.h - surface.h).abs() < 0.05,
            "{overlay:?} vs {surface:?}"
        );
        let grey = palette(&Theme {
            surface: 0x222222,
            ..Theme::default()
        });
        assert!(
            grey.surface_overlay.s < 0.01,
            "a grey surface keeps grey overlays"
        );
    }

    #[test]
    fn high_contrast_turns_off_glass_and_raises_faint_text() {
        let standard = palette(&Theme::default());
        let high = palette(&Theme {
            contrast: Contrast::High,
            ..Theme::default()
        });
        assert!(!high.glass && !high.vibrancy);
        assert!(high.text_faint.a > standard.text_faint.a);
    }

    #[derive(serde::Deserialize)]
    struct Preset {
        id: String,
        mode: String,
        dark: crate::tmux_snapshot::appearance::Colors,
        light: crate::tmux_snapshot::appearance::Colors,
    }

    /// Every preset in the shipped catalog, in both of its variants, as the
    /// tmux theme the app derives from it, with the appearance it should have.
    fn catalog() -> Vec<(String, String, Theme)> {
        let presets: Vec<Preset> =
            match serde_json::from_str(include_str!("appearance/catalog.json")) {
                Ok(presets) => presets,
                Err(error) => panic!("catalog.json: {error}"),
            };
        let mut themes = Vec::new();
        for preset in presets {
            for (variant, colors) in [("dark", &preset.dark), ("light", &preset.light)] {
                let mut theme = Theme {
                    background: colors.background,
                    foreground: colors.foreground,
                    cursor: colors.cursor,
                    surface: colors.surface,
                    active: colors.active,
                    muted: colors.muted,
                    ..Theme::default()
                };
                for (slot, value) in theme.palette.iter_mut().zip(&colors.palette) {
                    *slot = *value;
                }
                let expected = match preset.mode.as_str() {
                    "system" => variant,
                    mode => mode,
                };
                themes.push((
                    format!("{} ({variant})", preset.id),
                    expected.to_owned(),
                    theme,
                ));
            }
        }
        themes
    }

    #[test]
    fn every_catalog_theme_drives_a_complete_readable_palette() {
        let themes = catalog();
        assert_eq!(themes.len(), 50, "25 presets, two variants each");
        let mut failures = Vec::new();
        for (name, expected, theme) in themes {
            let mut bezel = palette(&theme);
            let appearance = match bezel.appearance {
                bezel_theme::Appearance::Dark => "dark",
                bezel_theme::Appearance::Light => "light",
            };
            if appearance != expected {
                failures.push(format!("{name}: came out {appearance}"));
            }
            if bezel.bg != color(theme.background)
                || bezel.surface != color(theme.surface)
                || bezel.terminal_bg != color(theme.background)
                || bezel.content_background != color(theme.background)
                || bezel.cursor != color(theme.cursor)
                || bezel
                    .terminal_ansi
                    .iter()
                    .zip(theme.palette)
                    .any(|(a, v)| *a != color(v))
            {
                failures.push(format!("{name}: fell back to stock Bezel colours"));
            }
            if let Some((token, _)) = bezel.tokens_mut().into_iter().find(|(_, c)| {
                ![c.h, c.s, c.l, c.a]
                    .iter()
                    // gpui rounds a saturated sRGB colour to an `s` a hair over 1.
                    .all(|v| v.is_finite() && (-1e-4..=1.0 + 1e-4).contains(v))
            }) {
                failures.push(format!("{name}: {token} is not a colour"));
            }
            for (plate, plate_name) in
                [(theme.background, "background"), (theme.surface, "surface")]
            {
                // The terminal's own text, which the bridge never adjusts.
                let raw = bezel_theme::contrast_ratio(color(theme.foreground), color(plate));
                if raw < 4.5 {
                    failures.push(format!("{name}: foreground on {plate_name} is {raw:.2}:1"));
                }
                let plate = color(plate);
                let text = bezel_theme::flatten(bezel.text, plate);
                let ratio = bezel_theme::contrast_ratio(text, plate);
                if ratio < 4.5 {
                    failures.push(format!("{name}: text on {plate_name} is {ratio:.2}:1"));
                }
            }
        }
        assert!(failures.is_empty(), "{failures:#?}");
    }

    #[test]
    fn chrome_text_reads_on_frost_over_any_desktop() {
        let mut failures = Vec::new();
        for (name, _, theme) in catalog() {
            let bezel = palette(&theme);
            assert_eq!(bezel.content_opacity, 1.0, "{name}: panes must stay opaque");
            assert_eq!(bezel.vibrancy_tone, color(theme.surface), "{name}");
            let mut plates = vec![(color(theme.surface), "surface")];
            if bezel.appearance == bezel_theme::Appearance::Dark {
                for (desktop, desktop_name) in
                    [(white(), "white desktop"), (black(), "black desktop")]
                {
                    plates.push((
                        bezel_theme::flatten(bezel.vibrancy_tint(), desktop),
                        desktop_name,
                    ));
                }
            }
            // Bezel's own text roles, as the titlebar's tab labels paint them.
            for (role, text) in [("text", bezel.text), ("text_muted", bezel.text_muted)] {
                for (plate, plate_name) in &plates {
                    let ratio =
                        bezel_theme::contrast_ratio(bezel_theme::flatten(text, *plate), *plate);
                    if ratio < 4.5 {
                        failures.push(format!(
                            "{name}: Bezel {role} on {plate_name} is {ratio:.2}:1"
                        ));
                    }
                }
            }
            // Row text over the selected and hover washes, on every plate.
            let mut row_plates = Vec::new();
            for (plate, plate_name) in &plates {
                row_plates.push((*plate, plate_name.to_string()));
                row_plates.push((
                    bezel_theme::flatten(bezel.card_selected_bg(), *plate),
                    format!("selected row on {plate_name}"),
                ));
                row_plates.push((
                    bezel_theme::flatten(bezel.element_hover, *plate),
                    format!("hovered row on {plate_name}"),
                ));
            }
            let (label, caption) = row_ink(&theme);
            for (role, value) in [("row label", label), ("row caption", caption)] {
                let text = color(value);
                for (plate, plate_name) in &row_plates {
                    let ratio = bezel_theme::contrast_ratio(text, *plate);
                    if ratio < 4.5 {
                        failures.push(format!("{name}: {role} on {plate_name} is {ratio:.2}:1"));
                    }
                }
            }
            let badge = bezel_theme::contrast_ratio(color(badge_text(&theme)), color(theme.active));
            if badge < 4.5 {
                failures.push(format!("{name}: badge count on its pill is {badge:.2}:1"));
            }
            for (role, value) in [("foreground", theme.foreground), ("muted", theme.muted)] {
                let text = color(chrome_text(&theme, value));
                for (plate, plate_name) in &plates {
                    let ratio = bezel_theme::contrast_ratio(text, *plate);
                    if ratio < 4.5 {
                        failures.push(format!("{name}: {role} on {plate_name} is {ratio:.2}:1"));
                    }
                }
            }
        }
        assert!(failures.is_empty(), "{failures:#?}");
    }

    #[test]
    fn every_palette_text_role_reads_on_its_plate() {
        let mut failures = Vec::new();
        for (name, _, theme) in catalog() {
            let bezel = palette(&theme);
            let ink = popover_ink(&theme);
            assert_eq!(ink.plate.a, 1.0, "{name}: the palette plate is opaque");
            let card = Hsla {
                a: 1.0,
                ..bezel.surface_dialog
            };
            let ratio = bezel_theme::contrast_ratio(dialog_muted(&theme), card);
            if ratio < 4.5 {
                failures.push(format!("{name}: dialog body on its card is {ratio:.2}:1"));
            }
            for (plate, plate_name) in [
                (ink.plate, "plate"),
                (
                    bezel_theme::flatten(bezel.card_selected_bg(), ink.plate),
                    "selected row",
                ),
                (
                    bezel_theme::flatten(bezel.element_hover, ink.plate),
                    "hovered row",
                ),
            ] {
                for (role, text) in [("text", ink.text), ("muted", ink.muted)] {
                    let ratio = bezel_theme::contrast_ratio(text, plate);
                    if ratio < 4.5 {
                        failures.push(format!(
                            "{name}: palette {role} on {plate_name} is {ratio:.2}:1"
                        ));
                    }
                }
            }
        }
        assert!(failures.is_empty(), "{failures:#?}");
    }

    #[gpui::test]
    fn reduce_transparency_makes_the_window_opaque(cx: &mut TestAppContext) {
        cx.update(|cx| {
            prepare(&Theme::default(), true, cx);
            assert!(bezel_theme::Theme::of(cx).vibrancy);
            prepare(&Theme::default(), false, cx);
            let installed = bezel_theme::Theme::of(cx);
            assert!(!installed.vibrancy && !installed.glass);
            assert_eq!(
                installed.window_background_appearance(),
                gpui::WindowBackgroundAppearance::Opaque
            );
        });
    }

    #[gpui::test]
    fn prepare_installs_the_bridged_palette_and_follows_theme_changes(cx: &mut TestAppContext) {
        cx.update(|cx| {
            prepare(&Theme::default(), true, cx);
            assert_eq!(
                bezel_theme::Theme::of(cx).bg,
                color(Theme::default().background)
            );
            prepare(&light(), true, cx);
            let installed = bezel_theme::Theme::of(cx);
            assert_eq!(installed.appearance, bezel_theme::Appearance::Light);
            assert_eq!(installed.bg, color(light().background));
            prepare(&light(), false, cx);
            assert!(!bezel_theme::Theme::of(cx).glass);
        });
    }
}
