#![allow(clippy::expect_used)]
use super::*;
use core::prelude::v1::test;
fn row(status: &str, attention: bool) -> Row {
    serde_json::from_value(serde_json::json!({"key":"key","sessionId":"s","paneId":"p","name":"Agent","sessionLabel":"Session","status":status,"attention":attention,"available":true})).expect("valid display fixture")
}
#[test]
fn canonical_status_precedence_and_frames() {
    for status in [
        "WORKING",
        "BLOCKED",
        "DONE",
        "FAILED",
        "DISCONNECTED",
        "IDLE",
    ] {
        let r = row(status, false);
        assert_eq!(glyph(&r, true, 1), "·");
        assert!(!animated(&r, true));
        let attention = row(status, true);
        assert_eq!(
            glyph(&attention, false, 1),
            if status == "FAILED" {
                "×"
            } else if status == "DISCONNECTED" {
                "·"
            } else {
                "!"
            }
        );
        assert!(!animated(&attention, false));
    }
    let working = row("WORKING", false);
    assert!(animated(&working, false));
    assert_ne!(glyph(&working, false, 0), glyph(&working, false, 1));
}
#[test]
fn attention_uses_warning_working_is_muted_and_unavailability_still_wins() {
    let theme = crate::config::Theme::default();
    let attention = row("IDLE", true);
    assert_eq!(
        color(&attention, false, &theme),
        theme.ink(theme.palette[3])
    );
    assert_eq!(color(&attention, true, &theme), theme.muted);
    assert_eq!(color(&row("IDLE", false), false, &theme), theme.muted);
    assert_eq!(
        color(&row("WORKING", false), false, &theme),
        theme.ink(theme.muted)
    );
    assert_eq!(
        color(&row("DISCONNECTED", true), false, &theme),
        theme.muted
    );
    assert_eq!(
        color(&row("FAILED", true), false, &theme),
        theme.ink(theme.palette[1])
    );
}

/// Working's muted mark reads at the contrast setting's ratio on the
/// background, the surface and a selected row, in every catalog variant, at
/// Standard (3:1) and High (4.5:1). The theme's raw muted does not.
#[test]
fn working_reads_on_every_catalog_variant_at_both_contrasts() {
    use crate::contrast::{Contrast, ratio};
    let presets: Vec<serde_json::Value> =
        serde_json::from_str(include_str!("appearance/catalog.json")).expect("catalog");
    let working = row("WORKING", false);
    let (mut failures, mut raw_misses, mut variants) = (Vec::new(), 0, 0);
    for preset in &presets {
        for system in ["dark", "light"] {
            let appearance: crate::tmux_snapshot::appearance::Appearance =
                serde_json::from_value(serde_json::json!({
                    "selected": preset["id"], "system": system, "error": null,
                    "options": [{"id": preset["id"], "name": "x"}],
                    "theme": preset[system]
                }))
                .expect("variant");
            for contrast in [Contrast::Standard, Contrast::High] {
                variants += 1;
                let mut theme = appearance.native();
                theme.contrast = contrast;
                let ink = color(&working, false, &theme);
                let target = contrast.mark_ratio();
                for plate in [theme.background, theme.surface, theme.active] {
                    raw_misses += usize::from(ratio(theme.muted, plate) < target);
                    let got = ratio(ink, plate);
                    if got < target - 0.01 {
                        failures.push(format!(
                            "{} ({system}, {contrast:?}): {got:.2} on {plate:06x}",
                            preset["id"]
                        ));
                    }
                }
            }
        }
    }
    assert_eq!(variants, 108, "54 variants at two contrast levels");
    assert!(
        raw_misses > 0,
        "raw muted must miss somewhere, or this proves little"
    );
    assert!(failures.is_empty(), "{failures:#?}");
}

#[path = "agent_indicator_tests/mount.rs"]
mod mount;
#[path = "agent_indicator_tests/render.rs"]
mod render;
