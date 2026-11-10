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
