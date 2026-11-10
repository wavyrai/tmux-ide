#![allow(clippy::unwrap_used)]
use super::*;
use core::prelude::v1::test;

#[test]
fn oklab_round_trips_and_mixes_like_bezels_toward() {
    for value in [0x000000, 0xffffff, 0x211f1b, 0xf7f4ee, 0x2e3440, 0x984822] {
        assert_eq!(mix_oklab(value, 0xffffff, 0.), value);
        assert_eq!(mix_oklab(0x000000, value, 1.), value);
    }
    assert!((lstar(0xffffff) - 100.).abs() < 0.01);
    assert!(lstar(0x000000).abs() < 0.01);
}

/// A theme whose ANSI colours are its foreground, so only the foreground's
/// contrast decides.
fn theme(background: u32, foreground: u32) -> Theme {
    let mut theme = Theme {
        background,
        foreground,
        ..Theme::default()
    };
    theme.palette[..16].fill(foreground);
    theme
}

#[test]
fn the_unfocused_card_is_three_l_star_toward_the_ink() {
    // Light: a step darker; dark: a step lighter (#746 v3).
    for (bg, fg) in [(0xf7f4ee, 0x2b2722), (0x211f1b, 0xe9e3d8)] {
        let t = theme(bg, fg);
        let fill = unfocused_fill(&t).unwrap();
        let step = lstar(fill) - lstar(bg);
        // At least 3 L*, and no more than the search's own resolution past.
        assert!(step.abs() >= 3.0 && step.abs() < 3.6, "{step}");
        assert_eq!(step < 0., lstar(bg) > 50.);
    }
}

#[test]
fn a_theme_whose_colours_would_suffer_keeps_its_background() {
    // The foreground barely reads on the background: the step would take it
    // under 4.5:1, so both cards keep the background.
    let t = theme(0x777777, 0xffffff);
    assert!(crate::contrast::ratio(t.foreground, t.background) >= 4.4);
    assert_eq!(unfocused_fill(&t), None);
    let (focused, rest) = card_fills(&t);
    assert_eq!(focused, rest);
}

#[test]
fn an_ansi_colour_that_would_drop_under_three_to_one_keeps_the_background() {
    let mut t = theme(0x211f1b, 0xe9e3d8);
    assert!(unfocused_fill(&t).is_some());
    // A colour just over 3:1 on the background, which the lighter unfocused
    // card would take under it.
    let fill = unfocused_fill(&t).unwrap();
    let edge = (0x40..=0xff)
        .map(|v: u32| v * 0x010101)
        .find(|&c| {
            crate::contrast::ratio(c, t.background) >= 3. && crate::contrast::ratio(c, fill) < 3.
        })
        .unwrap();
    t.palette[4] = edge;
    assert_eq!(unfocused_fill(&t), None);
}

#[test]
fn the_selected_capsule_is_opaque_in_both_appearances() {
    use crate::tmux_snapshot::design::selected_capsule;
    // Light: the terminal background, the lightest surface.
    let light = theme(0xf7f4ee, 0x2b2722);
    let (fill, ring) = selected_capsule(&light);
    assert_eq!(fill, rgb(0xf7f4ee).into());
    assert_eq!(ring, bezel_theme::glass_selected_shadows());
    // Dark: Bezel's selected wash flattened over the plate.
    let mut dark = theme(0x211f1b, 0xe9e3d8);
    dark.surface = 0x1b1916;
    let (fill, _) = selected_capsule(&dark);
    assert_eq!(fill.a, 1.);
    assert!(lstar(u32::from(gpui::Rgba::from(fill)) >> 8) > lstar(dark.surface) + 5.);
}

#[test]
fn a_danger_plate_darkens_only_as_far_as_its_white_label_needs() {
    // Already reads: unchanged.
    assert_eq!(darken_for(0x9b1c1c, 0xffffff, 4.6), 0x9b1c1c);
    // Bright red: darkened, hue kept, just past 4.6:1.
    let bright = 0xff6467;
    let dark = darken_for(bright, 0xffffff, 4.6);
    assert!(crate::contrast::ratio(0xffffff, dark) >= 4.6);
    assert!(lstar(dark) < lstar(bright));
    assert!(crate::contrast::ratio(0xffffff, mix_oklab(dark, bright, 0.1)) < 4.7);
}

/// c5: every catalog theme's destructive button label reads at 4.5:1.
#[test]
fn every_destructive_label_reads_on_its_plate() {
    for (name, theme) in crate::tmux_snapshot::ink::tests::catalog_themes() {
        let bezel = crate::tmux_snapshot::design::palette(&theme);
        let plate = u32::from(gpui::Rgba::from(bezel.danger_strong)) >> 8;
        let ratio = crate::contrast::ratio(0xffffff, plate);
        assert!(ratio >= 4.5, "{name}: {ratio:.2}:1 on #{plate:06x}");
    }
}

/// #746 v3: in every catalog theme that takes the step, the unfocused card
/// stands at least 3 L* from the focused one (a literal, not FOCUS_STEP, so
/// a weaker constant can't pass).
#[test]
fn every_catalog_theme_that_steps_moves_at_least_three_l_star() {
    let mut stepped = 0;
    for (name, theme) in crate::tmux_snapshot::ink::tests::catalog_themes() {
        if let Some(fill) = unfocused_fill(&theme) {
            let step = (lstar(fill) - lstar(theme.background)).abs();
            assert!(step >= 3.0, "{name}: {step:.2} L*");
            stepped += 1;
        }
    }
    assert!(stepped > 20, "only {stepped} themes took the step");
}
