//! GUI settings. The daemon's own config is read only where the GUI honors a
//! preference the user already expressed there, never written and never used
//! to change daemon behavior. Managed defaults are refreshed from the binary;
//! `config-gpui.local.toml` holds persistent user overrides.
use crate::{
    Error, Result,
    contrast::Contrast,
    keymap::{Binding, DaemonKeys, Keymap, PaneKeys},
};
mod bitmap_fonts;
mod coder;
mod daytona;
mod files;
mod fonts;
mod layout;
mod notifications;
pub(crate) mod preferences;
pub(crate) mod sidebar;
mod sidebar_style;
pub(crate) mod status_bar;
#[cfg(feature = "cloud")]
mod table;
mod theme;
pub(crate) mod watch;

pub use coder::CoderConfig;
#[cfg(feature = "coder")]
pub(crate) use coder::CoderFields;
pub use daytona::DaytonaConfig;
#[cfg(feature = "daytona")]
pub(crate) use daytona::DaytonaFields;
use files::write_config;
pub(crate) use fonts::FontFace;
use fonts::FontSettings;
#[cfg(any(test, feature = "integration-test"))]
pub use fonts::symbol_fallbacks;
pub use fonts::{FONT_SIZE_RANGE, FONT_SIZE_STEP, FontConfig};
use layout::MAX_SIDEBAR_GAP;
pub use layout::{Density, Layout, LayoutMode, Style};
pub(crate) use notifications::NotificationDelivery;
pub use notifications::{BellConfig, ClipboardToast, ClipboardToastPosition, NotificationConfig};
use notifications::{ClipboardToastSettings, NotificationSettings};
use serde::Deserialize;
pub(crate) use sidebar::{
    AgentLayout, AgentToken, Rows, SidebarLayout, SpaceLayout, SpaceToken, TokenStyle,
};
pub use sidebar_style::{SelectMode, SidebarOverrides, SidebarStyle};
pub use status_bar::StatusBar;
use std::{
    collections::BTreeMap,
    env, fs,
    io::ErrorKind,
    path::{Path, PathBuf},
};
pub use theme::Theme;
pub(crate) use theme::ThemeName;
pub(crate) use theme::mix;

const DEFAULT_CONFIG: &str = include_str!("../config-gpui.example.toml");
// Compare the first line so Windows checkouts and editors can use CRLF.
const MANAGED_HEADER: &str = "# DO NOT EDIT -- WILL BE OVERWRITTEN";
/// Seeds the overrides file on first launch only. Existing overrides and
/// migrated personal configs are never rewritten, so settings placed here
/// reach new installs without changing what current users see.
const LOCAL_CONFIG: &str = "# Herdr GPUI overrides. Saved changes reload automatically.\n# Unset keys inherit config-gpui.toml; tables merge key by key.\n\n# New installs start with the roomy rounded sidebar. Remove this line for\n# the managed default, or pick another layout listed in config-gpui.toml.\nlayout = \"comfortable-rounded\"\n";

/// Shared logical-pixel radii for native-style chrome, independent of the
/// terminal grid. Small badges/keycaps retain a tighter curve than controls.
pub(crate) mod corners {
    pub(crate) const PANEL: f32 = 12.;
    pub(crate) const CONTROL: f32 = 8.;
    pub(crate) const SMALL: f32 = 4.;
}

#[derive(Clone, Debug)]
pub struct Config {
    pub theme: String,
    pub confirm_close_tab: bool,
    pub confirm_close_pane: bool,
    pub show_agents: bool,
    /// CPU and memory of the selected host in the status bar.
    pub show_system_load: bool,
    /// Snapshot a checkout's files each time one of its agents starts or
    /// finishes a turn, so they can be rolled back.
    pub agent_checkpoints: bool,
    /// Ports each workspace listens on, in the sidebar and the status bar.
    pub show_listening_ports: bool,
    /// Which status bar items show, and how compactly.
    pub status_bar: StatusBar,
    /// How far the app's own marks and labels stand off its chrome.
    pub contrast: Contrast,
    pub usage: crate::usage::UsageConfig,
    pub option_as_alt: OptionAsAlt,
    pub open_links_in: LinkTarget,
    /// Whether a terminal selection stays highlighted, and readable by
    /// selection tools, after it is copied.
    pub keep_selection_after_copy: bool,
    pub sidebar: FontConfig,
    pub tabs: FontConfig,
    pub terminal: FontConfig,
    pub ui: FontConfig,
    pub github: GitHubConfig,
    pub coder: CoderConfig,
    pub daytona: DaytonaConfig,
    pub features: Features,
    pub notifications: NotificationConfig,
    pub(crate) notification_overrides: NotificationSettings,
    pub clipboard_toast: ClipboardToast,
    pub bell: BellConfig,
    pub layout: Layout,
    /// Spacing overrides, host colours, and selection marking for the sidebar.
    pub sidebar_style: SidebarStyle,
    /// Daemon sidebar rows, falling back to defaults when invalid.
    pub sidebar_layout: SidebarLayout,
    pub keybindings: Keymap,
    /// The `[keybindings]` table `keybindings` was built from, kept so a
    /// device's server keys can be layered under the same GUI overrides.
    pub(crate) keybinding_overrides: BTreeMap<String, Binding>,
    /// The `[pane_keys]` table `keybindings` was built from, for the same
    /// reason.
    pub(crate) pane_keys: PaneKeys,
    /// Per saved device, by catalog profile ID.
    pub(crate) devices: BTreeMap<String, DeviceSettings>,
    pub palette: crate::palette::PaletteConfig,
    /// Keys the file names that this build does not know, sorted. They are
    /// ignored, as Herdr ignores its own, so a config written by a newer
    /// build or with a typo still loads; `diagnostic` reports them.
    pub unknown_keys: Vec<String>,
}

/// A device list larger than any real catalog is a config mistake.
const MAX_DEVICES: usize = 256;

/// Whose `[keys]` a saved device answers to, as `herdr --remote-keybindings`
/// chooses for the TUI. Local is upstream's default: muscle memory stays the
/// same on every host. Only keybindings follow the server; themes, sidebar,
/// and toasts stay local either way.
#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum KeybindingSource {
    #[default]
    Local,
    /// The host's published `server_keybindings_toml`.
    Server,
}

/// One `[devices.<profile-id>]` table.
#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub(crate) struct DeviceSettings {
    pub(crate) keybindings: KeybindingSource,
}

impl Config {
    /// Whose keybindings the endpoint uses. Local and explicit sockets are not
    /// saved devices, so they always use the local ones.
    pub(crate) fn keybinding_source(&self, endpoint_id: &str) -> KeybindingSource {
        crate::endpoint::saved_profile_id(endpoint_id)
            .and_then(|profile| self.devices.get(profile))
            .map(|device| device.keybindings)
            .unwrap_or_default()
    }
}

/// Where a clicked terminal link opens. Alt-click (Option on macOS) opens it
/// in the other one.
#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum LinkTarget {
    #[default]
    System,
    /// A browser tab in the workspace, where the build can show pages.
    BrowserTab,
}

/// Whether macOS Option sends Alt shortcuts to a pane or types the character
/// the keyboard layout puts on it. Other platforms have no Option layer, so
/// Alt always reaches the pane there.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum OptionAsAlt {
    /// The left Option sends Alt on the U.S. and ABC layouts, whose Option
    /// layer only holds symbols like `π` and dead keys like `´`; the right
    /// Option still types them. Both type elsewhere, where Option holds `@`,
    /// `[`, or letters.
    #[default]
    Auto,
    Always,
    Never,
    /// Only the left Option sends Alt; the right one types.
    Left,
    /// Only the right Option sends Alt; the left one types.
    Right,
}

/// Which Option keys a keystroke was made with, as macOS reports them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct OptionKeys {
    pub left: bool,
    pub right: bool,
}

impl OptionKeys {
    /// What a keystroke whose side is unknown counts as: the left key,
    /// which is where Alt has always been.
    pub const LEFT: Self = Self {
        left: true,
        right: false,
    };

    /// The side from an `NSEvent`'s modifier flags, whose device-dependent
    /// bits tell the two keys apart. Flags naming neither count as the left.
    #[cfg(any(target_os = "macos", test))]
    pub fn from_device_flags(flags: usize) -> Self {
        const LEFT: usize = 0x20;
        const RIGHT: usize = 0x40;
        let keys = Self {
            left: flags & LEFT != 0,
            right: flags & RIGHT != 0,
        };
        if keys.left || keys.right {
            keys
        } else {
            Self::LEFT
        }
    }
}

impl OptionAsAlt {
    /// macOS layouts whose Option characters a terminal user rarely types.
    const ALT_LAYOUTS: [&'static str; 2] = ["com.apple.keylayout.US", "com.apple.keylayout.ABC"];

    /// Whether Option-modified keys made with `keys` go to the pane as Alt
    /// under `layout`, the platform keyboard layout ID.
    pub fn sends_alt(self, layout: &str, keys: OptionKeys) -> bool {
        if !cfg!(target_os = "macos") {
            return true;
        }
        match self {
            Self::Auto => Self::ALT_LAYOUTS.contains(&layout) && keys.left,
            Self::Always => true,
            Self::Never => false,
            Self::Left => keys.left,
            Self::Right => keys.right,
        }
    }
}

impl<'de> Deserialize<'de> for OptionAsAlt {
    fn deserialize<D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> std::result::Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Value {
            Bool(bool),
            Name(String),
        }
        const NAMES: &[&str] = &["auto", "left", "right"];
        match Value::deserialize(deserializer)? {
            Value::Bool(true) => Ok(Self::Always),
            Value::Bool(false) => Ok(Self::Never),
            Value::Name(name) => match name.as_str() {
                "auto" => Ok(Self::Auto),
                "left" => Ok(Self::Left),
                "right" => Ok(Self::Right),
                _ => Err(serde::de::Error::unknown_variant(&name, NAMES)),
            },
        }
    }
}

/// Optional behaviors the config file turns on. Every flag is off by default,
/// so a missing or empty `[features]` table is the shipped experience.
#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct Features {
    /// Open a space's menu when the pointer rests on its sidebar row.
    pub sidebar_hover_menu: bool,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct GitHubConfig {
    pub oauth_client_id: Option<String>,
    pub allow_plaintext_credentials: bool,
}

impl GitHubConfig {
    pub fn client_id(&self) -> Result<Option<String>> {
        self.client_id_with_override(env::var_os("HERDR_GITHUB_OAUTH_CLIENT_ID").as_deref())
    }

    fn client_id_with_override(&self, value: Option<&std::ffi::OsStr>) -> Result<Option<String>> {
        let (id, source) = match value {
            Some(value) => (
                Some(value.to_str().ok_or(Error::ClientIdEncoding)?),
                "HERDR_GITHUB_OAUTH_CLIENT_ID",
            ),
            None => (
                Some(
                    self.oauth_client_id
                        .as_deref()
                        .unwrap_or("Iv23liurUcwxPjrdIFYT"),
                ),
                "github.oauth_client_id",
            ),
        };
        if let Some(id) = id
            && (id.is_empty()
                || id.len() > 256
                || !id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.')))
        {
            return Err(Error::InvalidClientId(source));
        }
        Ok(id.map(str::to_owned))
    }
}

/// The daemon's config is read for a handful of keys, so a file far larger
/// than any hand-written config is skipped rather than parsed on every load.
const MAX_DAEMON_CONFIG_BYTES: u64 = 1 << 20;

impl Default for Config {
    fn default() -> Self {
        let fonts::DefaultFonts {
            monospace,
            sans: ui,
            ..
        } = fonts::PLATFORM_FONTS;
        let font = |family: &str, size| FontConfig {
            family: family.into(),
            size,
            fallbacks: None,
            line_height_multiple: None,
        };
        Self {
            theme: "Default".into(),
            github: GitHubConfig::default(),
            coder: CoderConfig::default(),
            daytona: DaytonaConfig::default(),
            confirm_close_tab: true,
            confirm_close_pane: true,
            show_agents: true,
            show_system_load: true,
            agent_checkpoints: true,
            show_listening_ports: true,
            status_bar: StatusBar::default(),
            contrast: Contrast::default(),
            usage: crate::usage::UsageConfig::default(),
            option_as_alt: OptionAsAlt::default(),
            open_links_in: LinkTarget::default(),
            keep_selection_after_copy: true,
            features: Features::default(),
            notifications: NotificationConfig::default(),
            notification_overrides: NotificationSettings::default(),
            clipboard_toast: ClipboardToast::default(),
            bell: BellConfig::default(),
            layout: Layout::default(),
            sidebar_style: SidebarStyle::default(),
            sidebar_layout: SidebarLayout::default(),
            keybindings: Keymap::default(),
            keybinding_overrides: BTreeMap::new(),
            pane_keys: PaneKeys::new(),
            devices: BTreeMap::new(),
            unknown_keys: Vec::new(),
            palette: crate::palette::PaletteConfig::default(),
            sidebar: font(monospace, 12.0),
            // Tabs are terminal chrome, so they read in the monospace face the
            // sidebar and terminal use, as they do in the reference UI.
            tabs: font(monospace, 12.0),
            terminal: font(monospace, 14.0),
            ui: font(ui, 12.0),
        }
    }
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct Settings {
    theme: Option<String>,
    confirm_close_tab: Option<bool>,
    confirm_close_pane: Option<bool>,
    show_agents: Option<bool>,
    show_system_load: Option<bool>,
    agent_checkpoints: Option<bool>,
    show_listening_ports: Option<bool>,
    status_bar: StatusBar,
    contrast: Contrast,
    usage: crate::usage::UsageConfig,
    option_as_alt: OptionAsAlt,
    open_links_in: LinkTarget,
    keep_selection_after_copy: Option<bool>,
    sidebar: sidebar_style::SidebarSettings,
    tabs: FontSettings,
    terminal: FontSettings,
    ui: FontSettings,
    github: GitHubConfig,
    coder: CoderConfig,
    daytona: DaytonaConfig,
    features: Features,
    notifications: NotificationSettings,
    clipboard_toast: ClipboardToastSettings,
    bell: BellConfig,
    layout: Layout,
    keybindings: BTreeMap<String, Binding>,
    pane_keys: PaneKeys,
    devices: BTreeMap<String, DeviceSettings>,
    palette: crate::palette::PaletteConfig,
}

/// Windows sets `USERPROFILE` rather than `HOME`, and upstream Herdr reads both.
pub(crate) fn home() -> Result<PathBuf> {
    let variable = |name| env::var_os(name).filter(|value: &std::ffi::OsString| !value.is_empty());
    variable("HOME")
        .or_else(|| {
            if cfg!(windows) {
                variable("USERPROFILE")
            } else {
                None
            }
        })
        .map(PathBuf::from)
        .ok_or(Error::MissingHome)
}

/// The directory holding this app's `herdr` configuration directory. Upstream
/// Herdr puts it under `%APPDATA%` on Windows, and the GUI config lives beside
/// the daemon's, so the same root has to be used on both sides.
fn config_root() -> Result<PathBuf> {
    match env::var_os("XDG_CONFIG_HOME").filter(|value| !value.is_empty()) {
        Some(value) => {
            let path = PathBuf::from(value);
            if !path.is_absolute() {
                return Err(Error::RelativeConfigRoot);
            }
            Ok(path)
        }
        None => {
            #[cfg(windows)]
            if let Some(roaming) = env::var_os("APPDATA").filter(|value| !value.is_empty()) {
                return Ok(PathBuf::from(roaming));
            }
            #[cfg(windows)]
            return Ok(home()?.join("AppData").join("Roaming"));
            #[cfg(not(windows))]
            Ok(home()?.join(".config"))
        }
    }
}

/// The daemon's own config file, resolved exactly as herdr resolves it. Every
/// GUI reader of those settings shares this one answer.
pub(crate) fn daemon_config_path(get: impl Fn(&str) -> Option<std::ffi::OsString>) -> PathBuf {
    if let Some(path) = get("HERDR_CONFIG_PATH") {
        return path.into();
    }
    let root = get("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            #[cfg(windows)]
            {
                if let Some(root) = get("APPDATA") {
                    return PathBuf::from(root);
                }
                get("HOME")
                    .or_else(|| get("USERPROFILE"))
                    .map(PathBuf::from)
                    .map(|home| home.join("AppData/Roaming"))
                    .unwrap_or_else(env::temp_dir)
            }
            #[cfg(not(windows))]
            get("HOME")
                .map(PathBuf::from)
                .map(|home| home.join(".config"))
                .unwrap_or_else(env::temp_dir)
        });
    // Share production TUI settings even in a debug GUI build or SSH session.
    root.join("herdr/config.toml")
}

/// What the GUI honors from the daemon's own config.
#[derive(Clone, Debug, Default)]
struct Daemon {
    clipboard_toast: ClipboardToast,
    keys: DaemonKeys,
    sidebar_layout: SidebarLayout,
}

/// A config file the GUI does not own can hold anything, including settings
/// from a newer herdr, so only the keys read here matter and anything
/// unreadable, oversized, malformed, or unrecognized leaves the defaults alone.
fn daemon_settings(path: &Path) -> Daemon {
    if fs::metadata(path).is_ok_and(|data| data.len() > MAX_DAEMON_CONFIG_BYTES) {
        return Daemon::default();
    }
    let Some(table) = fs::read_to_string(path)
        .ok()
        .and_then(|text| text.parse::<toml::Table>().ok())
    else {
        return Daemon::default();
    };
    Daemon {
        clipboard_toast: daemon_clipboard_toast(&table),
        keys: DaemonKeys::from_table(table.get("keys").and_then(toml::Value::as_table)),
        sidebar_layout: SidebarLayout::from_daemon_config(&table).unwrap_or_default(),
    }
}

fn daemon_clipboard_toast(table: &toml::Table) -> ClipboardToast {
    let mut resolved = ClipboardToast::default();
    let Some(clipboard) = table
        .get("ui")
        .and_then(|ui| ui.get("toast")?.get("clipboard")?.as_table())
    else {
        return resolved;
    };
    if let Some(enabled) = clipboard.get("enabled").and_then(toml::Value::as_bool) {
        resolved.enabled = enabled;
    }
    if let Some(position) = clipboard
        .get("position")
        .cloned()
        .and_then(|position| position.try_into().ok())
    {
        resolved.position = position;
    }
    resolved
}

impl Config {
    pub fn path() -> Result<PathBuf> {
        Ok(config_root()?.join("herdr/config-gpui.toml"))
    }

    pub fn local_path() -> Result<PathBuf> {
        Ok(Self::path()?.with_extension("local.toml"))
    }

    /// A one-line warning naming the keys this build ignored, if any.
    pub(crate) fn diagnostic(&self) -> Option<String> {
        const LISTED: usize = 5;
        if self.unknown_keys.is_empty() {
            return None;
        }
        let listed = self.unknown_keys[..self.unknown_keys.len().min(LISTED)].join(", ");
        let more = match self.unknown_keys.len().saturating_sub(LISTED) {
            0 => String::new(),
            more => format!(" and {more} more"),
        };
        Some(format!(
            "config-gpui.local.toml: ignoring unknown keys {listed}{more}"
        ))
    }

    pub fn load() -> Result<Self> {
        Self::load_path(&Self::path()?, &daemon_config_path(|key| env::var_os(key)))
    }

    /// First-frame settings only: no lock, migration, writes, or fsync. The
    /// background load performs maintenance after the window has appeared.
    pub(crate) fn load_startup() -> Result<Self> {
        Self::load_startup_path(&Self::path()?, &daemon_config_path(|key| env::var_os(key)))
    }

    fn load_startup_path(path: &Path, daemon: &Path) -> Result<Self> {
        let local = path.with_extension("local.toml");
        let (text, source) = match fs::read_to_string(&local) {
            Ok(text) => (text, local),
            // Without overrides or a personal config to migrate, maintenance
            // will seed the first-launch overrides; show them from frame one.
            Err(error) if error.kind() == ErrorKind::NotFound => match fs::read_to_string(path) {
                Ok(text) if text.lines().next() != Some(MANAGED_HEADER) => (text, path.to_owned()),
                Ok(_) => (LOCAL_CONFIG.into(), local),
                Err(error) if error.kind() == ErrorKind::NotFound => (LOCAL_CONFIG.into(), local),
                Err(error) => return Err(Error::from(error).at_path(path)),
            },
            Err(error) => return Err(Error::from(error).at_path(&local)),
        };
        Self::parse_layers([DEFAULT_CONFIG, &text], &daemon_settings(daemon))
            .map_err(|error| error.at_path(&source))
    }

    /// `daemon` is the herdr config whose settings this GUI also honors. It is
    /// read for those keys alone and never written; a missing one is normal.
    fn load_path(path: &Path, daemon: &Path) -> Result<Self> {
        let base = daemon_settings(daemon);
        let (_lock, local) = Self::prepare_files(path)?;
        let text =
            fs::read_to_string(&local).map_err(|error| Error::from(error).at_path(&local))?;
        // Validate the override independently so bad types/unknown keys cannot
        // disappear inside the merge. Empty arrays explicitly replace defaults.
        Self::parse_over(&text, &base).map_err(|error| error.at_path(&local))?;
        Self::parse_layers([DEFAULT_CONFIG, &text], &base).map_err(|error| error.at_path(&local))
    }

    /// The GUI file on its own, with nothing layered under it: the shape the
    /// tests below read, since loading also consults the daemon's config.
    #[cfg(test)]
    fn parse(text: &str) -> Result<Self> {
        Self::parse_over(text, &Daemon::default())
    }

    /// `base` is what the daemon's own config asked for, which every key this
    /// file names overrides.
    fn parse_over(text: &str, base: &Daemon) -> Result<Self> {
        Self::parse_layers([text], base)
    }

    fn parse_layers<'a>(texts: impl IntoIterator<Item = &'a str>, base: &Daemon) -> Result<Self> {
        let mut builder = config_loader::Config::builder();
        for text in texts {
            builder = builder.add_source(config_loader::File::from_str(
                text,
                config_loader::FileFormat::Toml,
            ));
        }
        let loaded = builder.build()?;
        // Config's typed deserializer coerces strings/numbers. Preserve TOML
        // types so existing strict font and theme validation remains intact.
        let value: toml::Value = loaded.try_deserialize()?;
        let mut unknown_keys = Vec::new();
        let mut settings: Settings = serde_ignored::deserialize(value, |path| {
            unknown_keys.push(path.to_string());
        })?;
        settings.keybindings.retain(|name, _| {
            let known = crate::controls::COMMANDS
                .iter()
                .any(|info| info.name == name);
            if !known {
                unknown_keys.push(format!("keybindings.{name}"));
            }
            known
        });
        unknown_keys.extend(settings.usage.retain_known());
        // Only catalog profile IDs name a device; anything else is ignored
        // and reported like any other unknown key.
        settings.devices.retain(|id, _| {
            let known = herdr_client::valid_profile_id(id);
            if !known {
                unknown_keys.push(format!("devices.{id}"));
            }
            known
        });
        // Only the terminal grid takes a line height. The other faces size
        // fixed chrome, so there it is ignored like any other unknown key.
        unknown_keys.extend(
            [
                ("sidebar", &mut settings.sidebar.font),
                ("tabs", &mut settings.tabs),
                ("ui", &mut settings.ui),
            ]
            .into_iter()
            .filter_map(|(name, face)| face.reject_line_height(name)),
        );
        // Unknown keys are ignored, but a credential pasted into the file is
        // refused so it is noticed and removed rather than left on disk.
        if let Some(name) = ["client_secret", "private_key", "token"]
            .into_iter()
            .find(|name| {
                unknown_keys
                    .iter()
                    .any(|key| key == &format!("github.{name}"))
            })
        {
            return Err(Error::GitHubSecretInConfig(name));
        }
        unknown_keys.sort();
        unknown_keys.dedup();
        let mut config = Self {
            unknown_keys,
            ..Self::default()
        };
        settings.github.client_id_with_override(None)?;
        config.github = settings.github;
        // Check what the file says so a bad value is reported at load; the
        // environment may still fill or override keys when Coder is used.
        #[cfg(feature = "coder")]
        settings.coder.check()?;
        config.coder = settings.coder;
        #[cfg(feature = "daytona")]
        settings.daytona.settings_with(|_| None)?;
        config.daytona = settings.daytona;
        config.features = settings.features;
        config.notification_overrides = settings.notifications;
        config.notifications = settings
            .notifications
            .resolve(NotificationConfig::default());
        config.clipboard_toast = settings.clipboard_toast.resolve(base.clipboard_toast);
        config.bell = settings.bell;
        config.sidebar_layout = base.sidebar_layout.clone();
        if !settings.layout.sidebar_gap.is_finite()
            || !(0.0..=MAX_SIDEBAR_GAP).contains(&settings.layout.sidebar_gap)
        {
            return Err(Error::InvalidSidebarGap);
        }
        config.layout = settings.layout;
        config.sidebar_style = settings.sidebar.style()?;
        config.keybindings =
            Keymap::with_overrides(&settings.keybindings, &settings.pane_keys, &base.keys)?;
        config.keybinding_overrides = settings.keybindings;
        config.pane_keys = settings.pane_keys;
        if settings.devices.len() > MAX_DEVICES {
            return Err(Error::TooManyDevices(MAX_DEVICES));
        }
        config.devices = settings.devices;
        settings.palette.validate()?;
        config.palette = settings.palette;
        if let Some(theme) = settings.theme {
            if theme.trim().is_empty() {
                return Err(Error::EmptyTheme);
            }
            ThemeName::parse(&theme)?;
            config.theme = theme;
        }
        config.confirm_close_tab = settings.confirm_close_tab.unwrap_or(true);
        config.confirm_close_pane = settings.confirm_close_pane.unwrap_or(true);
        config.show_agents = settings.show_agents.unwrap_or(true);
        config.show_system_load = settings.show_system_load.unwrap_or(true);
        config.agent_checkpoints = settings.agent_checkpoints.unwrap_or(true);
        config.show_listening_ports = settings.show_listening_ports.unwrap_or(true);
        config.status_bar = settings.status_bar;
        config.contrast = settings.contrast;
        config.usage = settings.usage;
        config.option_as_alt = settings.option_as_alt;
        config.open_links_in = settings.open_links_in;
        config.keep_selection_after_copy = settings.keep_selection_after_copy.unwrap_or(true);
        for (name, font, settings) in [
            ("sidebar", &mut config.sidebar, settings.sidebar.font),
            ("tabs", &mut config.tabs, settings.tabs),
            ("terminal", &mut config.terminal, settings.terminal),
            ("ui", &mut config.ui, settings.ui),
        ] {
            settings.apply(name, font)?;
        }
        Ok(config)
    }
}

#[cfg(test)]
mod tests;
