//! The fills chrome and pane cards are drawn on (#746 v3), from the active
//! theme: the plate, the focused and unfocused cards, the selected row and
//! the hover wash. Every fill here is opaque, so it reads the same whatever
//! shows through the window's glass.
use crate::config::Theme;
use gpui::{Hsla, rgb};

fn to_linear(c: f32) -> f32 {
    if c <= 0.040_45 {
        c / 12.92
    } else {
        ((c + 0.055) / 1.055).powf(2.4)
    }
}
fn from_linear(c: f32) -> f32 {
    let c = c.clamp(0., 1.);
    if c <= 0.003_130_8 {
        12.92 * c
    } else {
        1.055 * c.powf(1. / 2.4) - 0.055
    }
}
fn linear(value: u32) -> [f32; 3] {
    [16, 8, 0].map(|shift| to_linear(((value >> shift) & 0xff) as f32 / 255.))
}
fn oklab(value: u32) -> [f32; 3] {
    let [r, g, b] = linear(value);
    let l = (0.412_221_47 * r + 0.536_332_55 * g + 0.051_445_995 * b).cbrt();
    let m = (0.211_903_5 * r + 0.680_699_5 * g + 0.107_396_96 * b).cbrt();
    let s = (0.088_302_46 * r + 0.281_718_85 * g + 0.629_978_7 * b).cbrt();
    [
        0.210_454_26 * l + 0.793_617_8 * m - 0.004_072_047 * s,
        1.977_998_5 * l - 2.428_592_2 * m + 0.450_593_7 * s,
        0.025_904_037 * l + 0.782_771_77 * m - 0.808_675_77 * s,
    ]
}
fn from_oklab([l, a, b]: [f32; 3]) -> u32 {
    let l_ = l + 0.396_337_78 * a + 0.215_803_76 * b;
    let m_ = l - 0.105_561_346 * a - 0.063_854_17 * b;
    let s_ = l - 0.089_484_18 * a - 1.291_485_5 * b;
    let (l3, m3, s3) = (l_.powi(3), m_.powi(3), s_.powi(3));
    let rgb = [
        4.076_741_7 * l3 - 3.307_711_6 * m3 + 0.230_969_93 * s3,
        -1.268_438 * l3 + 2.609_757_4 * m3 - 0.341_319_4 * s3,
        -0.004_196_086_3 * l3 - 0.703_418_6 * m3 + 1.707_614_7 * s3,
    ];
    rgb.iter().fold(0, |packed, c| {
        (packed << 8) | (from_linear(*c) * 255.).round() as u32
    })
}
/// `from` moved `k` of the way to `to` in OKLab: Bezel's own `toward` mix.
pub(crate) fn mix_oklab(from: u32, to: u32, k: f32) -> u32 {
    let (a, b) = (oklab(from), oklab(to));
    from_oklab([0, 1, 2].map(|i| a[i] + (b[i] - a[i]) * k))
}
/// `fill` darkened in OKLab (lightness down, hue and chroma kept) just far
/// enough that `label` reads on it at `target`; unchanged when it already
/// does. For a destructive button's white label on its danger plate.
pub(crate) fn darken_for(fill: u32, label: u32, target: f32) -> u32 {
    let [l, a, b] = oklab(fill);
    (0..=200)
        .map(|n| from_oklab([(l - n as f32 * 0.005).max(0.), a, b]))
        .find(|&c| crate::contrast::ratio(label, c) >= target)
        .unwrap_or(0x000000)
}

/// CIE L*, the lightness a step between two fills is judged by.
pub(crate) fn lstar(value: u32) -> f32 {
    let [r, g, b] = linear(value);
    let y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    116. * if y > 0.008_856 {
        y.cbrt()
    } else {
        7.787 * y + 16. / 116.
    } - 16.
}
/// The smallest step between the focused and unfocused cards, in L*.
pub(crate) const FOCUS_STEP: f32 = 3.;
/// The furthest the unfocused card moves toward the ink looking for it.
const MAX_K: f32 = 0.3;

/// The unfocused card (#746 v3, focus by fill): the terminal background moved
/// toward the theme's ink by the smallest `k` that changes L* by
/// [`FOCUS_STEP`]. `None` when no `k` up to [`MAX_K`] gets there, or when the
/// step costs the theme's own colours their contrast: the default foreground
/// under 4.5:1, or an ANSI colour that read at 3:1 on the theme's background
/// falling under it. Such a theme keeps its background on every card, and
/// focus shows in the title's ink alone.
pub(crate) fn unfocused_fill(theme: &Theme) -> Option<u32> {
    let bg = theme.background;
    let base = lstar(bg);
    let k = (0..=(MAX_K * 200.) as u32)
        .map(|n| n as f32 / 200.)
        .find(|&k| (lstar(mix_oklab(bg, theme.foreground, k)) - base).abs() >= FOCUS_STEP)?;
    let fill = mix_oklab(bg, theme.foreground, k);
    let ratio = crate::contrast::ratio;
    if ratio(theme.foreground, fill) < 4.5 {
        return None;
    }
    let breaks = theme.palette[..16]
        .iter()
        .any(|&c| ratio(c, bg) >= 3. && ratio(c, fill) < 3.);
    (!breaks).then_some(fill)
}

/// The two card fills: the focused pane on the terminal's own background,
/// every other pane a step toward the ink (or the same background when the
/// theme can't take the step).
pub(crate) fn card_fills(theme: &Theme) -> (Hsla, Hsla) {
    let focused = theme.background;
    let rest = unfocused_fill(theme).unwrap_or(focused);
    (rgb(focused).into(), rgb(rest).into())
}

#[cfg(test)]
#[path = "surfaces_tests.rs"]
mod tests;
