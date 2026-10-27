#![allow(clippy::unwrap_used)]

use super::{Auth, Device, Note, Profile, Reply, SETUP_MESSAGE, Store, VERIFY_URL};
use super::{
    credentials,
    device::TokenResponse,
    http::{LIMIT, authorization, graphql, pr_cooldown, rejection, response},
    log::{header, kind, public_sso, token_kind},
    store,
    store::{KEYRING, credential_bytes},
    token::Credential,
};
use crate::{Error, Result};
use secrecy::{ExposeSecret, SecretString};
use serde_json::Value;
use std::{
    sync::{Arc, mpsc},
    thread,
    time::{Duration, Instant},
};

mod device_auth;
mod rejection;
mod responses;
mod session;
mod signout;
mod storage;

fn device() -> Device {
    serde_json::from_str::<Device>(r#"{"device_code":"fixture-device", "user_code":"ABCD-1234", "verification_uri":"https://github.com/login/device", "expires_in":900, "interval":5}"#).unwrap().validate().unwrap()
}
fn credential(token: &str) -> Credential {
    Credential::new(token.into(), None, "fixture-client").unwrap()
}
fn deliver(auth: &mut Auth, reply: Result<Reply>) {
    let (tx, rx) = mpsc::sync_channel(1);
    tx.send(reply).ok().unwrap();
    auth.incoming = Some(rx);
}
fn waiting() -> Auth {
    let mut auth = Auth::default();
    deliver(
        &mut auth,
        Ok(Reply::Device(
            device(),
            "fixture-client".into(),
            Instant::now(),
        )),
    );
    assert!(auth.poll());
    auth
}
