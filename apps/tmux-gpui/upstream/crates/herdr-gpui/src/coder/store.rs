//! The saved Coder sign-in and the rule for using it: renew before expiry and
//! persist the rotated pair before any other request. All windows and the
//! connection workers share one record, so every access is one transaction.

use super::{Error, Result, Settings, oauth, token::Credential};
use crate::github::{Entry, read_entry, save_entry};
use secrecy::{ExposeSecret, SecretString};
use std::time::SystemTime;

const ENTRY: Entry = Entry {
    service: "dev.herdr.gpui.coder",
    account: "coder",
    label: "Herdr GPUI Coder sign-in",
    file: c"coder-credentials",
    // Decoding bounds the record at `token::LIMIT` bytes.
    validate: |value| {
        Credential::decode(value)
            .map(drop)
            .map_err(crate::Error::from)
    },
};

/// The OAuth client secret typed into Settings. Coder requires a confidential
/// client, so the secret is a credential like the sign-in, kept the same way.
const CLIENT_SECRET: Entry = Entry {
    service: "dev.herdr.gpui.coder",
    account: "oauth-client-secret",
    label: "Herdr GPUI Coder OAuth client secret",
    file: c"coder-client-secret",
    validate: |value| {
        if super::token::valid(value.expose_secret()) {
            Ok(())
        } else {
            Err(Error::Field("coder.oauth_client_secret").into())
        }
    },
};

/// The client secret saved from Settings, if any. Blocks; call from a worker.
pub(crate) fn client_secret(settings: &Settings) -> Result<Option<SecretString>> {
    read_entry(settings.store, &CLIENT_SECRET).map_err(storage)
}

/// Save or, with `None`, forget the client secret. Blocks; call from a worker.
pub(crate) fn save_client_secret(
    store: crate::github::Store,
    secret: Option<&SecretString>,
) -> Result<()> {
    save_entry(store, &CLIENT_SECRET, secret).map_err(storage)
}

// A refresh token is single-use; a second worker renewing with it would sign
// the user out. Only background workers call this; never on the UI thread.
fn transaction<T>(work: impl FnOnce() -> Result<T>) -> Result<T> {
    static ACCESS: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = ACCESS.lock().unwrap_or_else(|error| error.into_inner());
    work()
}

fn storage(error: crate::Error) -> Error {
    Error::Storage(Box::new(error))
}

fn read(settings: &Settings) -> Result<Option<SecretString>> {
    read_entry(settings.store, &ENTRY).map_err(storage)
}

fn write(settings: &Settings, value: Option<&SecretString>) -> Result<()> {
    save_entry(settings.store, &ENTRY, value).map_err(storage)
}

/// The saved record when it was issued for these settings.
fn issued(value: Option<SecretString>, settings: &Settings) -> Result<Option<Credential>> {
    let Some(value) = value else {
        return Ok(None);
    };
    let credential = Credential::decode(&value)?;
    Ok(credential.issued_for(settings).then_some(credential))
}

pub(crate) fn save(settings: &Settings, credential: &Credential) -> Result<()> {
    transaction(|| write(settings, Some(&credential.encode()?)))
}

pub(crate) fn remove(settings: &Settings) -> Result<()> {
    transaction(|| write(settings, None))
}

/// Whether a sign-in for these settings is saved. Does not contact Coder.
pub(crate) fn signed_in(settings: &Settings) -> Result<bool> {
    transaction(|| Ok(issued(read(settings)?, settings)?.is_some()))
}

/// A current access token from `saved`, renewing first when it is about to
/// expire or when `rejected` says Coder refused the last one. A renewed pair is
/// persisted before it is returned; a dead grant is removed.
fn renewed(
    saved: Option<SecretString>,
    settings: &Settings,
    rejected: bool,
    renew: impl FnOnce(&Settings, &Credential) -> Result<Credential>,
    mut persist: impl FnMut(Option<&SecretString>) -> Result<()>,
) -> Result<SecretString> {
    let saved = issued(saved, settings)?.ok_or(Error::Authentication)?;
    if !rejected && !saved.renewal_due(SystemTime::now()) {
        return Ok(saved.access_token);
    }
    if saved.refresh_token.is_none() {
        return if rejected {
            Err(Error::Authentication)
        } else {
            Ok(saved.access_token)
        };
    }
    let renewed = match renew(settings, &saved) {
        Ok(renewed) => renewed,
        Err(Error::Authentication) => {
            // The grant is gone; keeping it would only fail again.
            persist(None)?;
            return Err(Error::Authentication);
        }
        Err(error) => return Err(error),
    };
    persist(Some(&renewed.encode()?))?;
    Ok(renewed.access_token)
}

/// A token from the configured store, renewing through Coder when due.
pub(crate) fn current_token(settings: &Settings, rejected: bool) -> Result<SecretString> {
    transaction(|| {
        renewed(
            read(settings)?,
            settings,
            rejected,
            oauth::refresh,
            |value| write(settings, value),
        )
    })
}

/// Run `request` with a token from `tokens`, asking once more with
/// `rejected = true` if Coder refuses it.
pub(crate) fn with_token<T>(
    tokens: &impl Fn(bool) -> Result<SecretString>,
    mut request: impl FnMut(&SecretString) -> Result<T>,
) -> Result<T> {
    match request(&tokens(false)?) {
        Err(Error::Authentication) => request(&tokens(true)?),
        result => result,
    }
}

#[cfg(test)]
mod tests;
