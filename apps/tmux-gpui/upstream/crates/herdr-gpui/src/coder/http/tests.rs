#![allow(clippy::unwrap_used)]
use super::*;

#[test]
fn coder_error_messages_are_bounded_single_lines() {
    assert_eq!(
        message(br#"{"message":"Template not found.","detail":"no rows"}"#).as_deref(),
        Some("Template not found. no rows")
    );
    assert_eq!(
        message(br#"{"message":"line\nbreak"}"#).as_deref(),
        Some("line break")
    );
    let long = format!(r#"{{"message":"{}"}}"#, "x".repeat(5000));
    assert_eq!(message(long.as_bytes()).unwrap().len(), MESSAGE_LIMIT);
    assert!(message(b"<html>").is_none());
    assert!(message(br#"{"message":"  "}"#).is_none());
}

#[test]
fn bearer_header_is_sensitive() {
    let header = authorization(&"token-fixture".into()).unwrap();
    assert!(header.is_sensitive());
    assert!(!format!("{header:?}").contains("token-fixture"));
}
