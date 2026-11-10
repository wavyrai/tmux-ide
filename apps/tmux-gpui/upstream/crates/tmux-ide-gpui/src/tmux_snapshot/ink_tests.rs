#![allow(clippy::unwrap_used)]
use super::*;
use core::prelude::v1::test;

/// Every catalog preset in its own appearance (and System in both), as the
/// tmux theme the app derives from it.
pub(crate) fn catalog_themes() -> Vec<(String, Theme)> {
    let presets: Vec<serde_json::Value> =
        serde_json::from_str(include_str!("appearance/catalog.json")).unwrap_or_default();
    let mut out = Vec::new();
    for p in presets {
        let id = p["id"].as_str().unwrap_or_default().to_owned();
        let mode = p["mode"].as_str().unwrap_or_default().to_owned();
        for variant in ["dark", "light"] {
            if mode != variant && mode != "system" {
                continue;
            }
            let c = &p[variant];
            let u = |k: &str| c[k].as_u64().unwrap_or_default() as u32;
            let mut theme = Theme {
                background: u("background"),
                foreground: u("foreground"),
                cursor: u("cursor"),
                surface: u("surface"),
                active: u("active"),
                muted: u("muted"),
                ..Theme::default()
            };
            for (slot, v) in theme
                .palette
                .iter_mut()
                .zip(c["palette"].as_array().into_iter().flatten())
            {
                *slot = v.as_u64().unwrap_or_default() as u32;
            }
            out.push((format!("{id} ({variant})"), theme));
        }
    }
    out
}

/// Every catalog theme: each tier reads at 4.5:1 on every surface, the
/// tiers step down from text to muted, and how many there are.
#[test]
fn every_tier_reads_on_every_surface_in_every_theme() {
    let mut failures = Vec::new();
    for (name, theme) in catalog_themes() {
        let t = tiers(&theme);
        for (role, ink) in [("text", t.text), ("label", t.label), ("muted", t.muted)] {
            for s in surfaces(&theme) {
                let r = crate::contrast::ratio(ink, s);
                if r < 4.5 {
                    failures.push(format!("{name}: {role} on #{s:06x} is {r:.2}:1"));
                }
            }
        }
        let l = |c| crate::tmux_snapshot::surfaces::lstar(c);
        let plate = l(theme.surface);
        // Further from the plate, the higher the tier.
        assert!(
            (l(t.text) - plate).abs() >= (l(t.label) - plate).abs() - 0.01,
            "{name}"
        );
        assert!(
            (l(t.label) - plate).abs() >= (l(t.muted) - plate).abs() - 0.01,
            "{name}"
        );
        if t.levels == 3 {
            assert_ne!(t.label, t.text, "{name}");
            assert_ne!(t.label, t.muted, "{name}");
        }
    }
    assert!(failures.is_empty(), "{failures:#?}");
}

/// G3: a theme gets the lightest frost at which its tiers hold (three if any
/// alpha allows, else two); a theme whose muted ink can't read over the
/// worst desktop at any frost runs opaque.
#[test]
fn every_theme_frosts_only_where_its_tiers_hold() {
    use crate::tmux_snapshot::design::{frost, palette};
    for (name, theme) in catalog_themes() {
        match frost(&theme) {
            Some(alpha) => {
                assert!((0.6..=0.94).contains(&alpha), "{name}: {alpha}");
                assert!(tiers_at(&theme, Some(alpha)).levels >= 2, "{name}");
                assert!(palette(&theme).vibrancy, "{name}");
            }
            None => {
                let bezel = palette(&theme);
                assert!(!bezel.vibrancy && !bezel.glass, "{name} runs opaque");
            }
        }
    }
    // An ink that doesn't reach 4.6:1 even on its own plate can't read over
    // any desktop at any frost.
    let washed = Theme {
        background: 0xf4f4f4,
        surface: 0xeeeeee,
        foreground: 0x808080,
        muted: 0x999999,
        ..Theme::default()
    };
    assert_eq!(frost(&washed), None);
    assert!(!palette(&washed).vibrancy);
}

/// G5: the dark capsule is the flattened selected wash, which stands clear
/// of the plate in every dark catalog theme, and muted reads on it.
#[test]
fn the_dark_capsule_stands_clear_of_the_plate_and_muted_reads_on_it() {
    use crate::tmux_snapshot::{design::selected_capsule, surfaces::lstar};
    for (name, theme) in catalog_themes() {
        if crate::contrast::luminance(theme.background) >= 0.5 {
            continue;
        }
        let capsule = pack(selected_capsule(&theme).0);
        assert!(lstar(capsule) - lstar(theme.surface) >= 8., "{name}");
        assert!(
            crate::contrast::ratio(tiers(&theme).muted, capsule) >= 4.5,
            "{name}"
        );
    }
}

fn catalog(id: &str) -> Theme {
    catalog_themes()
        .into_iter()
        .find(|(name, _)| name.starts_with(&format!("{id} (")))
        .map(|(_, theme)| theme)
        .unwrap_or_else(|| panic!("{id}"))
}

/// The frost search pinned (#355 review): each theme's frost is the lowest
/// alpha that holds its tiers; one step lighter does not.
#[test]
fn the_frost_is_the_lightest_that_holds() {
    use crate::tmux_snapshot::design::frost;
    for (name, theme) in catalog_themes() {
        let Some(alpha) = frost(&theme) else {
            continue;
        };
        let levels = tiers_at(&theme, Some(alpha)).levels;
        assert!(levels >= 2, "{name}");
        // Three tiers if any alpha in range gives them.
        let three_anywhere = (60..=94).any(|n| tiers_at(&theme, Some(n as f32 / 100.)).levels == 3);
        assert_eq!(levels == 3, three_anywhere, "{name}");
        if alpha > 0.605 {
            let lighter = tiers_at(&theme, Some(alpha - 0.01)).levels;
            assert!(lighter < levels, "{name}: {alpha} is not the lightest");
        }
    }
}

/// Known values: Linen and Linen Dark frost at 0.93 and 0.89 with three
/// tiers; Nord frosts with two tiers only, at 0.91.
#[test]
fn known_themes_frost_where_measured() {
    use crate::tmux_snapshot::design::frost;
    let at = |id: &str| (frost(&catalog(id)), tiers(&catalog(id)).levels);
    assert_eq!(at("linen"), (Some(0.93), 3));
    assert_eq!(at("linen-dark"), (Some(0.89), 3));
    assert_eq!(at("nord"), (Some(0.91), 2));
}

/// The search starts at 0.60 and falls back to two tiers: black ink on a
/// white plate with grey cards never holds three tiers, holds two from well
/// under 0.60, and so frosts at exactly 0.60, no lighter.
#[test]
fn the_lightest_frost_is_sixty_percent() {
    let mut theme = Theme {
        background: 0xb0b0b0,
        surface: 0xffffff,
        foreground: 0x000000,
        ..Theme::default()
    };
    theme.palette[..16].fill(0x000000);
    assert!((50..=94).all(|n| tiers_at(&theme, Some(n as f32 / 100.)).levels == 2));
    assert_eq!(crate::tmux_snapshot::design::frost(&theme), Some(0.60));
    assert_eq!(tiers(&theme).levels, 2);
}

/// White and black are the worst desktops (#355 review, design::DESKTOPS):
/// over the glass plan's vivid ones every tier reads at least as well as its
/// worse of white and black.
#[test]
fn no_coloured_desktop_is_worse_than_white_or_black() {
    use crate::tmux_snapshot::design::frost;
    let vivid = [
        0x1c2333, 0x0a84ff, 0xff3b30, 0x34c759, 0xaf52de, 0xff9f0a, 0xffd60a,
    ];
    let plate = |surface: u32, alpha: f32, desktop: u32| {
        pack(bezel_theme::flatten(
            Hsla::from(rgb(surface)).opacity(alpha),
            rgb(desktop).into(),
        ))
    };
    for (name, theme) in catalog_themes() {
        let Some(alpha) = frost(&theme) else {
            continue;
        };
        let t = tiers(&theme);
        for ink in [t.text, t.label, t.muted] {
            let r = |d| crate::contrast::ratio(ink, plate(theme.surface, alpha, d));
            let worst = r(0xffffff).min(r(0x000000));
            for d in vivid {
                assert!(
                    r(d) >= worst - 0.02,
                    "{name}: #{d:06x} {:.2} < {worst:.2}",
                    r(d)
                );
            }
        }
    }
}
