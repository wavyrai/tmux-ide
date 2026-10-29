//! How the saved terminal family last resolved on this machine. A launch that
//! finds it paints with the same family and icon fallbacks without
//! enumerating every installed font; the font picker refreshes it.
use super::{read_json, valid_name, write_json};
use crate::config::FontConfig;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// Far above the three detected fallbacks, so a hand-edited cascade survives.
const MAX_FALLBACKS: usize = 16;

#[derive(Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Resolved {
    version: u8,
    /// The family the preferences file names.
    family: String,
    /// The family that family resolved to.
    resolved: String,
    fallbacks: Vec<String>,
}

impl Resolved {
    pub(super) fn new(family: &str, config: &FontConfig) -> Option<Self> {
        let value = Self {
            version: 1,
            family: family.to_owned(),
            resolved: config.family.clone(),
            fallbacks: config.fallbacks.clone()?,
        };
        value.valid().then_some(value)
    }

    fn valid(&self) -> bool {
        self.version == 1
            && valid_name(&self.family)
            && valid_name(&self.resolved)
            && self.fallbacks.len() <= MAX_FALLBACKS
            && self.fallbacks.iter().all(|name| valid_name(name))
    }

    /// Applies the cached resolution when it was made for `family`.
    pub(super) fn apply(self, family: &str, config: &mut FontConfig) -> bool {
        if self.family != family {
            return false;
        }
        config.family = self.resolved;
        config.fallbacks = Some(self.fallbacks);
        true
    }
}

pub(super) fn path(preferences: &Path) -> PathBuf {
    preferences.with_file_name("gpui-font-cache.json")
}

pub(super) fn read(preferences: &Path) -> Option<Resolved> {
    read_json::<Resolved>(&path(preferences))
        .ok()
        .filter(Resolved::valid)
}

/// Best effort: a missing cache only costs the next launch one enumeration.
pub(super) fn write(preferences: &Path, value: &Resolved) {
    let _ = write_json(&path(preferences), value);
}
