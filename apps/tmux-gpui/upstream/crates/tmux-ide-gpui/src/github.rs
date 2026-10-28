//! Native GitHub transport and device authorization. No credential subprocesses.

mod auth;
mod credentials;
mod device;
mod http;
mod log;
#[cfg(target_os = "linux")]
mod secret_service;
mod store;
mod token;

#[cfg(test)]
mod tests;

pub(crate) use {
    auth::Auth,
    device::{Profile, VERIFY_URL},
    http::{graphql, mutation},
    store::{Account, Note, Store},
};
// Cloud providers keep their own secrets in the same store.
#[cfg(feature = "cloud")]
pub(crate) use store::{Entry, read_entry, save_entry};

use crate::Result;
use device::{Device, Reply, SETUP_MESSAGE, profile, token_reply};
use store::{save, valid_token};

/// Delete one account's saved credential, as signing it out does, for an
/// account whose panel is going away with its device. Blocks on the store:
/// call it from a background thread.
pub(crate) fn forget(store: Store, account: &Account) -> Result<()> {
    save(None, store, account)
}
