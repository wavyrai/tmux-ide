//! Writing one table of string keys to the local override file, as Settings
//! does for a cloud provider's account: an empty value removes its key, an
//! edited one keeps its comment, and every other key and table is untouched.

use super::{LOCAL_CONFIG, write_config};
use crate::{Error, Result};
use std::{fs, io::ErrorKind, path::Path};

pub(super) fn save_keys(path: &Path, name: &'static str, entries: &[(&str, &str)]) -> Result<()> {
    let result = (|| -> Result<()> {
        let text = match fs::read_to_string(path) {
            Ok(text) => text,
            Err(error) if error.kind() == ErrorKind::NotFound => LOCAL_CONFIG.into(),
            Err(error) => return Err(error.into()),
        };
        let mut document = text.parse::<toml_edit::DocumentMut>()?;
        let table = document
            .entry(name)
            .or_insert(toml_edit::Item::Table(toml_edit::Table::new()))
            .as_table_like_mut()
            .ok_or(crate::herdr_settings::Error::Table(name))?;
        for &(key, value) in entries {
            let value = value.trim();
            if value.is_empty() {
                table.remove(key);
                continue;
            }
            let mut value = toml_edit::Value::from(value);
            if let Some(previous) = table.get(key).and_then(toml_edit::Item::as_value) {
                *value.decor_mut() = previous.decor().clone();
            }
            table.insert(key, toml_edit::Item::Value(value));
        }
        if table.is_empty() {
            document.remove(name);
        }
        write_config(path, &document.to_string())
    })();
    result.map_err(|error: Error| error.at_path(path))
}
