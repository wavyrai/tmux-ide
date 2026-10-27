//! Shared release-namespace Herdr settings. `load` and `save` do blocking I/O:
//! callers MUST run them on a background worker, never in render/input handlers.
//!
//! Schema/defaults and palette data adapted from https://github.com/herdrdev/herdr
//! revision 8ac9542757292f7a8d42a2d532bc6a8a33c7ffce (Apache-2.0), specifically
//! src/config/{model,sound,theme}.rs, src/app/{state,mod}.rs and
//! src/client/shell.rs. This adaptation
//! uses GPUI RGB colors, strict bounded reads, and targeted optimistic saves.

#[path = "herdr_settings/palette.rs"]
mod palette;
#[path = "herdr_settings/persistence.rs"]
#[cfg(unix)]
mod persistence;
#[cfg(windows)]
#[path = "herdr_settings/persistence_windows.rs"]
mod persistence;
mod remote;
#[cfg(test)]
mod tests;

pub(crate) use crate::config::ClipboardToastPosition as ClipboardPosition;
use herdr_client::protocol::AgentStatus;
pub(crate) use herdr_client::protocol::ToastHerdrPosition as ToastPosition;
pub(crate) use remote::RemotePaneHistory;
use serde::Deserialize;
use std::{env, path::PathBuf};
use toml_edit::{DocumentMut, Item, Value};

pub(crate) const THEME_NAMES: &[&str] = &[
    "catppuccin",
    "catppuccin-latte",
    "terminal",
    "tokyo-night",
    "tokyo-night-day",
    "dracula",
    "nord",
    "gruvbox",
    "gruvbox-light",
    "one-dark",
    "one-light",
    "solarized",
    "solarized-light",
    "kanagawa",
    "kanagawa-lotus",
    "rose-pine",
    "rose-pine-dawn",
    "vesper",
];

#[derive(Debug, thiserror::Error)]
pub(crate) enum Error {
    #[error("shared Herdr config I/O failed")]
    Io(#[from] std::io::Error),
    #[cfg(windows)]
    #[error("saving shared Herdr settings is unsupported on Windows; edit config.toml manually")]
    Unsupported,
    #[cfg(unix)]
    #[error("shared Herdr config was replaced but completion failed; reload before saving again")]
    Committed(#[source] std::io::Error),
    #[error("invalid shared Herdr TOML")]
    Parse(#[from] toml::de::Error),
    #[error("cannot edit shared Herdr TOML")]
    Edit(#[from] toml_edit::TomlError),
    #[cfg(unix)]
    #[error("shared Herdr config changed; reload before saving")]
    Conflict,
    #[cfg(unix)]
    #[error("shared Herdr config is busy; retry saving")]
    Busy,
    #[error(
        "shared Herdr config requires an owned regular file and owned, non-writable-by-others parent; symlink targets are refused"
    )]
    UnsafePath,
    #[error("shared Herdr config exceeds the 1 MiB limit")]
    TooLarge,
    #[error("ui.toast.delay_seconds must be between 0 and 3600")]
    ToastDelay,
    #[error("unknown Herdr theme: {0}")]
    Theme(String),
    #[error("cannot edit non-table config field {0}")]
    Table(&'static str),
    #[error("could not reach the host's Herdr config")]
    Remote(#[source] herdr_client::Error),
    #[error("the host's Herdr config changed; reload before saving")]
    RemoteConflict,
    #[error("the host's Herdr config is not a regular file; symlink targets are refused")]
    RemoteUnsafePath,
    #[error("the host's Herdr config exceeds the 64 KiB limit for remote edits")]
    RemoteTooLarge,
    #[error("the host's Herdr config is not UTF-8")]
    RemoteUtf8(#[source] std::string::FromUtf8Error),
    #[error("unexpected output reading the host's Herdr config")]
    RemoteOutput,
    #[cfg(unix)]
    #[error("could not remove shared config temporary file: {cleanup}")]
    Cleanup {
        #[source]
        source: Option<Box<Error>>,
        cleanup: std::io::Error,
    },
}

// Keep the concrete source through the existing boxed config-error boundary.
// A dedicated root HerdrSettings(#[from] herdr_settings::Error) is optional.
impl From<Error> for crate::Error {
    fn from(source: Error) -> Self {
        Self::ConfigFile {
            uri: None,
            source: Box::new(source),
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum IndicatorStyle {
    #[default]
    Dots,
    Symbols,
}

/// Whether interactive creation asks for a name first, as Herdr's
/// `ui.prompt_new_tab_name` and `ui.prompt_new_workspace_name` decide.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct NamePrompts {
    pub tab: bool,
    pub workspace: bool,
}

/// Herdr's defaults, also used before the shared config has loaded.
impl Default for NamePrompts {
    fn default() -> Self {
        Self {
            tab: true,
            workspace: false,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ToastDelivery {
    #[default]
    Off,
    Herdr,
    Terminal,
    System,
}

/// Where the desktop tab row sits, as Herdr's `ui.tab_bar_position` places it.
#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum TabBarPosition {
    #[default]
    Top,
    Bottom,
}

/// What collapsing the sidebar leaves, as Herdr's `ui.sidebar_collapsed_mode`
/// chooses it: a narrow rail of status marks, or nothing.
#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum SidebarCollapsedMode {
    #[default]
    Compact,
    Hidden,
}

// Playback paths and per-agent policy are parsed by the sound backend, not this editor.
#[derive(Deserialize)]
#[serde(default)]
struct Sound {
    #[serde(deserialize_with = "crate::lenient::or_true")]
    enabled: bool,
}

impl Default for Sound {
    fn default() -> Self {
        Self { enabled: true }
    }
}

#[derive(Clone, Debug)]
pub(crate) enum Edit {
    Theme(String),
    Indicators(IndicatorStyle),
    Sound(bool),
    Toasts(ToastDelivery),
    CopyOnSelect(bool),
    TabBarPosition(TabBarPosition),
    HideSingleTabBar(bool),
    PaneHistory(bool),
}

#[derive(Clone)]
pub(crate) struct Settings {
    pub path: PathBuf,
    pub theme_name: String,
    pub indicators: IndicatorStyle,
    pub sound_enabled: bool,
    pub toast_delivery: ToastDelivery,
    pub toast_delay_seconds: u64,
    pub toast_position: ToastPosition,
    pub clipboard: ClipboardToast,
    /// The agents panel's starting order until the user toggles it.
    pub agent_sort: crate::preferences::AgentSort,
    /// Whether releasing a mouse selection copies it. When off, the
    /// selection stays highlighted until Cmd-C or Ctrl-C copies it.
    pub copy_on_select: bool,
    pub tab_bar_position: TabBarPosition,
    pub hide_tab_bar_when_single_tab: bool,
    pub sidebar_collapsed_mode: SidebarCollapsedMode,
    pub sidebar_start_collapsed: bool,
    pub name_prompts: NamePrompts,
    /// Herdr's `experimental.pane_history`: the daemon saves pane scrollback
    /// to `session-history.json` and replays it after a full restart. The
    /// GUI never stores terminal output itself.
    pub pane_history: bool,
    palettes: [palette::Palette; 2],
    original: persistence::Snapshot,
}

impl std::fmt::Debug for Settings {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // The original document may contain private settings unrelated to this
        // adapter. Diagnostics must not dump its contents or custom sound paths.
        f.debug_struct("Settings")
            .field("path", &self.path)
            .field("theme_name", &self.theme_name)
            .field("indicators", &self.indicators)
            .field("sound_enabled", &self.sound_enabled)
            .field("toast_delivery", &self.toast_delivery)
            .field("toast_delay_seconds", &self.toast_delay_seconds)
            .field("toast_position", &self.toast_position)
            .field("clipboard", &self.clipboard)
            .field("agent_sort", &self.agent_sort)
            .field("copy_on_select", &self.copy_on_select)
            .field("tab_bar_position", &self.tab_bar_position)
            .field(
                "hide_tab_bar_when_single_tab",
                &self.hide_tab_bar_when_single_tab,
            )
            .field("sidebar_collapsed_mode", &self.sidebar_collapsed_mode)
            .field("sidebar_start_collapsed", &self.sidebar_start_collapsed)
            .field("name_prompts", &self.name_prompts)
            .field("pane_history", &self.pane_history)
            .finish_non_exhaustive()
    }
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct Parsed {
    #[serde(deserialize_with = "crate::lenient::or_default")]
    theme: palette::ThemeConfig,
    #[serde(deserialize_with = "crate::lenient::or_default")]
    ui: Ui,
    #[serde(deserialize_with = "crate::lenient::or_default")]
    experimental: Experimental,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct Experimental {
    #[serde(deserialize_with = "crate::lenient::or_default")]
    pane_history: bool,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct Ui {
    #[serde(deserialize_with = "crate::lenient::or_default")]
    agent_panel_sort: crate::preferences::AgentSort,
    #[serde(deserialize_with = "crate::lenient::or_default")]
    status_indicators: IndicatorStyle,
    #[serde(deserialize_with = "crate::lenient::or_default")]
    sound: Sound,
    #[serde(deserialize_with = "crate::lenient::or_default")]
    toast: RawToast,
    #[serde(deserialize_with = "crate::lenient::or_default")]
    accent: Option<String>,
    // Herdr defaults this one on, unlike the derived `false`.
    #[serde(deserialize_with = "crate::lenient::or_default")]
    copy_on_select: Option<bool>,
    #[serde(deserialize_with = "crate::lenient::or_default")]
    tab_bar_position: TabBarPosition,
    #[serde(deserialize_with = "crate::lenient::or_default")]
    hide_tab_bar_when_single_tab: bool,
    #[serde(deserialize_with = "crate::lenient::or_default")]
    sidebar_collapsed_mode: SidebarCollapsedMode,
    #[serde(deserialize_with = "crate::lenient::or_default")]
    sidebar_start_collapsed: bool,
    #[serde(deserialize_with = "crate::lenient::or_default")]
    prompt_new_tab_name: Option<bool>,
    #[serde(deserialize_with = "crate::lenient::or_default")]
    prompt_new_workspace_name: Option<bool>,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct RawToast {
    #[serde(deserialize_with = "crate::lenient::or_default")]
    delivery: Option<ToastDelivery>,
    #[serde(deserialize_with = "crate::lenient::or_default")]
    enabled: Option<bool>,
    #[serde(deserialize_with = "crate::lenient::or_default")]
    delay_seconds: Option<u64>,
    #[serde(deserialize_with = "crate::lenient::or_default")]
    herdr: HerdrToast,
    #[serde(deserialize_with = "crate::lenient::or_default")]
    clipboard: ClipboardToast,
}

#[derive(Deserialize)]
#[serde(default)]
struct HerdrToast {
    #[serde(deserialize_with = "bottom_right")]
    position: ToastPosition,
}

fn bottom_right<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<ToastPosition, D::Error> {
    Ok(crate::lenient::value(deserializer)?.unwrap_or(ToastPosition::BottomRight))
}

impl Default for HerdrToast {
    fn default() -> Self {
        Self {
            position: ToastPosition::BottomRight,
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(default)]
pub(crate) struct ClipboardToast {
    #[serde(deserialize_with = "crate::lenient::or_true")]
    pub enabled: bool,
    #[serde(deserialize_with = "crate::lenient::or_default")]
    pub position: ClipboardPosition,
}

impl Default for ClipboardToast {
    fn default() -> Self {
        Self {
            enabled: true,
            position: ClipboardPosition::BottomCenter,
        }
    }
}

impl Settings {
    #[cfg(test)]
    pub(crate) fn parse_text(text: &str) -> Result<Self, Error> {
        #[cfg(unix)]
        let snapshot = persistence::Snapshot {
            text: Some(text.into()),
            ..Default::default()
        };
        #[cfg(windows)]
        let snapshot = persistence::Snapshot {
            text: Some(text.into()),
        };
        Self::parse(PathBuf::from("config.toml"), snapshot)
    }

    /// Background-only. A missing file yields defaults without creating anything.
    pub(crate) fn load() -> crate::Result<Self> {
        let path = crate::config::daemon_config_path(|key| env::var_os(key));
        let path = if path.is_absolute() {
            path
        } else {
            env::current_dir()?.join(path)
        };
        Self::load_path(path)
    }

    fn load_path(path: PathBuf) -> crate::Result<Self> {
        let result =
            persistence::read(&path).and_then(|snapshot| Self::parse(path.clone(), snapshot));
        result.map_err(|error| crate::Error::from(error).at_path(&path))
    }

    fn parse(path: PathBuf, original: persistence::Snapshot) -> Result<Self, Error> {
        if original
            .text
            .as_ref()
            .is_some_and(|text| text.len() as u64 > persistence::LIMIT)
        {
            return Err(Error::TooLarge);
        }
        let parsed: Parsed = toml::from_str(original.text.as_deref().unwrap_or(""))?;
        let defaults = NamePrompts::default();
        let name_prompts = NamePrompts {
            tab: parsed.ui.prompt_new_tab_name.unwrap_or(defaults.tab),
            workspace: parsed
                .ui
                .prompt_new_workspace_name
                .unwrap_or(defaults.workspace),
        };
        let toast = parsed.ui.toast;
        // Herdr refuses a longer delay and keeps its default, so this does too.
        let delay = toast
            .delay_seconds
            .filter(|delay| *delay <= 3600)
            .unwrap_or(1);
        let theme_name = parsed.theme.name.as_deref().unwrap_or("catppuccin");
        let legacy_accent = parsed
            .ui
            .accent
            .as_deref()
            .filter(|accent| *accent != "cyan");
        // Resolve arbitrary config strings once on the loader, not per rendered
        // indicator. Appearance changes only select a fixed-size palette.
        let palettes =
            [false, true].map(|light| parsed.theme.resolve(theme_name, legacy_accent, light));
        Ok(Self {
            path,
            theme_name: theme_name.into(),
            indicators: parsed.ui.status_indicators,
            sound_enabled: parsed.ui.sound.enabled,
            toast_delivery: toast.delivery.unwrap_or(if toast.enabled == Some(true) {
                ToastDelivery::Herdr
            } else {
                ToastDelivery::Off
            }),
            toast_delay_seconds: delay,
            toast_position: toast.herdr.position,
            clipboard: toast.clipboard,
            agent_sort: parsed.ui.agent_panel_sort,
            copy_on_select: parsed.ui.copy_on_select.unwrap_or(true),
            tab_bar_position: parsed.ui.tab_bar_position,
            hide_tab_bar_when_single_tab: parsed.ui.hide_tab_bar_when_single_tab,
            sidebar_collapsed_mode: parsed.ui.sidebar_collapsed_mode,
            sidebar_start_collapsed: parsed.ui.sidebar_start_collapsed,
            name_prompts,
            pane_history: parsed.experimental.pane_history,
            palettes,
            original,
        })
    }

    /// Background-only. Returns a fresh snapshot only after durable replacement.
    /// Never merges stale edits: even unrelated external changes require reload.
    pub(crate) fn save(&self, edit: Edit) -> crate::Result<Self> {
        let result = (|| -> Result<Self, Error> {
            let mut document = self
                .original
                .text
                .as_deref()
                .unwrap_or("")
                .parse::<DocumentMut>()?;
            match edit {
                Edit::Theme(name) => {
                    let name =
                        palette::canonical(&name).ok_or_else(|| Error::Theme(name.clone()))?;
                    set(&mut document, &["theme", "name"], name.into())?;
                    set(&mut document, &["theme", "auto_switch"], false.into())?;
                }
                Edit::Indicators(style) => set(
                    &mut document,
                    &["ui", "status_indicators"],
                    match style {
                        IndicatorStyle::Dots => "dots",
                        IndicatorStyle::Symbols => "symbols",
                    }
                    .into(),
                )?,
                Edit::Sound(enabled) => {
                    set(&mut document, &["ui", "sound", "enabled"], enabled.into())?
                }
                Edit::CopyOnSelect(enabled) => {
                    set(&mut document, &["ui", "copy_on_select"], enabled.into())?
                }
                Edit::TabBarPosition(position) => set(
                    &mut document,
                    &["ui", "tab_bar_position"],
                    match position {
                        TabBarPosition::Top => "top",
                        TabBarPosition::Bottom => "bottom",
                    }
                    .into(),
                )?,
                Edit::HideSingleTabBar(hide) => set(
                    &mut document,
                    &["ui", "hide_tab_bar_when_single_tab"],
                    hide.into(),
                )?,
                Edit::PaneHistory(enabled) => set(
                    &mut document,
                    &["experimental", "pane_history"],
                    enabled.into(),
                )?,
                Edit::Toasts(delivery) => {
                    set(
                        &mut document,
                        &["ui", "toast", "delivery"],
                        match delivery {
                            ToastDelivery::Off => "off",
                            ToastDelivery::Herdr => "herdr",
                            ToastDelivery::Terminal => "terminal",
                            ToastDelivery::System => "system",
                        }
                        .into(),
                    )?;
                    let mut comments = String::new();
                    if let Some(table) = document["ui"]["toast"].as_table_like_mut() {
                        if let Some(key) = table.key("enabled")
                            && let Some(prefix) =
                                key.leaf_decor().prefix().and_then(|raw| raw.as_str())
                            && prefix.contains('#')
                        {
                            comments.push_str(prefix);
                        }
                        if let Some(Item::Value(value)) = table.remove("enabled")
                            && let Some(suffix) =
                                value.decor().suffix().and_then(|raw| raw.as_str())
                            && suffix.contains('#')
                        {
                            comments.push_str(suffix);
                            comments.push('\n');
                        }
                    }
                    // The deleted legacy key has no place to keep its decor;
                    // retain its comments at EOF rather than discarding them.
                    if !comments.is_empty() {
                        document.set_trailing(format!(
                            "{}\n{comments}",
                            document.trailing().as_str().unwrap_or("")
                        ));
                    }
                }
            }
            let text = document.to_string();
            // Validate before performing any writes, including directory creation.
            let mut snapshot = self.original.clone();
            snapshot.text = Some(text.clone());
            let mut next = Self::parse(self.path.clone(), snapshot)?;
            next.original = persistence::save(&self.path, &self.original, &text)?;
            Ok(next)
        })();
        result.map_err(|error| crate::Error::from(error).at_path(&self.path))
    }

    /// Pure: no filesystem access; safe to use prepared settings on the UI thread.
    pub(crate) fn theme(&self, light: bool) -> crate::Result<crate::config::Theme> {
        Ok(self.colors(light).theme())
    }

    /// Pure preview of a theme edit, retaining custom colors and legacy accent.
    /// Like saving a named theme, this disables automatic light/dark switching.
    pub(crate) fn preview_theme(
        &self,
        name: &str,
        light: bool,
    ) -> crate::Result<crate::config::Theme> {
        let name = palette::canonical(name).ok_or_else(|| Error::Theme(name.into()))?;
        let mut document = self
            .original
            .text
            .as_deref()
            .unwrap_or("")
            .parse::<DocumentMut>()
            .map_err(Error::from)?;
        set(&mut document, &["theme", "name"], name.into())?;
        set(&mut document, &["theme", "auto_switch"], false.into())?;
        let mut snapshot = self.original.clone();
        snapshot.text = Some(document.to_string());
        Self::parse(self.path.clone(), snapshot)?.theme(light)
    }

    fn colors(&self, light: bool) -> &palette::Palette {
        &self.palettes[usize::from(light)]
    }

    pub(crate) fn status_color(&self, status: AgentStatus, light: bool) -> u32 {
        self.colors(light).status(status)
    }
}

fn set(document: &mut DocumentMut, keys: &[&'static str], mut value: Value) -> Result<(), Error> {
    let mut item = document.as_item_mut();
    for key in &keys[..keys.len() - 1] {
        let table = item.as_table_like_mut().ok_or(Error::Table(key))?;
        if !table.contains_key(key) {
            table.insert(key, Item::Table(toml_edit::Table::new()));
        }
        item = table.get_mut(key).ok_or(Error::Table(key))?;
    }
    let key = keys[keys.len() - 1];
    let table = item.as_table_like_mut().ok_or(Error::Table(key))?;
    if let Some(previous) = table.get(key).and_then(Item::as_value) {
        *value.decor_mut() = previous.decor().clone();
    }
    table.insert(key, Item::Value(value));
    Ok(())
}
