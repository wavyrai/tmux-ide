//! The chrome's three inks (#746 v3), per theme: text, label and muted, each
//! the theme's own ink laid on the plate at an alpha, so they keep its hue.
//! Every tier reads at 4.6:1 on every surface it can be drawn on: the plate
//! (frosted over each desktop it is checked on), a hovered row, the selected
//! capsule, and the focused and unfocused cards.
use crate::config::Theme;
use gpui::{Hsla, Rgba, rgb};

/// The contrast every tier keeps (a little over 4.5:1, for rounding).
pub(crate) const TARGET: f32 = 4.6;
/// Marks and icons at rest.
pub(crate) const ICON_TARGET: f32 = 3.1;
/// The least alpha step between muted and text that reads as a step.
const SPREAD: f32 = 0.25;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Tiers {
    pub text: u32,
    pub label: u32,
    pub muted: u32,
    pub icon: u32,
    /// 3, or 2 when label folds into text, or 1 when the theme's own ink
    /// can't reach [`TARGET`] and every tier is that ink, moved to read.
    pub levels: u8,
}

fn pack(c: Hsla) -> u32 {
    u32::from(Rgba::from(c)) >> 8
}

/// The theme's ink at `alpha` over its plate tone, opaque.
fn ink_at(theme: &Theme, alpha: f32) -> u32 {
    pack(bezel_theme::flatten(
        Hsla::from(rgb(theme.foreground)).opacity(alpha),
        rgb(theme.surface).into(),
    ))
}

/// The least alpha (in hundredths) at which the ink reads at `target` on
/// every surface.
fn least_alpha(theme: &Theme, surfaces: &[u32], target: f32) -> Option<f32> {
    (0..=100).map(|n| n as f32 / 100.).find(|&a| {
        let ink = ink_at(theme, a);
        surfaces
            .iter()
            .all(|&s| crate::contrast::ratio(ink, s) >= target)
    })
}

/// Every surface chrome text is drawn on.
pub(crate) fn surfaces(theme: &Theme) -> Vec<u32> {
    surfaces_at(theme, super::design::frost(theme))
}

/// [`surfaces`] at a given frost (`None`: opaque).
fn surfaces_at(theme: &Theme, frost: Option<f32>) -> Vec<u32> {
    let (focused, rest) = super::surfaces::card_fills(theme);
    let mut all = super::design::row_plates_at(theme, frost);
    all.extend([pack(focused), pack(rest)]);
    all
}

/// The three tiers for `theme`: muted is the least alpha that reads on
/// every surface; text is Bezel's 0.85, or 0.30 above muted when that is
/// closer, at most 1; label is half way. When text can't stand 0.25 above
/// muted, label folds into text (two tiers).
pub(crate) fn tiers(theme: &Theme) -> Tiers {
    tiers_at(theme, super::design::frost(theme))
}

/// [`tiers`] at a given frost (`None`: opaque), which the frost's search
/// asks about each alpha it tries.
pub(crate) fn tiers_at(theme: &Theme, frost: Option<f32>) -> Tiers {
    // The sidebar asks for every row, every frame: a few themes are cached.
    thread_local! {
        static CACHE: std::cell::RefCell<Vec<((Theme, Option<u32>), Tiers)>> =
            Default::default();
    }
    let key = (theme.clone(), frost.map(f32::to_bits));
    if let Some(t) = CACHE.with(|c| c.borrow().iter().find(|(k, _)| *k == key).map(|(_, t)| *t)) {
        return t;
    }
    let all = surfaces_at(theme, frost);
    let tiers = match least_alpha(theme, &all, TARGET) {
        None => {
            // The theme's own ink can't reach it: one tier, the ink moved
            // only as far as it must (to 4.75:1, so 8-bit rounding of the
            // frosted plates can't leave it just under 4.5).
            let ink = crate::contrast::ink(theme.foreground, &all, 4.75);
            let icon = crate::contrast::ink(theme.foreground, &all, ICON_TARGET);
            Tiers {
                text: ink,
                label: ink,
                muted: ink,
                icon,
                levels: 1,
            }
        }
        Some(muted) => {
            let text = (muted + 0.30).max(0.85).min(1.);
            let three = text - muted >= SPREAD - 0.001;
            let label = if three { (text + muted) / 2. } else { text };
            let icon = least_alpha(theme, &all, ICON_TARGET).unwrap_or(muted);
            Tiers {
                text: ink_at(theme, text),
                label: ink_at(theme, label),
                muted: ink_at(theme, muted),
                icon: ink_at(theme, icon),
                levels: if three { 3 } else { 2 },
            }
        }
    };
    CACHE.with(|c| {
        let mut c = c.borrow_mut();
        if c.len() >= 64 {
            c.remove(0);
        }
        c.push((key, tiers));
    });
    tiers
}

#[cfg(test)]
#[path = "ink_tests.rs"]
mod tests;
