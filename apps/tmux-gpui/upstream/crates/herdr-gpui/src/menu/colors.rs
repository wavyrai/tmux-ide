//! Accent and danger colors derived from the active theme's ANSI palette,
//! mixed with foreground so they stay readable on dark surfaces.

use gpui::{Rgba, rgb, rgba};

/// Mix an ANSI color with foreground so it stays readable on dark themes, where
/// the palette entry alone can sit too close to the surface it is painted on,
/// then ink it so light themes and high contrast read too.
pub(crate) fn tint(theme: &crate::config::Theme, index: usize) -> Rgba {
    rgb(theme.ink(crate::config::mix(
        theme.foreground,
        theme.palette[index],
        TINT_PERCENT,
    )))
}

/// The share of the ANSI color in [`tint`].
const TINT_PERCENT: u32 = 44;

/// The theme's blue, as accents and links use it.
pub(crate) fn accent(theme: &crate::config::Theme) -> Rgba {
    tint(theme, 4)
}

/// The theme's cyan, lifted toward the foreground: the teleported mark, which
/// must read on dark surfaces and stay distinct from the yellow uncommitted
/// mark and the green online dot.
pub(crate) fn teleported(theme: &crate::config::Theme) -> Rgba {
    tint(theme, 6)
}

/// The theme's red, as destructive actions and errors use it.
pub(crate) fn danger(theme: &crate::config::Theme) -> Rgba {
    tint(theme, 1)
}

/// Lift the button above both the normal hover row and the current-session tint.
pub(super) fn action_hover(theme: &crate::config::Theme) -> Rgba {
    rgb(theme.active).blend(rgba((theme.foreground << 8) | 0x60))
}

/// The connected-or-running indicator the device picker, the session list, and
/// the sidebar host headers all share, so one machine's state reads the same in each.
pub(crate) fn online(theme: &crate::config::Theme) -> u32 {
    theme.ink(0x63c68b)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn action_hover_stays_distinct_from_highlighted_rows() {
        for name in crate::config::Theme::BUILTIN_NAMES {
            let theme = crate::config::Theme::builtin(name)
                .unwrap_or_else(|| panic!("missing theme {name}"));
            let hover = action_hover(&theme);
            let distance = |other: Rgba| {
                (hover.r - other.r).abs() + (hover.g - other.g).abs() + (hover.b - other.b).abs()
            };
            for background in [theme.surface, theme.active, theme.primary_wash()] {
                assert!(
                    distance(rgb(background)) > 0.12,
                    "{name}: button disappears into row"
                );
            }
            assert!(
                distance(rgb(theme.foreground)) > 0.9,
                "{name}: icon lacks contrast"
            );
        }
    }

    /// WCAG relative luminance of a color composited over nothing.
    fn luminance(color: Rgba) -> f32 {
        let linear = |c: f32| {
            if c <= 0.039_28 {
                c / 12.92
            } else {
                ((c + 0.055) / 1.055).powf(2.4)
            }
        };
        0.2126 * linear(color.r) + 0.7152 * linear(color.g) + 0.0722 * linear(color.b)
    }

    fn contrast(a: Rgba, b: Rgba) -> f32 {
        let (a, b) = (luminance(a), luminance(b));
        (a.max(b) + 0.05) / (a.min(b) + 0.05)
    }

    #[test]
    fn the_teleported_mark_reads_on_every_theme() {
        let themes = crate::config::Theme::BUILTIN_NAMES
            .iter()
            .map(|name| {
                let theme = crate::config::Theme::builtin(name)
                    .unwrap_or_else(|| panic!("missing theme {name}"));
                (*name, theme)
            })
            .chain([("default", crate::config::Theme::default())]);
        for (name, theme) in themes {
            let mark = teleported(&theme);
            for background in [theme.background, theme.surface, theme.active] {
                // 3:1 is the WCAG minimum for meaningful graphics.
                let ratio = contrast(mark, rgb(background));
                assert!(ratio >= 3., "{name}: {ratio:.2} against {background:06x}");
            }
        }
        // The raw palette blue it replaces did not read on the default theme.
        let theme = crate::config::Theme::default();
        assert!(contrast(rgb(theme.palette[4]), rgb(theme.background)) < 3.);
    }
}
