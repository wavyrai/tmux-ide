#![allow(clippy::expect_used)]
use super::*;
use core::prelude::v1::test;
fn row(status: &str, attention: bool) -> Row {
    serde_json::from_value(serde_json::json!({"key":"key","sessionId":"s","paneId":"p","name":"Agent","sessionLabel":"Session","status":status,"attention":attention,"available":true})).expect("valid display fixture")
}
#[test]
fn canonical_status_precedence_and_frames() {
    for (status, expected) in [
        ("WORKING", "⠋"),
        ("BLOCKED", "!"),
        ("DONE", "✓"),
        ("FAILED", "×"),
        ("DISCONNECTED", "·"),
        ("IDLE", "○"),
    ] {
        let r = row(status, false);
        assert_eq!(glyph(&r, false, 0), expected);
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
        assert_eq!(label(&r, true), "Unavailable");
        assert!(!animated(&attention, false));
    }
    let working = row("WORKING", false);
    assert!(animated(&working, false));
    assert_ne!(glyph(&working, false, 0), glyph(&working, false, 1));
}
#[test]
fn shared_clock_is_bounded_and_stops_on_hidden_or_inactive() {
    let mut clock = Clock::default();
    let now = Instant::now();
    assert!(!clock.tick(now, true));
    clock.visible.set(true);
    assert!(clock.tick(now, true));
    assert!(!clock.tick(now + Duration::from_millis(79), true));
    assert!(clock.tick(now + Duration::from_millis(80), true));
    assert!(!clock.tick(now + Duration::from_millis(160), false));
    assert_eq!(clock.frame, 0);
    clock.begin_render();
    assert!(!clock.tick(now + Duration::from_secs(2), true));
    assert!(clock.last.is_none());
    // A new painted working row restarts; static/completed rows never register.
    clock.visible.set(true);
    assert!(clock.tick(now + Duration::from_secs(3), true));
    clock.begin_render();
    assert!(!clock.tick(now + Duration::from_secs(4), true));
}

#[test]
fn attention_idle_uses_warning_color_and_unavailability_still_wins() {
    let theme = crate::config::Theme::default();
    let attention = row("IDLE", true);
    assert_eq!(label(&attention, false), "Needs input");
    assert_eq!(glyph(&attention, false, 0), "!");
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
