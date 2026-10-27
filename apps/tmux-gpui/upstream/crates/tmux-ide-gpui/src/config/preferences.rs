//! Targeted native preference edits, serialized by the managed-config lock.
use super::*;
use herdr_client::protocol::ToastHerdrPosition;

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum Preference {
    ConfirmCloseTab(bool),
    ConfirmClosePane(bool),
    ShowSystemLoad(bool),
    AgentCheckpoints(bool),
    ShowListeningPorts(bool),
    NotificationEnabled(Option<bool>),
    NotificationDelay(Option<u64>),
    NotificationPosition(Option<ToastHerdrPosition>),
    ClipboardEnabled(Option<bool>),
    ClipboardPosition(Option<ClipboardToastPosition>),
    SidebarGap(f32),
    StatusBar(status_bar::Edit),
}

impl Config {
    pub(crate) fn save_preference(edit: Preference) -> Result<()> {
        let (_lock, local) = Self::prepare_files(&Self::path()?)?;
        Self::save_preference_path(edit, &local)
    }

    pub(super) fn save_preference_path(edit: Preference, path: &Path) -> Result<()> {
        let result = (|| -> Result<()> {
            let text = match fs::read_to_string(path) {
                Ok(text) => text,
                Err(error) if error.kind() == ErrorKind::NotFound => LOCAL_CONFIG.into(),
                Err(error) => return Err(error.into()),
            };
            let mut document = text.parse::<toml_edit::DocumentMut>()?;
            let (table, key, value) = match edit {
                Preference::ConfirmCloseTab(value) => {
                    (None, "confirm_close_tab", Some(value.into()))
                }
                Preference::ConfirmClosePane(value) => {
                    (None, "confirm_close_pane", Some(value.into()))
                }
                Preference::ShowSystemLoad(value) => (None, "show_system_load", Some(value.into())),
                Preference::AgentCheckpoints(value) => {
                    (None, "agent_checkpoints", Some(value.into()))
                }
                Preference::ShowListeningPorts(value) => {
                    (None, "show_listening_ports", Some(value.into()))
                }
                Preference::NotificationEnabled(value) => {
                    (Some("notifications"), "enabled", value.map(Into::into))
                }
                Preference::NotificationDelay(value) => {
                    if value.is_some_and(|value| value > 3600) {
                        return Err(crate::herdr_settings::Error::ToastDelay.into());
                    }
                    (
                        Some("notifications"),
                        "delay_seconds",
                        value.map(|value| toml_edit::Value::from(value as i64)),
                    )
                }
                Preference::NotificationPosition(value) => (
                    Some("notifications"),
                    "position",
                    value.map(|value| {
                        toml_edit::Value::from(match value {
                            ToastHerdrPosition::TopLeft => "top-left",
                            ToastHerdrPosition::TopRight => "top-right",
                            ToastHerdrPosition::BottomLeft => "bottom-left",
                            ToastHerdrPosition::BottomRight => "bottom-right",
                        })
                    }),
                ),
                Preference::ClipboardEnabled(value) => {
                    (Some("clipboard_toast"), "enabled", value.map(Into::into))
                }
                Preference::ClipboardPosition(value) => (
                    Some("clipboard_toast"),
                    "position",
                    value.map(|value| {
                        toml_edit::Value::from(match value {
                            ClipboardToastPosition::TopLeft => "top-left",
                            ClipboardToastPosition::TopCenter => "top-center",
                            ClipboardToastPosition::TopRight => "top-right",
                            ClipboardToastPosition::BottomLeft => "bottom-left",
                            ClipboardToastPosition::BottomCenter => "bottom-center",
                            ClipboardToastPosition::BottomRight => "bottom-right",
                        })
                    }),
                ),
                Preference::StatusBar(edit) => {
                    let (key, value) = edit.entry();
                    (Some("status_bar"), key, Some(value))
                }
                Preference::SidebarGap(value) => {
                    if !value.is_finite() || !(0.0..=MAX_SIDEBAR_GAP).contains(&value) {
                        return Err(Error::InvalidSidebarGap);
                    }
                    // A shorthand layout must retain its selected mode.
                    if let Some(mode) = document
                        .get("layout")
                        .filter(|item| item.as_str().is_some())
                    {
                        let mut table = toml_edit::Table::new();
                        table.insert("mode", mode.clone());
                        document["layout"] = toml_edit::Item::Table(table);
                    }
                    (
                        Some("layout"),
                        "sidebar_gap",
                        Some(toml_edit::Value::from(f64::from(value))),
                    )
                }
            };
            let target: &mut dyn toml_edit::TableLike = if let Some(table) = table {
                document
                    .entry(table)
                    .or_insert(toml_edit::Item::Table(toml_edit::Table::new()))
                    .as_table_like_mut()
                    .ok_or(crate::herdr_settings::Error::Table(table))?
            } else {
                document.as_table_mut()
            };
            if let Some(mut value) = value {
                if let Some(previous) = target.get(key).and_then(toml_edit::Item::as_value) {
                    *value.decor_mut() = previous.decor().clone();
                }
                target.insert(key, toml_edit::Item::Value(value));
            } else {
                target.remove(key);
            }
            write_config(path, &document.to_string())
        })();
        result.map_err(|error| error.at_path(path))
    }
}

#[cfg(test)]
#[allow(clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn targeted_preferences_round_trip_and_reset_without_erasing_unknown_toml() -> anyhow::Result<()>
    {
        let directory = tempfile::tempdir()?;
        let path = directory.path().join("local.toml");
        fs::write(
            &path,
            "# personal\nfuture = 'keep'\nlayout = 'orca' # mode\n[notifications]\nfuture = 42\nenabled = false # enabled\n",
        )?;
        for edit in [
            Preference::ConfirmCloseTab(false),
            Preference::ConfirmClosePane(false),
            Preference::ShowSystemLoad(false),
            Preference::AgentCheckpoints(false),
            Preference::ShowListeningPorts(false),
            Preference::NotificationEnabled(Some(true)),
            Preference::NotificationDelay(Some(3600)),
            Preference::NotificationPosition(Some(ToastHerdrPosition::TopLeft)),
            Preference::ClipboardEnabled(Some(false)),
            Preference::ClipboardPosition(Some(ClipboardToastPosition::TopCenter)),
            Preference::SidebarGap(7.5),
        ] {
            Config::save_preference_path(edit, &path)?;
        }
        let text = fs::read_to_string(&path)?;
        for comment in ["# personal", "# mode", "enabled = true # enabled"] {
            assert!(text.contains(comment));
        }
        let table: toml::Table = toml::from_str(&text)?;
        assert_eq!(table["future"].as_str(), Some("keep"));
        assert_eq!(table["notifications"]["future"].as_integer(), Some(42));
        assert_eq!(table["confirm_close_tab"].as_bool(), Some(false));
        assert_eq!(table["confirm_close_pane"].as_bool(), Some(false));
        assert_eq!(table["show_system_load"].as_bool(), Some(false));
        assert_eq!(table["agent_checkpoints"].as_bool(), Some(false));
        assert_eq!(table["show_listening_ports"].as_bool(), Some(false));
        assert_eq!(table["layout"]["mode"].as_str(), Some("orca"));
        assert_eq!(table["layout"]["sidebar_gap"].as_float(), Some(7.5));
        assert_eq!(
            table["notifications"]["delay_seconds"].as_integer(),
            Some(3600)
        );
        assert_eq!(
            table["notifications"]["position"].as_str(),
            Some("top-left")
        );
        assert_eq!(table["clipboard_toast"]["enabled"].as_bool(), Some(false));
        assert_eq!(
            table["clipboard_toast"]["position"].as_str(),
            Some("top-center")
        );
        for edit in [
            Preference::NotificationEnabled(None),
            Preference::NotificationDelay(None),
            Preference::NotificationPosition(None),
            Preference::ClipboardEnabled(None),
            Preference::ClipboardPosition(None),
        ] {
            Config::save_preference_path(edit, &path)?;
        }
        let table: toml::Table = toml::from_str(&fs::read_to_string(&path)?)?;
        assert_eq!(
            table["notifications"].as_table().map(|table| table.len()),
            Some(1)
        );
        assert_eq!(
            table["clipboard_toast"].as_table().map(|table| table.len()),
            Some(0)
        );
        Ok(())
    }

    #[test]
    fn preference_validation_is_atomic_and_preserves_typed_causes() -> anyhow::Result<()> {
        let directory = tempfile::tempdir()?;
        let path = directory.path().join("local.toml");
        let original = "layout = { mode = 'compact', sidebar_gap = 3 }\n";
        fs::write(&path, original)?;
        for edit in [
            Preference::SidebarGap(-1.),
            Preference::SidebarGap(65.),
            Preference::SidebarGap(f32::NAN),
            Preference::SidebarGap(f32::INFINITY),
            Preference::NotificationDelay(Some(u64::MAX)),
        ] {
            let error = Config::save_preference_path(edit, &path).expect_err("invalid preference");
            assert!(matches!(error, Error::Path { .. }));
            assert!(std::error::Error::source(&error).is_some());
            assert_eq!(fs::read_to_string(&path)?, original);
        }
        Config::save_preference_path(Preference::SidebarGap(64.), &path)?;
        assert_eq!(
            Config::parse(&fs::read_to_string(&path)?)?
                .layout
                .sidebar_gap,
            64.
        );
        for original in ["notifications = false\n", "[invalid"] {
            fs::write(&path, original)?;
            assert!(
                Config::save_preference_path(Preference::NotificationEnabled(Some(true)), &path)
                    .is_err()
            );
            assert_eq!(fs::read_to_string(&path)?, original);
        }
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn preference_save_writes_through_a_symlinked_file() -> anyhow::Result<()> {
        let directory = tempfile::tempdir()?;
        let dotfiles = directory.path().join("dotfiles");
        fs::create_dir(&dotfiles)?;
        let tracked = dotfiles.join("local.toml");
        fs::write(&tracked, "# tracked\n")?;
        let link = directory.path().join("local.toml");
        std::os::unix::fs::symlink(&tracked, &link)?;

        Config::save_preference_path(Preference::ShowSystemLoad(false), &link)?;

        assert!(fs::symlink_metadata(&link)?.file_type().is_symlink());
        let text = fs::read_to_string(&tracked)?;
        assert!(text.contains("# tracked"));
        let table: toml::Table = toml::from_str(&text)?;
        assert_eq!(table["show_system_load"].as_bool(), Some(false));
        Ok(())
    }
}
