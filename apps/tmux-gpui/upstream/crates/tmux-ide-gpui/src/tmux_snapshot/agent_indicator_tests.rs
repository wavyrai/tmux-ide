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
fn attention_idle_uses_warning_color_and_unavailability_still_wins() {
    let theme = crate::config::Theme::default();
    let attention = row("IDLE", true);
    assert_eq!(
        color(&attention, false, &theme),
        theme.ink(theme.palette[3])
    );
    assert_eq!(color(&attention, true, &theme), theme.muted);
    assert_eq!(color(&row("IDLE", false), false, &theme), theme.muted);
    assert_eq!(
        color(&row("DISCONNECTED", true), false, &theme),
        theme.muted
    );
    assert_eq!(
        color(&row("FAILED", true), false, &theme),
        theme.ink(theme.palette[1])
    );
}

#[path = "agent_indicator_tests/mount.rs"]
mod mount;
#[path = "agent_indicator_tests/render.rs"]
mod render;
