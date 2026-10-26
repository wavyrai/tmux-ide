#![allow(clippy::unwrap_used)]
use super::*;
#[test]
fn receipt_requires_exact_operation_and_generation() {
    let id = Uuid::new_v4();
    let generation = Uuid::new_v4().to_string();
    let mut receipt = serde_json::json!({"operationId":id.to_string(),"daemonInstanceId":generation,"outcome":"created","fleetSessionId":"session.0123456789abcdef","workspaceName":"canonical","displayName":"visible","liveSessionId":"live-session.0123456789abcdef0123"});
    let bytes = serde_json::to_vec(&receipt).unwrap();
    assert!(parse(&bytes, id, &generation).is_ok());
    assert!(matches!(
        parse(&bytes, Uuid::new_v4(), &generation),
        Err(Error::ServerChanged)
    ));
    assert!(matches!(
        parse(&bytes, id, "replacement"),
        Err(Error::ServerChanged)
    ));
    receipt["liveSessionId"] = "canonical".into();
    assert!(parse(&serde_json::to_vec(&receipt).unwrap(), id, &generation).is_err());
}
#[test]
fn creation_names_cannot_be_options_or_control_sequences() {
    for value in ["", "-L", "bad\nname", "bad\u{7f}", "bad\u{85}"] {
        assert!(!valid_display(value));
    }
    assert!(valid_display("My shell 🚀"));
    assert!(!valid_display(&"x".repeat(101)));
}
