#![allow(clippy::unwrap_used)]
use super::*;
use crate::coder::tests::settings;
use secrecy::ExposeSecret;
use std::cell::{Cell, RefCell};

#[derive(Default)]
struct Memory(RefCell<Option<String>>);

impl Memory {
    fn saved(&self) -> Option<SecretString> {
        self.0.borrow().as_deref().map(SecretString::from)
    }
    fn token(
        &self,
        settings: &Settings,
        rejected: bool,
        renew: impl FnOnce(&Settings, &Credential) -> Result<Credential>,
    ) -> Result<SecretString> {
        renewed(self.saved(), settings, rejected, renew, |value| {
            *self.0.borrow_mut() = value.map(|v| v.expose_secret().to_owned());
            Ok(())
        })
    }
    fn load(&self) -> Option<Credential> {
        issued(self.saved(), &settings()).unwrap()
    }
}

fn credential(access: &str, expires_at: Option<u64>) -> Credential {
    Credential::new(
        &settings(),
        access.into(),
        Some(format!("{access}-refresh").into()),
        expires_at,
    )
    .unwrap()
}

fn saved(credential: &Credential) -> Memory {
    Memory(RefCell::new(Some(
        credential.encode().unwrap().expose_secret().to_owned(),
    )))
}

#[test]
fn a_fresh_token_is_used_without_renewal() {
    let vault = saved(&credential("old", None));
    let token = vault
        .token(&settings(), false, |_, _| panic!("no renewal"))
        .unwrap();
    assert_eq!(token.expose_secret(), "old");
}

#[test]
fn an_expiring_token_is_renewed_and_persisted_before_use() {
    let vault = saved(&credential("old", Some(0)));
    let token = vault
        .token(&settings(), false, |_, saved| {
            assert_eq!(
                saved.refresh_token.as_ref().unwrap().expose_secret(),
                "old-refresh"
            );
            Ok(credential("new", None))
        })
        .unwrap();
    assert_eq!(token.expose_secret(), "new");
    let stored = vault.load().unwrap();
    assert_eq!(stored.access_token.expose_secret(), "new");
    assert_eq!(stored.refresh_token.unwrap().expose_secret(), "new-refresh");
}

#[test]
fn a_rejected_token_renews_once_and_a_dead_grant_signs_out() {
    let vault = saved(&credential("old", None));
    let calls = Cell::new(0);
    let token = vault
        .token(&settings(), true, |_, _| {
            calls.set(calls.get() + 1);
            Ok(credential("new", None))
        })
        .unwrap();
    assert_eq!((token.expose_secret(), calls.get()), ("new", 1));

    let result = vault.token(&settings(), true, |_, _| Err(Error::Authentication));
    assert!(matches!(result, Err(Error::Authentication)));
    assert!(vault.0.borrow().is_none());
}

#[test]
fn transient_renewal_failures_keep_the_saved_sign_in() {
    let vault = saved(&credential("old", Some(0)));
    let result = vault.token(&settings(), false, |_, _| {
        Err(crate::coder::Status {
            code: 503,
            message: None,
        }
        .into())
    });
    assert!(matches!(result, Err(Error::Status(_))));
    assert!(vault.load().is_some());
}

#[test]
fn another_deployments_sign_in_reads_as_signed_out() {
    let vault = saved(&credential("old", None));
    let mut other = settings();
    other.base = "https://other.example.com".into();
    assert!(issued(vault.saved(), &other).unwrap().is_none());
    assert!(matches!(
        vault.token(&other, false, |_, _| panic!("never sent")),
        Err(Error::Authentication)
    ));
    assert!(vault.load().is_some());
}
