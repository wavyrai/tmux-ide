#![allow(clippy::unwrap_used)]
use super::*;
use crate::coder::tests::settings;

fn credential(expires_at: Option<u64>) -> Credential {
    Credential::new(
        &settings(),
        "access-fixture".into(),
        Some("refresh-fixture".into()),
        expires_at,
    )
    .unwrap()
}

#[test]
fn record_roundtrips_and_is_redacted() {
    let value = credential(Some(123));
    let restored = Credential::decode(&value.encode().unwrap()).unwrap();
    assert_eq!(restored.access_token.expose_secret(), "access-fixture");
    assert_eq!(
        restored.refresh_token.unwrap().expose_secret(),
        "refresh-fixture"
    );
    assert_eq!(restored.expires_at, Some(123));
    assert!(restored.deployment == settings().base);
    let debug = format!("{value:?}");
    assert!(!debug.contains("access-fixture") && !debug.contains("refresh-fixture"));
}

#[test]
fn renewal_is_due_shortly_before_expiry_and_only_with_a_refresh_token() {
    let now = UNIX_EPOCH + Duration::from_secs(1_000_000);
    let at = |seconds: u64| Some(1_000_000 + seconds);
    assert!(!credential(at(3600)).renewal_due(now));
    assert!(credential(at(300)).renewal_due(now));
    assert!(credential(at(0)).renewal_due(now));
    assert!(!credential(None).renewal_due(now));
    let mut access_only = credential(at(0));
    access_only.refresh_token = None;
    assert!(!access_only.renewal_due(now));
    assert_eq!(expiry(Some(60), now), at(60));
    assert_eq!(expiry(Some(u64::MAX), now), None);
    assert_eq!(expiry(None, now), None);
}

#[test]
fn records_from_another_deployment_or_client_are_not_used() {
    let value = credential(None);
    assert!(value.issued_for(&settings()));
    let mut other = settings();
    other.base = "https://other.example.com".into();
    assert!(!value.issued_for(&other));
    let mut other = settings();
    other.client_id = "other-client".into();
    assert!(!value.issued_for(&other));
}

#[test]
fn malformed_records_are_rejected_without_echoing_secrets() {
    for record in [
        r#"{"version":2,"deployment":"d","client_id":"c","access_token":"secret","refresh_token":null}"#,
        r#"{"version":1,"deployment":"","client_id":"c","access_token":"secret","refresh_token":null}"#,
        r#"{"version":1,"deployment":"d","client_id":"c","access_token":"","refresh_token":null}"#,
        r#"{"version":1,"deployment":"d","client_id":"c","access_token":"se cret","refresh_token":null}"#,
        r#"{"version":1,"deployment":"d","client_id":"c","access_token":"secret","refresh_token":"","extra":1}"#,
        "secret",
    ] {
        let error = Credential::decode(&record.into()).unwrap_err();
        assert!(!format!("{error:?}").contains("secret"));
        assert!(!error.to_string().contains("secret"));
    }
    assert!(Credential::decode(&"x".repeat(LIMIT + 1).into()).is_err());
}
