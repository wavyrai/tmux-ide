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

pub(crate) fn palette(theme: &Theme) -> bezel_theme::Theme {
    let mut result = if crate::contrast::luminance(theme.background) < 0.5 {
        bezel_theme::Theme::dark()
    } else {
        bezel_theme::Theme::light()
    };
    if theme.contrast == Contrast::High {
        bezel_theme::Brand {
            ink: bezel_theme::Ink::ACCESSIBLE,
            ..Default::default()
        }
        .apply(&mut result);
        result.glass = false;
        result.vibrancy = false;
    }
    result
}

/// The daemon still chooses appearance. Bezel receives that choice, never persists
/// a second preference or modifies the canonical terminal palette.
pub(super) fn prepare(theme: &Theme, native_glass: bool, cx: &mut App) {
    let mut next = palette(theme);
    next.glass &= native_glass;
    next.vibrancy &= native_glass;
    if cx.try_global::<bezel_theme::Theme>().is_none_or(|current| {
        current.appearance != next.appearance
            || current.glass != next.glass
            || current.text != next.text
    }) {
        bezel_theme::Theme::install_custom(next, cx);
    }
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
    use super::Palette;
    use crate::config::Theme;
    use gpui::Rgba;
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
}
