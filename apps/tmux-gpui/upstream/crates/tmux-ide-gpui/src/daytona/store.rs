//! The Daytona API key, kept like every other credential this app saves:
//! the macOS Keychain, the Linux Secret Service, or with an explicit opt-in a
//! private file. `HERDR_DAYTONA_API_KEY` takes precedence when set.

use super::{Error, Result, Settings};
use crate::github::{Entry, Store, read_entry, save_entry};
use secrecy::{ExposeSecret, SecretString};

pub(crate) const VARIABLE: &str = "HERDR_DAYTONA_API_KEY";
const KEY_LIMIT: usize = 512;

fn valid(key: &str) -> bool {
    !key.is_empty() && key.len() <= KEY_LIMIT && key.bytes().all(|b| b.is_ascii_graphic())
}

const ENTRY: Entry = Entry {
    service: "dev.herdr.gpui.daytona",
    account: "api-key",
    label: "Herdr GPUI Daytona API key",
    file: c"daytona-api-key",
    validate: |value| {
        if valid(value.expose_secret()) {
            Ok(())
        } else {
            Err(Error::Field("Daytona API key").into())
        }
    },
};

fn storage(error: crate::Error) -> Error {
    Error::Storage(Box::new(error))
}

/// The key from the environment; checked so it cannot break a header.
fn from_environment() -> Result<Option<SecretString>> {
    let Some(value) = std::env::var_os(VARIABLE) else {
        return Ok(None);
    };
    let value = value.into_string().map_err(|_| Error::Encoding(VARIABLE))?;
    if !valid(value.trim()) {
        return Err(Error::Field(VARIABLE));
    }
    Ok(Some(value.trim().to_owned().into()))
}

/// The key to use: the environment's, else the saved one. Blocks on the
/// credential store; call from a worker.
pub(crate) fn key(settings: &Settings) -> Result<SecretString> {
    if let Some(key) = from_environment()? {
        return Ok(key);
    }
    saved(settings.store)?.ok_or(Error::MissingKey)
}

pub(crate) fn saved(store: Store) -> Result<Option<SecretString>> {
    read_entry(store, &ENTRY).map_err(storage)
}

/// Save or, with `None`, forget the key. Blocks; call from a worker.
pub(crate) fn save(store: Store, key: Option<&SecretString>) -> Result<()> {
    if key.is_some_and(|key| !valid(key.expose_secret())) {
        return Err(Error::Field("Daytona API key"));
    }
    save_entry(store, &ENTRY, key).map_err(storage)
}
