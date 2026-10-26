use super::super::*;
use super::transport::options;
use crate::tmux_graphics::surface_control::{Control, FallbackReason};
#[test]
fn native_controls_follow_existing_command_direction_and_bounds() {
    let mut control = Control::new(uuid::Uuid::from_u128(1), 123, 0, [1; 8]).unwrap();
    for frame in [
        control.receiver_frame().unwrap(),
        control.fallback_frame(FallbackReason::Unsupported).unwrap(),
        control
            .retirement_frame(crate::tmux_graphics::surface_leases::Retirement { sequence: 1 })
            .unwrap(),
    ] {
        assert!(Command::from_json(frame).is_ok());
    }
    for kind in ["terminal-surface-offer", "terminal-surface-peer"] {
        assert!(matches!(
            Command::from_json(serde_json::json!({"type":kind}).to_string()),
            Err(Error::Frame)
        ));
    }
}
#[test]
fn native_server_controls_require_authenticated_readiness_and_small_frames() {
    let mut control = Control::new(uuid::Uuid::from_u128(1), 123, 0, [1; 8]).unwrap();
    let fallback = control.fallback_frame(FallbackReason::Unsupported).unwrap();
    assert!(wire::parse(&fallback, &options(12345), false).is_err());
    let Event::Control(raw) = wire::parse(&fallback, &options(12345), true).unwrap() else {
        panic!("control expected");
    };
    assert_eq!(raw.get(), fallback);
    assert!(matches!(
        wire::parse(&(" ".repeat(16385) + &fallback), &options(12345), true),
        Err(Error::FrameBound)
    ));
    assert!(
        wire::parse(
            r#"{"type":"terminal-surface-retired","version":1,"sequence":1}"#,
            &options(12345),
            true
        )
        .is_err()
    );
}
