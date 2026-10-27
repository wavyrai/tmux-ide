//! Reading settings from Herdr's `config.toml`, a file this app does not own.
//!
//! A newer Herdr may write values this build cannot read: an enum variant
//! added since, a key whose type changed. Each such value falls back to its
//! own default instead of failing the whole file, so one new setting cannot
//! stop the GUI following every other one. Malformed TOML still fails.
use serde::{Deserialize, Deserializer, de::DeserializeOwned};
use std::collections::HashMap;

/// The value, or `None` when it has a shape this build does not read.
pub(crate) fn value<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: DeserializeOwned,
{
    let value = toml::Value::deserialize(deserializer)?;
    Ok(T::deserialize(value).ok())
}

/// The value, or `T::default()` when it cannot be read.
pub(crate) fn or_default<'de, D, T>(deserializer: D) -> Result<T, D::Error>
where
    D: Deserializer<'de>,
    T: DeserializeOwned + Default,
{
    Ok(value(deserializer)?.unwrap_or_default())
}

/// For switches Herdr turns on by default.
pub(crate) fn or_true<'de, D: Deserializer<'de>>(deserializer: D) -> Result<bool, D::Error> {
    Ok(value(deserializer)?.unwrap_or(true))
}

/// A table whose entries are read one by one: an entry this build cannot
/// read is dropped without losing the others.
pub(crate) fn entries<'de, D, T>(deserializer: D) -> Result<HashMap<String, T>, D::Error>
where
    D: Deserializer<'de>,
    T: DeserializeOwned,
{
    let table: Option<HashMap<String, toml::Value>> = value(deserializer)?;
    Ok(table
        .unwrap_or_default()
        .into_iter()
        .filter_map(|(key, value)| Some((key, T::deserialize(value).ok()?)))
        .collect())
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use serde::Deserialize;
    use std::collections::HashMap;

    #[derive(Debug, Default, Deserialize, PartialEq, Eq)]
    #[serde(rename_all = "lowercase")]
    enum Style {
        #[default]
        Dots,
        Symbols,
    }

    #[derive(Debug, Deserialize)]
    #[serde(default)]
    struct Table {
        #[serde(deserialize_with = "super::or_default")]
        style: Style,
        #[serde(deserialize_with = "super::or_true")]
        enabled: bool,
        #[serde(deserialize_with = "super::or_default")]
        name: Option<String>,
        #[serde(deserialize_with = "super::entries")]
        agents: HashMap<String, Style>,
    }

    impl Default for Table {
        fn default() -> Self {
            Self {
                style: Style::Dots,
                enabled: true,
                name: None,
                agents: HashMap::new(),
            }
        }
    }

    #[test]
    fn each_unreadable_value_falls_back_on_its_own() {
        let table: Table = toml::from_str(
            "style = 'bars'\nenabled = 'yes'\nname = 7\n[agents]\na = 'symbols'\nb = 'later'",
        )
        .unwrap();
        assert_eq!(table.style, Style::Dots);
        assert!(table.enabled);
        assert_eq!(table.name, None);
        assert_eq!(table.agents, HashMap::from([("a".into(), Style::Symbols)]));

        let table: Table =
            toml::from_str("style = 'symbols'\nenabled = false\nname = 'x'\nagents = 3").unwrap();
        assert_eq!(table.style, Style::Symbols);
        assert!(!table.enabled);
        assert_eq!(table.name.as_deref(), Some("x"));
        assert!(table.agents.is_empty());

        assert!(toml::from_str::<Table>("style = [").is_err());
    }
}
