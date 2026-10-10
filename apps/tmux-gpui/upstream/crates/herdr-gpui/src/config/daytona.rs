//! The `[daytona]` table: a Daytona account whose sandboxes become devices.
//! A build without the `daytona` feature still parses the table, so one
//! config file serves every build, but never reads it. The API key is never
//! read from here: Settings keeps it in the credential store.
#[cfg(feature = "daytona")]
use super::Config;
#[cfg(feature = "daytona")]
use crate::Result;
use serde::Deserialize;
#[cfg(feature = "daytona")]
use std::{env, ffi::OsString, path::Path};

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct DaytonaConfig {
    /// The API root, `https://app.daytona.io/api` for Daytona's cloud.
    pub api_url: Option<String>,
    pub organization_id: Option<String>,
    /// The region new sandboxes are created in; Daytona's default if unset.
    pub target: Option<String>,
    /// The snapshot new sandboxes start from; Daytona's default if unset.
    pub snapshot: Option<String>,
    pub allow_plaintext_credentials: bool,
}

#[cfg(feature = "daytona")]
impl DaytonaConfig {
    /// The validated account settings, or `None` when Daytona is not set up.
    /// `HERDR_DAYTONA_API_URL` replaces `api_url`.
    pub(crate) fn settings(&self) -> Result<Option<crate::daytona::Settings>> {
        self.settings_with(|name| env::var_os(name))
    }

    pub(crate) fn settings_with(
        &self,
        var: impl Fn(&str) -> Option<OsString>,
    ) -> Result<Option<crate::daytona::Settings>> {
        Ok(crate::daytona::Settings::resolve(self, var)?)
    }
}

/// The `[daytona]` keys the Settings window edits. An empty value removes its
/// key.
#[cfg(feature = "daytona")]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct DaytonaFields {
    pub(crate) api_url: String,
    pub(crate) organization_id: String,
    pub(crate) target: String,
    pub(crate) snapshot: String,
}

#[cfg(feature = "daytona")]
impl DaytonaFields {
    pub(crate) fn from_config(config: &DaytonaConfig) -> Self {
        let text = |value: &Option<String>| value.clone().unwrap_or_default();
        Self {
            api_url: text(&config.api_url),
            organization_id: text(&config.organization_id),
            target: text(&config.target),
            snapshot: text(&config.snapshot),
        }
    }

    fn entries(&self) -> [(&'static str, &str); 4] {
        [
            ("api_url", &self.api_url),
            ("organization_id", &self.organization_id),
            ("target", &self.target),
            ("snapshot", &self.snapshot),
        ]
    }

    /// The checks loading applies, so a save cannot leave a config that then
    /// fails to load.
    fn validate(&self, existing: &DaytonaConfig) -> Result<()> {
        let value = |text: &str| {
            let text = text.trim();
            (!text.is_empty()).then(|| text.to_owned())
        };
        let config = DaytonaConfig {
            api_url: value(&self.api_url),
            organization_id: value(&self.organization_id),
            target: value(&self.target),
            snapshot: value(&self.snapshot),
            ..existing.clone()
        };
        config.settings_with(|_| None).map(drop)
    }
}

#[cfg(feature = "daytona")]
impl Config {
    /// Write the `[daytona]` keys Settings edits to the local override file.
    pub(crate) fn save_daytona(fields: &DaytonaFields, existing: &DaytonaConfig) -> Result<()> {
        fields.validate(existing)?;
        let (_lock, local) = Self::prepare_files(&Self::path()?)?;
        Self::save_daytona_path(fields, &local)
    }

    fn save_daytona_path(fields: &DaytonaFields, path: &Path) -> Result<()> {
        super::table::save_keys(path, "daytona", &fields.entries())
    }
}

#[cfg(all(test, feature = "daytona"))]
mod tests;
