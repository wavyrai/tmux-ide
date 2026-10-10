//! The config files on disk: locking, migration, managed defaults refresh,
//! and targeted edits to the local overrides file.
use super::{
    Config, DEFAULT_CONFIG, Daemon, FONT_SIZE_RANGE, FontFace, KeybindingSource, LOCAL_CONFIG,
    LayoutMode, MANAGED_HEADER,
};
use crate::{Error, Result, contrast::Contrast};
use std::{
    fs,
    io::{ErrorKind, Write},
    path::{Path, PathBuf},
};

impl Config {
    /// Serialize migration, defaults refresh, and theme saves across GUI windows
    /// and processes. This is only called by background config workers.
    pub(super) fn prepare_files(path: &Path) -> Result<(fs::File, PathBuf)> {
        let parent = path
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        fs::create_dir_all(parent).map_err(|error| Error::from(error).at_path(parent))?;
        let lock_path = path.with_extension("lock");
        let lock = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&lock_path)
            .inspect_err(|error| {
                tracing::warn!(operation = "config_lock_open", kind = ?error.kind(), raw_os_error = ?error.raw_os_error(), "Config lock failed");
            })
            .map_err(|error| Error::from(error).at_path(&lock_path))?;
        lock.lock()
            .inspect_err(|error| {
                tracing::warn!(operation = "config_lock_acquire", kind = ?error.kind(), raw_os_error = ?error.raw_os_error(), "Config lock failed");
            })
            .map_err(|error| Error::from(error).at_path(&lock_path))?;
        let local = path.with_extension("local.toml");
        let original = match fs::read_to_string(path) {
            Ok(text) => Some(text),
            Err(error) if error.kind() == ErrorKind::NotFound => None,
            Err(error) => return Err(Error::from(error).at_path(path)),
        };
        let legacy = original
            .as_deref()
            .filter(|text| text.lines().next() != Some(MANAGED_HEADER));
        if let Some(text) = legacy {
            // Never replace an old user's file until its exact contents are
            // safely stored in the local file. A conflict needs human resolution.
            Self::parse_over(text, &Daemon::default()).map_err(|error| error.at_path(path))?;
        }
        match fs::read_to_string(&local) {
            Ok(text) if legacy.is_some_and(|legacy| legacy != text) => {
                return Err(Error::ConfigMigrationConflict {
                    original: path.into(),
                    local,
                });
            }
            Ok(_) => {}
            Err(error) if error.kind() == ErrorKind::NotFound => {
                let mut file = tempfile::NamedTempFile::new_in(parent)
                    .map_err(|error| Error::from(error).at_path(&local))?;
                file.write_all(legacy.unwrap_or(LOCAL_CONFIG).as_bytes())
                    .map_err(|error| Error::from(error).at_path(&local))?;
                file.as_file()
                    .sync_all()
                    .map_err(|error| Error::from(error).at_path(&local))?;
                file.persist_noclobber(&local)
                    .map_err(|error| Error::from(error.error).at_path(&local))?;
            }
            Err(error) => return Err(Error::from(error).at_path(&local)),
        }
        if legacy.is_some() {
            // Windows FlushFileBuffers requires write access, including when
            // resuming a migration whose local copy already exists. Never truncate.
            fs::OpenOptions::new()
                .write(true)
                .open(&local)
                .and_then(|file| file.sync_all())
                .map_err(|error| Error::from(error).at_path(&local))?;
            // Publish the migration copy durably before replacing the only old
            // copy. Windows does not expose directory sync through std::fs.
            #[cfg(unix)]
            fs::File::open(parent)
                .and_then(|directory| directory.sync_all())
                .map_err(|error| Error::from(error).at_path(parent))?;
        }
        if original.as_deref() != Some(DEFAULT_CONFIG) {
            write_config(path, DEFAULT_CONFIG)?;
        }
        Ok((lock, local))
    }

    /// Persist only the theme selection, retaining the latest on-disk settings.
    pub fn save_theme(&self, name: &str) -> Result<()> {
        self.save_theme_at(name, &Self::path()?)
    }

    pub(super) fn save_theme_at(&self, name: &str, path: &Path) -> Result<()> {
        let (_lock, local) = Self::prepare_files(path)?;
        self.save_theme_path(name, &local)
    }

    pub(super) fn save_theme_path(&self, name: &str, path: &Path) -> Result<()> {
        let selected = Self {
            theme: name.into(),
            ..self.clone()
        };
        selected.validate_theme()?;
        let result = (|| -> Result<()> {
            let text = match fs::read_to_string(path) {
                Ok(text) => text,
                Err(error) if error.kind() == ErrorKind::NotFound => LOCAL_CONFIG.into(),
                Err(error) => return Err(error.into()),
            };
            let mut document = text.parse::<toml_edit::DocumentMut>()?;
            let mut value = toml_edit::Value::from(name);
            if let Some(previous) = document.get("theme").and_then(toml_edit::Item::as_value) {
                *value.decor_mut() = previous.decor().clone();
            }
            document["theme"] = toml_edit::Item::Value(value);
            write_config(path, &document.to_string())?;
            Ok(())
        })();
        result.map_err(|error| error.at_path(path))
    }

    /// Persist only the sidebar layout, retaining the latest on-disk
    /// settings: a `layout = "..."` name is replaced in place, and a
    /// `[layout]` table gets its `mode`.
    pub fn save_layout(mode: LayoutMode) -> Result<()> {
        let (_lock, local) = Self::prepare_files(&Self::path()?)?;
        Self::save_layout_path(mode, &local)
    }

    pub(super) fn save_layout_path(mode: LayoutMode, path: &Path) -> Result<()> {
        let result = (|| -> Result<()> {
            let text = match fs::read_to_string(path) {
                Ok(text) => text,
                Err(error) if error.kind() == ErrorKind::NotFound => LOCAL_CONFIG.into(),
                Err(error) => return Err(error.into()),
            };
            let mut document = text.parse::<toml_edit::DocumentMut>()?;
            match document.get_mut("layout") {
                Some(item) if item.is_table_like() => {
                    if let Some(layout) = item.as_table_like_mut() {
                        layout.insert("mode", toml_edit::value(mode.name()));
                    }
                }
                Some(toml_edit::Item::Value(named)) => {
                    let decor = named.decor().clone();
                    *named = toml_edit::Value::from(mode.name());
                    *named.decor_mut() = decor;
                }
                _ => {
                    document.insert("layout", toml_edit::value(mode.name()));
                }
            }
            write_config(path, &document.to_string())
        })();
        result.map_err(|error| error.at_path(path))
    }

    /// Persist a batch of logical pixel sizes without replacing other overrides.
    /// The lock also serializes this edit with migration and other GUI saves.
    pub(crate) fn save_font_sizes(sizes: &[(FontFace, f32)]) -> Result<()> {
        let (_lock, local) = Self::prepare_files(&Self::path()?)?;
        Self::save_font_sizes_path(sizes, &local)
    }

    /// Persist usage visibility without replacing provider settings.
    pub(crate) fn save_usage_visibility(show: bool) -> Result<()> {
        let (_lock, local) = Self::prepare_files(&Self::path()?)?;
        Self::save_usage_visibility_path(show, &local)
    }

    pub(super) fn save_usage_visibility_path(show: bool, path: &Path) -> Result<()> {
        let result = (|| -> Result<()> {
            let text = match fs::read_to_string(path) {
                Ok(text) => text,
                Err(error) if error.kind() == ErrorKind::NotFound => LOCAL_CONFIG.into(),
                Err(error) => return Err(error.into()),
            };
            let mut document = text.parse::<toml_edit::DocumentMut>()?;
            let usage = document
                .entry("usage")
                .or_insert(toml_edit::Item::Table(toml_edit::Table::new()))
                .as_table_like_mut()
                .ok_or(Error::InvalidUsageTable)?;
            let mut value = toml_edit::Value::from(show);
            if let Some(previous) = usage.get("show").and_then(toml_edit::Item::as_value) {
                *value.decor_mut() = previous.decor().clone();
            }
            usage.insert("show", toml_edit::Item::Value(value));
            write_config(path, &document.to_string())
        })();
        result.map_err(|error| error.at_path(path))
    }

    /// Persist only the contrast setting, keeping the rest of the local file.
    pub(crate) fn save_contrast(contrast: Contrast) -> Result<()> {
        let (_lock, local) = Self::prepare_files(&Self::path()?)?;
        Self::save_contrast_path(contrast, &local)
    }

    pub(super) fn save_contrast_path(contrast: Contrast, path: &Path) -> Result<()> {
        let result = (|| -> Result<()> {
            let text = match fs::read_to_string(path) {
                Ok(text) => text,
                Err(error) if error.kind() == ErrorKind::NotFound => LOCAL_CONFIG.into(),
                Err(error) => return Err(error.into()),
            };
            let mut document = text.parse::<toml_edit::DocumentMut>()?;
            let mut value = toml_edit::Value::from(contrast.name());
            if let Some(previous) = document.get("contrast").and_then(toml_edit::Item::as_value) {
                *value.decor_mut() = previous.decor().clone();
            }
            document["contrast"] = toml_edit::Item::Value(value);
            write_config(path, &document.to_string())
        })();
        result.map_err(|error| error.at_path(path))
    }

    /// Persist one device's keybinding source, keeping the rest of the local
    /// file. Local is the default, so choosing it removes the entry.
    pub(crate) fn save_device_keybindings(profile: &str, source: KeybindingSource) -> Result<()> {
        let (_lock, local) = Self::prepare_files(&Self::path()?)?;
        Self::save_device_keybindings_path(profile, source, &local)
    }

    pub(super) fn save_device_keybindings_path(
        profile: &str,
        source: KeybindingSource,
        path: &Path,
    ) -> Result<()> {
        if !herdr_client::valid_profile_id(profile) {
            return Err(Error::InvalidDeviceId(profile.to_owned()));
        }
        let result = (|| -> Result<()> {
            let text = match fs::read_to_string(path) {
                Ok(text) => text,
                Err(error) if error.kind() == ErrorKind::NotFound => LOCAL_CONFIG.into(),
                Err(error) => return Err(error.into()),
            };
            let mut document = text.parse::<toml_edit::DocumentMut>()?;
            match source {
                KeybindingSource::Server => {
                    let mut devices = toml_edit::Table::new();
                    devices.set_implicit(true);
                    let device = document
                        .entry("devices")
                        .or_insert(toml_edit::Item::Table(devices))
                        .as_table_like_mut()
                        .ok_or(Error::InvalidDevicesTable)?
                        .entry(profile)
                        .or_insert(toml_edit::Item::Table(toml_edit::Table::new()))
                        .as_table_like_mut()
                        .ok_or(Error::InvalidDevicesTable)?;
                    device.insert("keybindings", toml_edit::value("server"));
                }
                KeybindingSource::Local => {
                    let Some(devices) = document
                        .get_mut("devices")
                        .and_then(toml_edit::Item::as_table_like_mut)
                    else {
                        return Ok(());
                    };
                    if let Some(device) = devices
                        .get_mut(profile)
                        .and_then(toml_edit::Item::as_table_like_mut)
                    {
                        device.remove("keybindings");
                        if device.is_empty() {
                            devices.remove(profile);
                        }
                    }
                    if devices.is_empty() {
                        document.remove("devices");
                    }
                }
            }
            write_config(path, &document.to_string())
        })();
        result.map_err(|error| error.at_path(path))
    }

    /// Persist only the Agents section visibility, keeping the rest of the local file.
    pub(crate) fn save_show_agents(show: bool) -> Result<()> {
        let (_lock, local) = Self::prepare_files(&Self::path()?)?;
        Self::save_show_agents_path(show, &local)
    }

    pub(super) fn save_show_agents_path(show: bool, path: &Path) -> Result<()> {
        let result = (|| -> Result<()> {
            let text = match fs::read_to_string(path) {
                Ok(text) => text,
                Err(error) if error.kind() == ErrorKind::NotFound => LOCAL_CONFIG.into(),
                Err(error) => return Err(error.into()),
            };
            let mut document = text.parse::<toml_edit::DocumentMut>()?;
            let mut value = toml_edit::Value::from(show);
            if let Some(previous) = document
                .get("show_agents")
                .and_then(toml_edit::Item::as_value)
            {
                *value.decor_mut() = previous.decor().clone();
            }
            document["show_agents"] = toml_edit::Item::Value(value);
            write_config(path, &document.to_string())
        })();
        result.map_err(|error| error.at_path(path))
    }

    /// `None` removes the local override, inheriting the platform's managed default.
    pub(crate) fn save_font_family(face: FontFace, family: Option<&str>) -> Result<()> {
        let (_lock, local) = Self::prepare_files(&Self::path()?)?;
        Self::save_font_family_path(face, family, &local)
    }

    pub(crate) fn save_all_font_families(family: Option<&str>) -> Result<()> {
        let (_lock, local) = Self::prepare_files(&Self::path()?)?;
        Self::save_font_families_path(
            &[
                FontFace::Sidebar,
                FontFace::Tabs,
                FontFace::Terminal,
                FontFace::Ui,
            ],
            family,
            &local,
        )
    }

    pub(super) fn save_font_family_path(
        face: FontFace,
        family: Option<&str>,
        path: &Path,
    ) -> Result<()> {
        Self::save_font_families_path(&[face], family, path)
    }

    pub(super) fn save_font_families_path(
        faces: &[FontFace],
        family: Option<&str>,
        path: &Path,
    ) -> Result<()> {
        if family.is_some_and(|name| name.trim().is_empty()) {
            return Err(Error::EmptyFontFamily("fonts"));
        }
        let result = (|| -> Result<()> {
            let text = fs::read_to_string(path)?;
            let mut document = text.parse::<toml_edit::DocumentMut>()?;
            for face in faces {
                if let Some(family) = family {
                    let font = document
                        .entry(face.name())
                        .or_insert(toml_edit::Item::Table(toml_edit::Table::new()));
                    let table = font
                        .as_table_like_mut()
                        .ok_or(Error::EmptyFontFamily(face.name()))?;
                    let mut value = toml_edit::Value::from(family);
                    if let Some(previous) = table.get("family").and_then(toml_edit::Item::as_value)
                    {
                        *value.decor_mut() = previous.decor().clone();
                    }
                    table.insert("family", toml_edit::Item::Value(value));
                } else if let Some(table) = document
                    .get_mut(face.name())
                    .and_then(toml_edit::Item::as_table_like_mut)
                {
                    table.remove("family");
                }
            }
            write_config(path, &document.to_string())
        })();
        result.map_err(|error| error.at_path(path))
    }

    pub(super) fn save_font_sizes_path(sizes: &[(FontFace, f32)], path: &Path) -> Result<()> {
        for &(face, size) in sizes {
            if !size.is_finite() || !FONT_SIZE_RANGE.contains(&size) {
                return Err(Error::InvalidFontSize(face.name()));
            }
        }
        let result = (|| -> Result<()> {
            let text = fs::read_to_string(path)?;
            let mut document = text.parse::<toml_edit::DocumentMut>()?;
            for &(face, size) in sizes {
                let font = document
                    .entry(face.name())
                    .or_insert(toml_edit::Item::Table(toml_edit::Table::new()));
                let table = font
                    .as_table_like_mut()
                    .ok_or(Error::InvalidFontSize(face.name()))?;
                let mut value = toml_edit::Value::from(size as f64);
                if let Some(previous) = table.get("size").and_then(toml_edit::Item::as_value) {
                    *value.decor_mut() = previous.decor().clone();
                }
                table.insert("size", toml_edit::Item::Value(value));
            }
            write_config(path, &document.to_string())
        })();
        result.map_err(|error| error.at_path(path))
    }
}

pub(super) fn write_config(path: &Path, text: &str) -> Result<()> {
    let result = (|| -> std::io::Result<()> {
        // rename(2) replaces a symlink instead of writing through it, so write
        // to the file the link points at. A missing path keeps its own name.
        let target = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
        let parent = target
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        fs::create_dir_all(parent)?;
        let mut file = tempfile::NamedTempFile::new_in(parent)?;
        file.write_all(text.as_bytes())?;
        file.as_file().sync_all()?;
        file.persist(&target).map_err(|error| error.error)?;
        Ok(())
    })();
    result.map_err(|error| Error::from(error).at_path(path))
}
