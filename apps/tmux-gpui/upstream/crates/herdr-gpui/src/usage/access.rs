//! The providers the user let read another app's Keychain item, such as Zed's
//! sign-in. Reading one makes macOS ask, so nothing asks until the user
//! presses Allow in that provider's usage panel. The answer is kept across
//! launches, so a user who chose "Always Allow" sees numbers at startup
//! without asking again; a denial takes the grant back so a later launch does
//! not ask in the background.

use super::{model::Provider, registry};
use crate::state_file;
use gpui::{App, Global};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeSet, HashSet},
    path::PathBuf,
};

const MAX_FILE_BYTES: u64 = 16 * 1024;

#[derive(Default, Serialize, Deserialize)]
struct Saved {
    providers: BTreeSet<String>,
}

#[derive(Default)]
pub(crate) struct KeychainGrants {
    granted: HashSet<Provider>,
    path: Option<PathBuf>,
}

impl Global for KeychainGrants {}

impl KeychainGrants {
    fn path() -> Option<PathBuf> {
        crate::preferences::state_dir().map(|dir| dir.join("usage-keychain.json"))
    }

    /// Called before starting GPUI. A missing or damaged file grants nothing.
    pub(crate) fn load() -> Self {
        let path = Self::path();
        let granted = path
            .as_deref()
            .and_then(|path| match state_file::read(path, MAX_FILE_BYTES) {
                Ok(bytes) => bytes,
                Err(error) => {
                    tracing::warn!(%error, "Cannot read usage Keychain grants");
                    None
                }
            })
            .and_then(|bytes| parse_saved(&bytes).ok())
            .unwrap_or_default();
        Self { granted, path }
    }

    pub(crate) fn install(self, cx: &mut App) {
        cx.set_global(self);
    }

    pub(crate) fn granted(cx: &App) -> HashSet<Provider> {
        cx.try_global::<Self>()
            .map(|grants| grants.granted.clone())
            .unwrap_or_default()
    }

    pub(crate) fn grant(provider: Provider, cx: &mut App) {
        Self::change(cx, |granted| granted.insert(provider));
    }

    pub(crate) fn revoke(provider: Provider, cx: &mut App) {
        Self::change(cx, |granted| granted.remove(&provider));
    }

    /// Applies `edit` and saves off the UI thread when it changed anything.
    fn change(cx: &mut App, edit: impl FnOnce(&mut HashSet<Provider>) -> bool) {
        if !cx.has_global::<Self>() {
            cx.set_global(Self::default());
        }
        let grants = cx.global_mut::<Self>();
        if !edit(&mut grants.granted) {
            return;
        }
        let Some(path) = grants.path.clone() else {
            return;
        };
        let saved = Saved {
            providers: grants
                .granted
                .iter()
                .map(|provider| provider.id().to_owned())
                .collect(),
        };
        cx.background_executor()
            .spawn(async move {
                if let Err(error) = state_file::write(&path, &saved) {
                    tracing::warn!(%error, "Cannot save usage Keychain grants");
                }
            })
            .detach();
    }
}

/// Known providers only: an id this build does not have grants nothing.
pub(super) fn parse_saved(bytes: impl AsRef<[u8]>) -> serde_json::Result<HashSet<Provider>> {
    let saved: Saved = serde_json::from_slice(bytes.as_ref())?;
    Ok(saved
        .providers
        .iter()
        .filter_map(|id| registry::find(id))
        .collect())
}
