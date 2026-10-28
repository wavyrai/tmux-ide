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
struct Preset {
    id: String,
    name: String,
    mode: String,
    dark: Colors,
    light: Colors,
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
        Some(Self {
            presets,
            path,
            namespace: None,
            state,
        })
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
        if let Some(preset) = self.presets.iter().find(|p| p.id == self.state.selected) {
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
        // Re-resolve before every write; a development ancestor may have changed.
        if self
            .namespace
            .as_ref()
            .is_some_and(|ns| ns.resolve() != self.path)
        {
            self.state.error = Some("Could not save theme — try again".into());
            return;
        }
        let saved = self
            .path
            .as_ref()
            .is_some_and(|p| save(p, &preset.id, &preset.mode).is_ok());
        if !saved {
            self.state.error = Some("Could not save theme — try again".into());
            return;
        }
        self.state.selected = id.into();
        self.state.error = None;
        self.resolve();
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
fn save(path: &Path, id: &str, mode: &str) -> Result<(), std::io::Error> {
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
    theme.insert("mode".into(), json!(mode));
    theme.insert(
        "preset".into(),
        json!(if ["system", "dark", "light"].contains(&id) {
            ""
        } else {
            id
        }),
    );
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
