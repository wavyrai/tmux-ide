#![allow(clippy::unwrap_used)]
use super::*;
use crate::github::{Reply, device::token_reply};

fn credential() -> Credential {
    Credential::new("old-access".into(), Some("old-refresh".into()), "client").unwrap()
}

fn renewed() -> Credential {
    Credential::new("new-access".into(), Some("new-refresh".into()), "client").unwrap()
}

fn profile(token: Arc<SecretString>) -> Result<Profile> {
    if token.expose_secret() == "old-access" {
        return Err(Error::GitHubAuthentication);
    }
    Ok(Profile {
        login: "fixture".into(),
        avatar: None,
        token,
        avatar_updates: None,
    })
}

#[test]
fn expiry_survives_storage_and_renews_before_the_first_profile_request() {
    let now = std::time::UNIX_EPOCH + Duration::from_secs(1_000_000);
    let value = credential().with_expiry(Some(3600), now);
    let restored = Credential::decode(&value.encode().unwrap()).unwrap();
    assert!(!restored.renewal_due(now + Duration::from_secs(2999)));
    assert!(restored.renewal_due(now + Duration::from_secs(3000)));
    assert!(restored.renewal_due(now + Duration::from_secs(3601)));

    let persisted = std::cell::Cell::new(false);
    let loaded = restored
        .profile_with(
            |token| {
                assert!(persisted.get(), "persist before any authenticated request");
                assert_eq!(token.expose_secret(), "new-access");
                profile(token)
            },
            |_| Ok(renewed()),
            |_| {
                persisted.set(true);
                Ok(())
            },
        )
        .unwrap();
    assert_eq!(loaded.token.expose_secret(), "new-access");
}

#[test]
fn oauth_expiry_is_preserved_and_missing_or_overflowing_expiry_is_safe() {
    let reply: TokenResponse = serde_json::from_str(
        r#"{"access_token":"access","refresh_token":"refresh","token_type":"bearer","expires_in":28800}"#,
    )
    .unwrap();
    let Reply::Token(value) = token_reply(reply, "client").unwrap() else {
        panic!("expected credential");
    };
    assert!(value.expires_at.is_some());
    assert_eq!(
        Credential::decode(&value.encode().unwrap())
            .unwrap()
            .expires_at,
        value.expires_at
    );
    assert!(!value.renewal_due(std::time::SystemTime::now()));
    assert!(!credential().renewal_due(std::time::SystemTime::now()));
    assert!(
        credential()
            .with_expiry(Some(u64::MAX), std::time::SystemTime::now())
            .expires_at
            .is_none()
    );
}

#[test]
fn restart_renews_expired_saved_token_and_persists_the_rotated_pair() {
    let disk = std::cell::RefCell::new(credential().encode().unwrap());
    let restored = Credential::decode(&disk.borrow()).unwrap();
    let loaded = restored
        .profile_with(
            |token| {
                if token.expose_secret() == "new-access" {
                    assert_eq!(
                        Credential::decode(&disk.borrow())
                            .unwrap()
                            .access_token
                            .expose_secret(),
                        "new-access"
                    );
                }
                profile(token)
            },
            |old| {
                assert_eq!(
                    old.refresh_token.as_ref().unwrap().expose_secret(),
                    "old-refresh"
                );
                assert_eq!(old.client_id, "client");
                Ok(renewed())
            },
            |value| {
                *disk.borrow_mut() = value.expose_secret().into();
                Ok(())
            },
        )
        .unwrap();
    assert_eq!(loaded.token.expose_secret(), "new-access");
    let saved = Credential::decode(&disk.borrow()).unwrap();
    assert_eq!(
        saved.refresh_token.as_ref().unwrap().expose_secret(),
        "new-refresh"
    );
    saved
        .profile_with(
            profile,
            |_| panic!("no second refresh"),
            |_| panic!("no rewrite"),
        )
        .unwrap();
}

#[test]
fn legacy_and_nonexpiring_tokens_survive_without_rotation() {
    let old = Credential::decode(&" legacy-token ".into()).unwrap();
    assert_eq!(old.encode().unwrap().expose_secret(), "legacy-token");
    assert!(old.refresh_token.is_none());
    old.profile_with(
        profile,
        |_| panic!("legacy cannot refresh"),
        |_| panic!("legacy cannot write"),
    )
    .unwrap();
    assert!(matches!(
        Credential::decode(&"old-access".into())
            .unwrap()
            .profile_with(profile, |_| panic!(), |_| panic!()),
        Err(Error::GitHubAuthentication)
    ));
}

#[test]
fn refresh_can_replace_an_expiring_pair_with_a_nonexpiring_access_only_token() {
    let saved = std::cell::RefCell::new(credential().encode().unwrap());
    let loaded = credential()
        .profile_with(
            |token| {
                if token.expose_secret() == "new-access" {
                    assert_eq!(saved.borrow().expose_secret(), "new-access");
                }
                profile(token)
            },
            |old| {
                let response: TokenResponse =
                    serde_json::from_str(r#"{"access_token":"new-access","token_type":"bearer"}"#)
                        .unwrap();
                let Reply::Token(renewed) = token_reply(response, &old.client_id)? else {
                    panic!("an access-only refresh response is valid");
                };
                assert!(renewed.refresh_token.is_none());
                Ok(renewed)
            },
            |value| {
                *saved.borrow_mut() = value.expose_secret().into();
                Ok(())
            },
        )
        .unwrap();
    assert_eq!(loaded.token.expose_secret(), "new-access");
    let restored = Credential::decode(&saved.borrow()).unwrap();
    assert!(restored.refresh_token.is_none());
    assert_eq!(
        restored
            .profile_with(
                profile,
                |_| panic!("nonexpiring token must not refresh"),
                |_| panic!("no rewrite"),
            )
            .unwrap()
            .token
            .expose_secret(),
        "new-access"
    );
}

#[test]
fn transient_failure_never_refreshes_or_deletes_saved_credentials() {
    for error in [
        Error::GitHubRateLimit,
        Error::GitHubStatus(500),
        Error::GitHubForbidden,
    ] {
        let mut error = Some(error);
        assert!(
            credential()
                .profile_with(
                    |_| Err(error.take().unwrap()),
                    |_| panic!("must not refresh"),
                    |_| panic!("must not write")
                )
                .is_err()
        );
    }
}

#[test]
fn refresh_and_persistence_failures_are_reported_without_profile_retry() {
    assert!(matches!(
        credential().profile_with(
            profile,
            |_| Err(Error::GitHubDenied),
            |_| panic!("failed rotation must not write")
        ),
        Err(Error::GitHubDenied)
    ));
    assert!(matches!(
        credential().profile_with(
            |token| {
                assert_eq!(token.expose_secret(), "old-access");
                Err(Error::GitHubAuthentication)
            },
            |_| Ok(renewed()),
            |_| Err(Error::CredentialPolicy)
        ),
        Err(Error::CredentialPolicy)
    ));
    let wrote = std::cell::Cell::new(false);
    assert!(matches!(
        credential().profile_with(
            |token| {
                if token.expose_secret() == "old-access" {
                    Err(Error::GitHubAuthentication)
                } else {
                    assert!(wrote.get());
                    Err(Error::GitHubStatus(503))
                }
            },
            |_| Ok(renewed()),
            |_| {
                wrote.set(true);
                Ok(())
            }
        ),
        Err(Error::GitHubStatus(503))
    ));
    assert!(wrote.get());
}

#[test]
fn stored_records_are_bounded_validated_and_redacted() {
    let value = credential();
    let debug = format!("{value:?}");
    assert!(!debug.contains("old-access"));
    assert!(!debug.contains("old-refresh"));
    for record in [
        r#"{"version":2,"access_token":"secret","refresh_token":"secret","client_id":"client"}"#,
        r#"{"version":1,"access_token":"secret","refresh_token":"","client_id":"client"}"#,
        r#"{"version":1,"access_token":"secret","refresh_token":"secret","client_id":""}"#,
        r#"{"version":1,"access_token":"secret","refresh_token":123,"client_id":"client"}"#,
        r#"{"version":1,"access_token":"secret","refresh_token":"secret","client_id":"client","extra":0}"#,
        "bad\ntoken",
    ] {
        let error = Credential::decode(&record.into()).unwrap_err();
        assert!(!format!("{error:?}").contains("secret"));
        assert!(!error.to_string().contains("secret"));
    }
    assert!(Credential::decode(&"x".repeat(LIMIT + 1).into()).is_err());
    assert!(Credential::new("x".repeat(4097).into(), None, "client").is_err());
}
