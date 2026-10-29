//! tmux-ide-only font preferences. Reuses Herdr FontConfig/cascade resolution;
//! never reads or writes Herdr's application configuration.
mod cache;
use super::SnapshotView;
use crate::config::{Config, FONT_SIZE_RANGE, FONT_SIZE_STEP, FontConfig};
use gpui::Context;
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use std::{
    io::{self, Read, Write},
    path::{Path, PathBuf},
    sync::Arc,
};
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum Choice {
    Family(String),
    Size(i8),
}
/// Lists the installed font families; the text system's by default.
pub(super) type FontSource = Arc<dyn Fn() -> Vec<String> + Send + Sync>;
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Saved {
    version: u8,
    family: String,
    size: f32,
}
impl Saved {
    fn valid(&self) -> bool {
        self.version == 1
            && valid_name(&self.family)
            && self.size.is_finite()
            && FONT_SIZE_RANGE.contains(&self.size)
    }
}
fn valid_name(name: &str) -> bool {
    !name.trim().is_empty() && name.chars().count() <= 160 && !name.chars().any(char::is_control)
}
pub(super) struct Settings {
    pub config: FontConfig,
    /// Installed families, listed the first time the font picker opens.
    pub names: Vec<String>,
    pub saving: bool,
    /// `names` is listed, so a family can be chosen.
    pub ready: bool,
    discovery_started: bool,
    /// The preferences file has been read; until then the family is a default.
    loaded: bool,
    listing_started: bool,
    listed: bool,
    /// The family the preferences file names, before resolution.
    requested: String,
    pub revision: u64,
    pub note: Option<&'static str>,
    pub(super) path: Option<PathBuf>,
    pub source: Option<FontSource>,
}
impl Default for Settings {
    fn default() -> Self {
        let config = Config::default().terminal;
        Self {
            requested: config.family.clone(),
            config,
            names: Vec::new(),
            saving: false,
            ready: false,
            discovery_started: false,
            loaded: true,
            listing_started: false,
            listed: false,
            revision: 0,
            note: None,
            path: None,
            source: None,
        }
    }
}
impl Settings {
    /// The window's state until the launch step has read the preferences file.
    pub(super) fn pending() -> Self {
        Self {
            loaded: false,
            ..Self::default()
        }
    }
}
fn path() -> Option<PathBuf> {
    std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .or_else(|| std::env::var_os("HOME").map(|p| PathBuf::from(p).join(".config")))
        .filter(|p| p.is_absolute())
        .map(|p| p.join("tmux-ide/gpui-fonts.json"))
}
fn read_json<T: DeserializeOwned>(path: &Path) -> io::Result<T> {
    if !std::fs::metadata(path)?.is_file() {
        return Err(io::Error::other("font preferences must be a file"));
    }
    let mut bytes = Vec::new();
    std::fs::File::open(path)?
        .take(8193)
        .read_to_end(&mut bytes)?;
    if bytes.len() > 8192 {
        return Err(io::Error::other("font preferences too large"));
    }
    serde_json::from_slice(&bytes).map_err(io::Error::other)
}
fn read(path: &Path) -> io::Result<Saved> {
    let value: Saved = read_json(path)?;
    if !value.valid() {
        return Err(io::Error::other("invalid font preferences"));
    }
    Ok(value)
}
fn write_json<T: Serialize>(path: &Path, value: &T) -> io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::other("missing parent"))?;
    let name = path
        .file_name()
        .ok_or_else(|| io::Error::other("missing file name"))?;
    std::fs::create_dir_all(parent)?;
    let mut temporary = std::ffi::OsString::from(".");
    temporary.push(name);
    temporary.push(format!("-{}.tmp", std::process::id()));
    let temporary = parent.join(temporary);
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)?;
    let result = (|| {
        file.write_all(&serde_json::to_vec_pretty(value).map_err(io::Error::other)?)?;
        file.sync_all()?;
        std::fs::rename(&temporary, path)
    })();
    drop(file);
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}
fn write(path: &Path, value: &Saved) -> io::Result<()> {
    if !value.valid() {
        return Err(io::Error::other("invalid font preferences"));
    }
    write_json(path, value)
}
/// The picker's list: printable, bounded, case-insensitively sorted and unique.
fn font_names(mut names: Vec<String>) -> Vec<String> {
    names.retain(|n| valid_name(n));
    names.sort_by_key(|n| n.to_lowercase());
    names.dedup();
    names.truncate(4096);
    names
}
/// Resolves `family` and its icon cascade against the installed `names`.
fn resolve(family: &str, size: f32, names: &[String]) -> FontConfig {
    let mut config = Config::default();
    config.terminal.family = family.to_owned();
    config.terminal.size = size;
    config.resolve_fonts(|| names.to_vec());
    config.terminal
}
impl Settings {
    pub(super) fn can_choose(&self, choice: &Choice) -> bool {
        if !self.ready || self.saving {
            return false;
        }
        match choice {
            Choice::Family(name) => self.config.family != *name && self.names.contains(name),
            Choice::Size(1) => self.config.size < *FONT_SIZE_RANGE.end(),
            Choice::Size(-1) => self.config.size > *FONT_SIZE_RANGE.start(),
            Choice::Size(_) => false,
        }
    }
    fn load_from(path: Option<PathBuf>) -> Self {
        let mut result = Self {
            path,
            ..Self::default()
        };
        if let Some(path) = &result.path {
            match read(path) {
                Ok(saved) => {
                    result.config.family = saved.family;
                    result.config.size = saved.size;
                }
                Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                Err(_) => result.note = Some("Saved font settings unavailable; using defaults"),
            }
        }
        result.requested = result.config.family.clone();
        result.loaded = true;
        result
    }
    /// Resolves the requested family against `names`, now the picker's list,
    /// and remembers the result for the next launch.
    fn list(&mut self, names: Vec<String>) {
        self.config = FontConfig {
            line_height_multiple: self.config.line_height_multiple,
            ..resolve(&self.requested, self.config.size, &names)
        };
        self.names = names;
        self.ready = true;
        self.listing_started = true;
        self.listed = true;
    }
    fn remembered(&self) -> Option<(PathBuf, cache::Resolved)> {
        Some((
            self.path.clone()?,
            cache::Resolved::new(&self.requested, &self.config)?,
        ))
    }
}
impl SnapshotView {
    pub(super) fn terminal_height(&self) -> f32 {
        self.terminal_font.config.line_height()
    }
    pub(super) fn prepare_terminal_font(&self) {
        self.painter.borrow_mut().set_appearance(
            self.terminal_font.config.size,
            self.terminal_height(),
            self.theme(),
        );
    }
    pub(super) fn invalidate_font_geometry(&mut self, cx: &mut Context<Self>) {
        self.terminal_font.revision = self.terminal_font.revision.saturating_add(1);
        self.divider = None;
        self.input_geometry = None;
        self.input_cell_width = None;
        self.painted_frame = None;
        self.last_resize = None;
        self.header_controls = Default::default();
        self.wheel = Default::default();
        self.clear_selection(cx);
        self.discard_composition(cx);
        self.flush_resize_gesture(cx);
        cx.notify();
    }
    fn font_source(&self, cx: &Context<Self>) -> FontSource {
        self.terminal_font.source.clone().unwrap_or_else(|| {
            let text = cx.text_system().clone();
            Arc::new(move || text.all_font_names())
        })
    }
    /// Loads the saved font at launch. Enumerating installed fonts is left
    /// to the font picker unless no remembered resolution matches the saved
    /// family, because the icon cascade can only be detected from the list.
    pub(super) fn discover_terminal_fonts(&mut self, cx: &mut Context<Self>) {
        if self.terminal_font.discovery_started {
            return;
        }
        self.terminal_font.discovery_started = true;
        let source = self.font_source(cx);
        let location = self.terminal_font.path.clone().or_else(path);
        let task = cx.background_executor().spawn(async move {
            let mut settings = Settings::load_from(location);
            let remembered = settings.path.as_deref().and_then(cache::read);
            let requested = settings.requested.clone();
            if !remembered.is_some_and(|r| r.apply(&requested, &mut settings.config)) {
                settings.list(font_names(source()));
                if let Some((path, resolved)) = settings.remembered() {
                    cache::write(&path, &resolved);
                }
            }
            settings
        });
        cx.spawn(async move |view, cx| {
            let mut settings = task.await;
            let _ = view.update(cx, |view, cx| {
                let current = std::mem::take(&mut view.terminal_font);
                settings.discovery_started = true;
                settings.source = current.source;
                settings.revision = current.revision;
                if current.listed && !settings.ready {
                    settings.list(current.names);
                } else if current.listing_started {
                    settings.listing_started = true;
                }
                view.terminal_font = settings;
                view.invalidate_font_geometry(cx);
                view.refresh_picker(cx);
            });
        })
        .detach();
    }
    /// Lists installed fonts the first time the font picker opens.
    pub(super) fn list_terminal_fonts(&mut self, cx: &mut Context<Self>) {
        if self.terminal_font.ready || self.terminal_font.listing_started {
            return;
        }
        self.terminal_font.listing_started = true;
        let source = self.font_source(cx);
        let task = cx
            .background_executor()
            .spawn(async move { font_names(source()) });
        cx.spawn(async move |view, cx| {
            let names = task.await;
            let _ = view.update(cx, |view, cx| {
                if !view.terminal_font.loaded {
                    // The launch step resolves the saved family against these.
                    view.terminal_font.names = names;
                    view.terminal_font.listed = true;
                    return;
                }
                let before = view.terminal_font.config.clone();
                view.terminal_font.list(names);
                let after = &view.terminal_font.config;
                if after.family != before.family || after.fallbacks != before.fallbacks {
                    view.invalidate_font_geometry(cx);
                }
                if let Some((path, resolved)) = view.terminal_font.remembered() {
                    cx.background_executor()
                        .spawn(async move { cache::write(&path, &resolved) })
                        .detach();
                }
                view.refresh_picker(cx);
                cx.notify();
            });
        })
        .detach();
    }
    pub(super) fn choose_terminal_font(&mut self, choice: Choice, cx: &mut Context<Self>) {
        if !self.terminal_font.can_choose(&choice) {
            return;
        }
        let mut config = self.terminal_font.config.clone();
        match choice {
            Choice::Family(name) if self.terminal_font.names.contains(&name) => {
                config.family = name
            }
            Choice::Size(delta) if delta == 1 || delta == -1 => {
                config.size = (config.size + f32::from(delta) * FONT_SIZE_STEP)
                    .clamp(*FONT_SIZE_RANGE.start(), *FONT_SIZE_RANGE.end())
            }
            _ => return,
        }
        let Some(path) = self.terminal_font.path.clone() else {
            self.terminal_font.note = Some("Font settings location unavailable");
            cx.notify();
            return;
        };
        self.terminal_font.saving = true;
        self.terminal_font.note = Some("Saving terminal font…");
        cx.notify();
        let installed = self.terminal_font.names.clone();
        let task = cx.background_executor().spawn(async move {
            let mut resolved = Config {
                terminal: config,
                ..Config::default()
            };
            resolved.resolve_fonts(|| installed);
            let config = resolved.terminal;
            let saved = Saved {
                version: 1,
                family: config.family.clone(),
                size: config.size,
            };
            write(&path, &saved)?;
            if let Some(resolved) = cache::Resolved::new(&saved.family, &config) {
                cache::write(&path, &resolved);
            }
            Ok::<_, io::Error>(config)
        });
        cx.spawn(async move |view, cx| {
            let result = task.await;
            let _ = view.update(cx, |view, cx| {
                view.terminal_font.saving = false;
                if let Ok(config) = result {
                    view.terminal_font.config = config;
                    view.terminal_font.note = Some("Terminal font saved");
                    view.invalidate_font_geometry(cx);
                } else {
                    view.terminal_font.note =
                        Some("Could not save terminal font; previous setting retained");
                }
                view.refresh_picker(cx);
                cx.notify();
            });
        })
        .detach();
    }
}
#[cfg(test)]
mod tests;
