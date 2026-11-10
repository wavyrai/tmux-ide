//! Text on Bezel's Glass::Regular (#746 glass plan, G6): menus and tooltips
//! float on a glass that lets the desktop through, so their inks are moved
//! only as far as they must to read over a white and a black desktop.
use bezel_theme::Theme;
use gpui::{Hsla, Rgba, prelude::*, *};

fn pack(color: Hsla) -> u32 {
    u32::from(Rgba::from(color)) >> 8
}

/// What Glass::Regular shows over a white and a black desktop, from Bezel's
/// own spec: the backdrop scaled by the glass's gain, plus its tint.
pub(crate) fn regular_glass_plates(bezel: &Theme) -> [u32; 2] {
    let spec = bezel.glass_regular;
    let tint = Rgba::from(spec.tint);
    let over = |backdrop: f32| {
        let channel = |t: f32| ((spec.gain * backdrop + t * tint.a).clamp(0., 1.) * 255.).round();
        let [r, g, b] = [tint.r, tint.g, tint.b].map(channel);
        ((r as u32) << 16) | ((g as u32) << 8) | b as u32
    };
    [over(1.), over(0.)]
}

/// `bezel` with its text roles moved to read on Glass::Regular over any
/// desktop: text and muted at 4.6:1, faint at 3.1:1, hue kept. Where the
/// window runs opaque (glass off), `bezel` as it is.
pub(crate) fn on_regular_glass(bezel: &Theme) -> Theme {
    if !bezel.glass {
        return bezel.clone();
    }
    let plates = regular_glass_plates(bezel);
    let ink = |color: Hsla, target: f32| -> Hsla {
        let opaque = Hsla { a: 1.0, ..color };
        rgb(crate::contrast::ink(pack(opaque), &plates, target)).into()
    };
    let mut inked = bezel.clone();
    inked.text = ink(bezel.text, 4.6);
    inked.text_muted = ink(bezel.text_muted, 4.6);
    inked.text_faint = ink(bezel.text_faint, 3.1);
    inked
}

/// Bezel's tooltip card, its text inked for the glass it floats on.
struct GlassTooltip {
    text: SharedString,
    keystroke: Option<SharedString>,
}

impl Render for GlassTooltip {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        use bezel_theme::{TextStyle, Typeset as _};
        use bezel_ui::{popover, surface::Surfaced as _};
        let theme = on_regular_glass(Theme::of(cx));
        popover::popover_card(&theme)
            .px(px(8.0))
            .py(px(5.0))
            .flex()
            .flex_row()
            .items_center()
            .gap(px(Theme::SPACE))
            .text_style(TextStyle::Callout)
            .text_color(theme.text)
            .child(self.text.clone())
            .when_some(self.keystroke.clone(), |card, keystroke| {
                card.child(
                    div()
                        .text_style(TextStyle::Subheadline)
                        .text_color(theme.text_muted)
                        .child(keystroke),
                )
            })
            .surface(&theme, theme.popover_surface)
    }
}

/// A tooltip for `.tooltip(..)`, with an optional shortcut beside its text.
pub(crate) fn tooltip(
    text: impl Into<SharedString>,
    keystroke: Option<SharedString>,
    cx: &mut App,
) -> AnyView {
    let text = text.into();
    cx.new(|_| GlassTooltip { text, keystroke }).into()
}

#[cfg(test)]
#[path = "glass_ink_tests.rs"]
mod tests;
