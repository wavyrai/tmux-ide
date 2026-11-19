//! Local appearance ownership on the catalog thread, independent of SSH routes.
//! Palettes are generated from the shared contracts; no runtime Node process.
use super::{Appearance, Colors, OptionItem, System};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};
const LIMIT: u64 = 1024 * 1024;
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(in crate::tmux_snapshot) struct Preset {
    pub id: String,
    pub name: String,
    /// "system", "light" or "dark".
    pub mode: String,
    pub dark: Colors,
    pub light: Colors,
}
/// The generated catalog, read once. Empty only if it fails to parse, which
/// `Owner::load` reports by refusing to start.
pub(in crate::tmux_snapshot) fn catalog() -> &'static [Preset] {
    static CATALOG: std::sync::OnceLock<Vec<Preset>> = std::sync::OnceLock::new();
    CATALOG.get_or_init(|| serde_json::from_str(include_str!("catalog.json")).unwrap_or_default())
}
/// The themes Match macOS uses until the user picks others.
pub(in crate::tmux_snapshot) const DEFAULT_LIGHT: &str = "linen";
pub(in crate::tmux_snapshot) const DEFAULT_DARK: &str = "linen-dark";
/// The theme `id` if it is one of `side`'s kind, for Match macOS.
fn side_theme(id: Option<&str>, side: System) -> Option<&'static Preset> {
    let mode = match side {
        System::Light => "light",
        System::Dark => "dark",
    };
    catalog()
        .iter()
        .find(|p| Some(p.id.as_str()) == id && p.mode == mode)
}
pub(in crate::tmux_snapshot) struct Owner {
    presets: Vec<Preset>,
    path: Option<PathBuf>,
    namespace: Option<herdr_client::tmux_daemon::LocalConfigNamespace>,
    state: Appearance,
}
impl Owner {
    pub(in crate::tmux_snapshot) fn from_environment(record: Option<PathBuf>) -> Option<Self> {
        let namespace = herdr_client::tmux_daemon::LocalConfigNamespace::capture(record);
        let mut owner = Self::load(namespace.as_ref().and_then(|ns| ns.resolve()))?;
        owner.namespace = namespace;
        Some(owner)
    }
    pub(in crate::tmux_snapshot) fn load(path: Option<PathBuf>) -> Option<Self> {
        let presets: Vec<Preset> = serde_json::from_str(include_str!("catalog.json")).ok()?;
        let config = path
            .as_ref()
            .and_then(|p| read(p).ok().flatten())
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .unwrap_or(Value::Null);
        let theme = &config["theme"];
        let selected = theme["preset"]
            .as_str()
            .filter(|id| {
                presets
                    .iter()
                    .any(|p| p.id == *id && !["system", "light", "dark"].contains(id))
            })
            .or_else(|| {
                theme["mode"]
                    .as_str()
                    .filter(|id| ["system", "light", "dark"].contains(id))
            })
            .unwrap_or("system");
        let initial = presets.iter().find(|p| p.id == selected)?;
        let pair = |side: System, fallback: &str| -> String {
            let key = match side {
                System::Light => "light",
                System::Dark => "dark",
            };
            side_theme(theme[key].as_str(), side).map_or_else(|| fallback.into(), |p| p.id.clone())
        };
        let state = Appearance {
            selected: selected.into(),
            system: System::Dark,
            theme: initial.dark.clone(),
            options: presets
                .iter()
                .map(|p| OptionItem {
                    id: p.id.clone(),
                    name: p.name.clone(),
                })
                .collect(),
            error: None,
            light: pair(System::Light, DEFAULT_LIGHT),
            dark: pair(System::Dark, DEFAULT_DARK),
        };
        for preset in &presets {
            for theme in [&preset.dark, &preset.light] {
                let mut check = state.clone();
                check.selected.clone_from(&preset.id);
                check.theme = theme.clone();
                if !check.valid() || !["system", "dark", "light"].contains(&preset.mode.as_str()) {
                    return None;
                }
            }
        }
        let mut owner = Self {
            presets,
            path,
            namespace: None,
            state,
        };
        owner.resolve();
        Some(owner)
    }
    pub(in crate::tmux_snapshot) fn publication(&self) -> Appearance {
        self.state.clone()
    }
    pub(in crate::tmux_snapshot) fn system(&mut self, next: System) -> bool {
        if next == self.state.system {
            return false;
        }
        self.state.system = next;
        self.resolve();
        true
    }
    fn resolve(&mut self) {
        // Match macOS: the chosen theme for the side macOS is on.
        let id = if self.state.selected == "system" {
            match self.state.system {
                System::Light => &self.state.light,
                System::Dark => &self.state.dark,
            }
        } else {
            &self.state.selected
        };
        if let Some(preset) = self.presets.iter().find(|p| p.id == *id) {
            self.state.theme = match self.state.system {
                System::Dark => &preset.dark,
                System::Light => &preset.light,
            }
            .clone();
        }
    }
    pub(in crate::tmux_snapshot) fn select(&mut self, id: &str) {
        let Some(preset) = self.presets.iter().find(|p| p.id == id) else {
            self.state.error = Some("Unknown theme — choose an available theme".into());
            return;
        };
        let preset_key = if ["system", "dark", "light"].contains(&id) {
            ""
        } else {
            id
        };
        let mode = preset.mode.clone();
        if !self.save(&[("mode", json!(mode)), ("preset", json!(preset_key))]) {
            return;
        }
        self.state.selected = id.into();
        self.state.error = None;
        self.resolve();
    }
    /// Match macOS with `id` as its theme for `side`; the other side stays.
    pub(in crate::tmux_snapshot) fn select_for(&mut self, side: System, id: &str) {
        let Some(preset) = side_theme(Some(id), side) else {
            self.state.error = Some("Unknown theme — choose an available theme".into());
            return;
        };
        let key = match side {
            System::Light => "light",
            System::Dark => "dark",
        };
        if !self.save(&[
            ("mode", json!("system")),
            ("preset", json!("")),
            (key, json!(preset.id)),
        ]) {
            return;
        }
        match side {
            System::Light => self.state.light.clone_from(&preset.id),
            System::Dark => self.state.dark.clone_from(&preset.id),
        }
        self.state.selected = "system".into();
        self.state.error = None;
        self.resolve();
    }
    /// Writes `entries` into config.json's theme block, re-resolving the
    /// path first; says so in `error` when it can't.
    fn save(&mut self, entries: &[(&str, Value)]) -> bool {
        // Re-resolve before every write; a development ancestor may have changed.
        let moved = self
            .namespace
            .as_ref()
            .is_some_and(|ns| ns.resolve() != self.path);
        let saved = !moved && self.path.as_ref().is_some_and(|p| save(p, entries).is_ok());
        if !saved {
            self.state.error = Some("Could not save theme — try again".into());
        }
        saved
    }
}
fn read(path: &Path) -> Result<Option<Vec<u8>>, std::io::Error> {
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e),
    };
    if !file.metadata()?.is_file() {
        return Err(std::io::ErrorKind::InvalidData.into());
    }
    let mut bytes = Vec::new();
    file.take(LIMIT + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > LIMIT {
        return Err(std::io::ErrorKind::InvalidData.into());
    }
    Ok(Some(bytes))
}
fn save(path: &Path, entries: &[(&str, Value)]) -> Result<(), std::io::Error> {
    let before = read(path)?;
    let mut value = before
        .as_deref()
        .map(serde_json::from_slice::<Value>)
        .transpose()
        .map_err(|_| std::io::ErrorKind::InvalidData)?
        .unwrap_or(json!({}));
    let object = value
        .as_object_mut()
        .ok_or(std::io::ErrorKind::InvalidData)?;
    let theme = object.entry("theme").or_insert(json!({}));
    let theme = theme
        .as_object_mut()
        .ok_or(std::io::ErrorKind::InvalidData)?;
    for (key, value) in entries {
        theme.insert((*key).into(), value.clone());
    }
    let bytes = serde_json::to_vec_pretty(&value).map_err(|_| std::io::ErrorKind::InvalidData)?;
    if bytes.len() as u64 > LIMIT {
        return Err(std::io::ErrorKind::InvalidData.into());
    }
    let parent = path.parent().ok_or(std::io::ErrorKind::InvalidInput)?;
    fs::create_dir_all(parent)?;
    let temporary = parent.join(format!(".native-theme-{}.tmp", uuid::Uuid::new_v4()));
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temporary)?;
    let result = (|| {
        file.write_all(&bytes)?;
        file.sync_all()?;
        // Retain unrelated fields written before this save, and reject an observed
        // concurrent replacement. This is not a cross-process transactional lock.
        if read(path)? != before {
            return Err(std::io::ErrorKind::WouldBlock.into());
        }
        fs::rename(&temporary, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}
#[cfg(test)]
mod tests;
