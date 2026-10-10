#![allow(clippy::unwrap_used)]
use super::*;

#[test]
fn error_messages_are_bounded_single_lines() {
    assert_eq!(
        message(br#"{"message":"Sandbox not\nfound"}"#).as_deref(),
        Some("Sandbox not found")
    );
    assert_eq!(
        message(br#"{"message":["name must be a string","target is invalid"]}"#).as_deref(),
        Some("name must be a string; target is invalid")
    );
    assert_eq!(message(b"<html>"), None);
    let long = format!(r#"{{"message":"{}"}}"#, "x".repeat(5000));
    assert_eq!(message(long.as_bytes()).unwrap().len(), MESSAGE_LIMIT);
}

#[test]
fn rejected_keys_read_as_authentication() {
    assert!(matches!(failure("t", 401, b""), Error::Authentication));
    assert!(matches!(failure("t", 403, b""), Error::Forbidden));
    assert!(matches!(
        failure("t", 500, br#"{"message":"boom"}"#),
        Error::Status(Status { code: 500, message: Some(text) }) if text == "boom"
    ));
}
