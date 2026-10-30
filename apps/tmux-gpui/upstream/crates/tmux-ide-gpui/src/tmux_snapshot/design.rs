//! Bezel-derived native component tokens. See BEZEL-NOTICE.md for provenance.
//! These colors belong to chrome; never use them to recolor canonical terminal cells.
use crate::{config::Theme, contrast::Contrast};
use gpui::{prelude::*, *};

pub(super) const SURFACE_RADIUS: f32 = 12.;

#[derive(Clone, Copy)]
pub(super) struct Palette {
    pub overlay: Rgba,
    pub text: Rgba,
    pub muted: Rgba,
    pub selected: Rgba,
    pub border: Rgba,
}
impl Palette {
    pub fn for_theme(theme: &Theme) -> Self {
        let source = palette(theme);
        let overlay: Rgba = source.surface_overlay.into();
        Self {
            overlay,
            text: source.text.into(),
            muted: source.text_muted.into(),
            selected: source.element_active.into(),
            border: source.border.into(),
        }
    }
}

/// Bezel paint::surface_shadows. A single elevation recipe for floating cards.
pub(super) fn shadows() -> Vec<BoxShadow> {
    bezel_theme::surface_shadows()
}

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
    result.surface = color(theme.surface);
    result.cursor = color(theme.cursor);
    result.caret = color(theme.cursor);
    result.selection = color(theme.active);
    for (slot, value) in result.terminal_ansi.iter_mut().zip(theme.palette) {
        *slot = color(value);
    }
    // A foreground that can't be read on its own background (a half-edited
    // theme) keeps Bezel's ink rather than taking the chrome down with it.
    if bezel_theme::contrast_ratio(color(theme.foreground), result.bg) >= 4.5 {
        result.text = color(theme.foreground);
        brand.ink.for_appearance(appearance).paint(&mut result);
    }
    if high {
        result.glass = false;
        result.vibrancy = false;
    }
    result
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

/// The tmux theme the installed Bezel palette was built from.
struct Bridged(Theme, bool);
impl Global for Bridged {}

/// The daemon still chooses appearance. Bezel receives that choice, never persists
/// a second preference or modifies the canonical terminal palette.
pub(super) fn prepare(theme: &Theme, native_glass: bool, cx: &mut App) {
    if cx
        .try_global::<Bridged>()
        .is_some_and(|Bridged(current, glass)| current == theme && *glass == native_glass)
    {
        return;
    }
    let source = theme.clone();
    let build = move |_| {
        let mut next = palette(&source);
        next.glass &= native_glass;
        next.vibrancy &= native_glass;
        next
    };
    let next = build(bezel_theme::Appearance::Dark);
    // Any later rebuild by Bezel (a light/dark switch) starts from the same
    // tmux theme rather than from Bezel's stock palette.
    bezel_theme::AppExt::set_palette(cx, build);
    cx.set_global(Bridged(theme.clone(), native_glass));
    bezel_theme::Theme::install_custom(next, cx);
}

pub(super) fn popover(element: Stateful<Div>, cx: &App) -> bezel_ui::surface::Surface {
    use bezel_ui::surface::Surfaced;
    let theme = bezel_theme::Theme::of(cx);
    element.surface(theme, theme.popover_surface)
}

/// Shared floating-surface component. Owners retain positioning, occlusion and focus.
pub(super) fn floating<E: Styled>(element: E, theme: &Theme) -> E {
    let palette = Palette::for_theme(theme);
    element
        .rounded(px(SURFACE_RADIUS))
        .border_1()
        .border_color(palette.border)
        .bg(palette.overlay)
        .text_color(palette.text)
        .shadow(shadows())
}

#[cfg(test)]
mod tests {
    use super::{Palette, palette, prepare};
    use crate::{config::Theme, contrast::Contrast};
    use gpui::{Hsla, Rgba, TestAppContext, rgb};

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
    fn floating_text_is_legible_in_both_appearances() {
        for background in [0x000000, 0xffffff] {
            let theme = Theme {
                background,
                ..Theme::default()
            };
            let p = Palette::for_theme(&theme);
            let luminance = |c: Rgba| crate::contrast::luminance(u32::from(c) >> 8);
            let (a, b) = (luminance(p.text), luminance(p.overlay));
            assert!((a.max(b) + 0.05) / (a.min(b) + 0.05) >= 4.5);
            assert_eq!(p.overlay.a, 1.0, "No fake blur over live terminal text");
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
            assert!(bezel.text.a < 1.0 && bezel.text_muted.a < bezel.text.a);
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
