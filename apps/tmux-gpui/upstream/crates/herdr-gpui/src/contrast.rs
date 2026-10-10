//! How far the app's own colors stand off the chrome they are drawn on.
//!
//! Status dots, badges, diff counts, and dim labels are picked for a dark UI
//! and fade on light themes. [`ink`] keeps each color's hue and moves only its
//! lightness until it reaches a WCAG contrast ratio against the chrome, so one
//! rule serves every theme, including files the user brings. Terminal output
//! is never adjusted: a program's colors reach the screen as it asked.

use serde::Deserialize;
use std::{cell::RefCell, collections::HashMap};

/// The contrast the app's own marks and labels keep against its chrome.
#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Contrast {
    /// Colored marks reach 3:1, the WCAG minimum for meaningful graphics, and
    /// the theme's chrome is left as drawn.
    #[default]
    Standard,
    /// Colored marks and dim labels reach 4.5:1, the WCAG minimum for text,
    /// and selected rows stand further off the surface.
    High,
}

impl Contrast {
    /// The ratio a colored mark keeps against every chrome background.
    pub fn mark_ratio(self) -> f32 {
        match self {
            Self::Standard => 3.,
            Self::High => 4.5,
        }
    }

    /// The config file spelling.
    pub fn name(self) -> &'static str {
        match self {
            Self::Standard => "standard",
            Self::High => "high",
        }
    }
}

fn channels(color: u32) -> [f32; 3] {
    [16, 8, 0].map(|shift| ((color >> shift) & 255) as f32 / 255.)
}

fn pack(rgb: [f32; 3]) -> u32 {
    rgb.iter().fold(0, |packed, channel| {
        (packed << 8) | (channel.clamp(0., 1.) * 255.).round() as u32
    })
}

fn to_linear(channel: f32) -> f32 {
    if channel <= 0.040_45 {
        channel / 12.92
    } else {
        ((channel + 0.055) / 1.055).powf(2.4)
    }
}

fn from_linear(channel: f32) -> f32 {
    if channel <= 0.003_130_8 {
        channel * 12.92
    } else {
        1.055 * channel.powf(1. / 2.4) - 0.055
    }
}

/// WCAG relative luminance.
pub(crate) fn luminance(color: u32) -> f32 {
    let [r, g, b] = channels(color).map(to_linear);
    0.2126 * r + 0.7152 * g + 0.0722 * b
}

/// WCAG contrast ratio, from 1 (identical) to 21 (black on white).
pub(crate) fn ratio(a: u32, b: u32) -> f32 {
    let (a, b) = (luminance(a), luminance(b));
    (a.max(b) + 0.05) / (a.min(b) + 0.05)
}

fn worst(color: u32, backgrounds: &[u32]) -> f32 {
    backgrounds
        .iter()
        .map(|&background| ratio(color, background))
        .fold(f32::INFINITY, f32::min)
}

fn to_oklab(color: u32) -> [f32; 3] {
    let [r, g, b] = channels(color).map(to_linear);
    let l = (0.412_221_46 * r + 0.536_332_55 * g + 0.051_445_995 * b).cbrt();
    let m = (0.211_903_5 * r + 0.680_699_5 * g + 0.107_396_96 * b).cbrt();
    let s = (0.088_302_46 * r + 0.281_718_85 * g + 0.629_978_7 * b).cbrt();
    [
        0.210_454_26 * l + 0.793_617_8 * m - 0.004_072_047 * s,
        1.977_998_5 * l - 2.428_592_2 * m + 0.450_593_7 * s,
        0.025_904_037 * l + 0.782_771_77 * m - 0.808_675_77 * s,
    ]
}

/// Out-of-gamut results are clipped per channel, which keeps the hue close
/// enough for a mark; the caller measures the packed color it gets back.
fn from_oklab([lightness, a, b]: [f32; 3]) -> u32 {
    let l = (lightness + 0.396_337_78 * a + 0.215_803_76 * b).powi(3);
    let m = (lightness - 0.105_561_346 * a - 0.063_854_17 * b).powi(3);
    let s = (lightness - 0.089_484_18 * a - 1.291_485_5 * b).powi(3);
    pack(
        [
            4.076_741_7 * l - 3.307_711_6 * m + 0.230_969_94 * s,
            -1.268_438 * l + 2.609_757_4 * m - 0.341_319_38 * s,
            -0.004_196_086_3 * l - 0.703_418_6 * m + 1.707_614_7 * s,
        ]
        .map(|channel| from_linear(channel.clamp(0., 1.))),
    )
}

/// Pastels moved far from their lightness turn to mud unless they gain some
/// colorfulness on the way, so chroma grows with the distance travelled.
const CHROMA_GAIN: f32 = 1.5;

/// Bisection steps over OKLab lightness; well below one 8-bit step.
const STEPS: usize = 16;

/// `color` with its OKLCH lightness moved just far enough to reach `target`
/// against every one of `backgrounds`, keeping its hue. A color that already
/// passes comes back unchanged, so a theme that reads well is left alone.
/// Moves toward black on light chrome and toward white on dark chrome; a
/// target the chrome cannot allow ends at that pole.
pub(crate) fn ink(color: u32, backgrounds: &[u32], target: f32) -> u32 {
    if worst(color, backgrounds) >= target {
        return color;
    }
    let darken = worst(0x000000, backgrounds) >= worst(0xffffff, backgrounds);
    let pole = if darken { 0x000000 } else { 0xffffff };
    let [lightness, a, b] = to_oklab(color);
    let span = if darken { lightness } else { 1. - lightness };
    if span <= f32::EPSILON {
        return pole;
    }
    // `near` fails and `far` passes: close in on the least movement that passes.
    let (mut near, mut far) = (lightness, if darken { 0. } else { 1. });
    let mut found = pole;
    for _ in 0..STEPS {
        let middle = (near + far) / 2.;
        let gain = 1. + CHROMA_GAIN * (middle - lightness).abs() / span;
        let candidate = from_oklab([middle, a * gain, b * gain]);
        if worst(candidate, backgrounds) >= target {
            found = candidate;
            far = middle;
        } else {
            near = middle;
        }
    }
    found
}

/// Distinct inputs kept before the cache starts over. A theme inks a few
/// dozen fixed colors, so this is only reached after many theme switches.
const CACHE_LIMIT: usize = 512;

type CacheKey = (u32, [u32; 3], u32);

thread_local! {
    static CACHE: RefCell<HashMap<CacheKey, u32>> = RefCell::new(HashMap::new());
}

/// [`ink`] against a theme's three chrome backgrounds, remembered per thread:
/// render calls it for every dot and badge on every frame, and a color that
/// has to move costs a bisection.
pub(crate) fn ink_on_chrome(color: u32, chrome: [u32; 3], target: f32) -> u32 {
    let key = (color, chrome, target.to_bits());
    CACHE.with(|cache| {
        if let Some(&inked) = cache.borrow().get(&key) {
            return inked;
        }
        let inked = ink(color, &chrome, target);
        let mut cache = cache.borrow_mut();
        if cache.len() >= CACHE_LIMIT {
            cache.clear();
        }
        cache.insert(key, inked);
        inked
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ratio_matches_wcag_reference_values() {
        assert!((ratio(0x000000, 0xffffff) - 21.).abs() < 0.01);
        assert!((ratio(0x777777, 0xffffff) - 4.48).abs() < 0.01);
        assert_eq!(ratio(0x123456, 0x123456), 1.);
    }

    #[test]
    fn oklab_round_trips_every_primary_and_grey() {
        for color in [
            0x000000, 0xffffff, 0xff0000, 0x00ff00, 0x0000ff, 0x808080, 0xf9e2af,
        ] {
            let back = from_oklab(to_oklab(color));
            for (a, b) in channels(color).into_iter().zip(channels(back)) {
                assert!((a - b).abs() <= 1. / 255., "{color:06x} -> {back:06x}");
            }
        }
    }

    #[test]
    fn ink_leaves_passing_colors_alone_and_lifts_failing_ones_to_the_target() {
        // Catppuccin Mocha yellow already reads on a dark surface.
        assert_eq!(ink(0xf9e2af, &[0x1c1c22], 3.), 0xf9e2af);
        for (color, background, target) in [
            (0xf9e2af, 0xebedf1, 3.),
            (0xf9e2af, 0xebedf1, 4.5),
            (0x94e2d5, 0xffffff, 4.5),
            (0x1e66f5, 0x000000, 7.),
            (0x303030, 0x101419, 4.5),
        ] {
            let inked = ink(color, &[background], target);
            assert_ne!(inked, color);
            assert!(ratio(inked, background) >= target, "{inked:06x}");
            // The least movement that passes: one step less would fail.
            assert!(ratio(inked, background) < target + 0.5, "{inked:06x}");
        }
    }

    #[test]
    fn ink_keeps_the_hue_of_a_darkened_pastel() {
        let hue = |color: u32| {
            let [_, a, b] = to_oklab(color);
            b.atan2(a)
        };
        for color in [0xf9e2af, 0xf38ba8, 0x94e2d5, 0xa6e3a1] {
            let inked = ink(color, &[0xebedf1], 4.5);
            assert!(
                (hue(inked) - hue(color)).abs() < 0.2,
                "{color:06x} -> {inked:06x}"
            );
        }
    }

    #[test]
    fn ink_satisfies_every_background_and_ends_at_a_pole_when_it_must() {
        let backgrounds = [0xeff1f5, 0xdce0e8];
        let inked = ink(0xa6e3a1, &backgrounds, 4.5);
        assert!(backgrounds.iter().all(|&bg| ratio(inked, bg) >= 4.5));
        // Mid grey cannot give 21:1 in either direction.
        assert_eq!(ink(0x777777, &[0x777777], 21.), 0x000000);
    }

    #[test]
    fn cached_ink_matches_ink_and_stays_bounded() {
        let chrome = [0xeff1f5, 0xe6e8ed, 0xd9dbe2];
        for color in 0..(CACHE_LIMIT as u32 + 8) {
            let color = 0xf9e2af ^ color;
            assert_eq!(ink_on_chrome(color, chrome, 4.5), ink(color, &chrome, 4.5));
            assert_eq!(ink_on_chrome(color, chrome, 4.5), ink(color, &chrome, 4.5));
        }
        CACHE.with(|cache| assert!(cache.borrow().len() <= CACHE_LIMIT));
    }

    #[test]
    fn contrast_parses_its_config_names() {
        #[derive(Deserialize)]
        struct Value {
            contrast: Contrast,
        }
        for contrast in [Contrast::Standard, Contrast::High] {
            let text = format!("contrast = \"{}\"", contrast.name());
            let parsed: Value = toml::from_str(&text).unwrap_or_else(|e| panic!("{e}"));
            assert_eq!(parsed.contrast, contrast);
        }
        assert!(toml::from_str::<Value>("contrast = \"loud\"").is_err());
    }
}
