//! tmux-ide-only font preferences. Reuses Herdr FontConfig/cascade resolution;
//! never reads or writes Herdr's application configuration.
use super::SnapshotView;
use crate::config::{Config, FONT_SIZE_RANGE, FONT_SIZE_STEP, FontConfig};
use gpui::Context;
use serde::{Deserialize, Serialize};
use std::{
    io::{self, Read, Write},
    path::{Path, PathBuf},
};
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum Choice {
    Family(String),
    Size(i8),
}
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
            && !self.family.trim().is_empty()
            && self.family.chars().count() <= 160
            && !self.family.chars().any(char::is_control)
            && self.size.is_finite()
            && FONT_SIZE_RANGE.contains(&self.size)
    }
}
pub(super) struct Settings {
    pub config: FontConfig,
    pub names: Vec<String>,
    pub saving: bool,
    pub ready: bool,
    discovery_started: bool,
    pub revision: u64,
    pub note: Option<&'static str>,
    path: Option<PathBuf>,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            config: Config::default().terminal,
            names: Vec::new(),
            saving: false,
            ready: false,
            discovery_started: false,
            revision: 0,
            note: None,
            path: None,
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
fn read(path: &Path) -> io::Result<Saved> {
    if !std::fs::metadata(path)?.is_file() {
        return Err(io::Error::other("font preferences must be a file"));
    }
    let mut bytes = Vec::new();
    std::fs::File::open(path)?
        .take(8193)
        .read_to_end(&mut bytes)?;
    let value: Saved = serde_json::from_slice(&bytes).map_err(io::Error::other)?;
    if bytes.len() > 8192 || !value.valid() {
        return Err(io::Error::other("invalid font preferences"));
    }
    Ok(value)
}
fn write(path: &Path, value: &Saved) -> io::Result<()> {
    if !value.valid() {
        return Err(io::Error::other("invalid font preferences"));
    }
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::other("missing parent"))?;
    std::fs::create_dir_all(parent)?;
    let temporary = parent.join(format!(".gpui-fonts-{}.tmp", std::process::id()));
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
    pub fn load() -> Self {
        let mut result = Self {
            path: path(),
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
        result
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
    pub(super) fn discover_terminal_fonts(&mut self, cx: &mut Context<Self>) {
        if self.terminal_font.discovery_started {
            return;
        }
        self.terminal_font.discovery_started = true;
        let text = cx.text_system().clone();
        let task = cx.background_executor().spawn(async move {
            let mut settings = Settings::load();
            let mut names = text.all_font_names();
            names.retain(|n| {
                !n.trim().is_empty() && n.chars().count() <= 160 && !n.chars().any(char::is_control)
            });
            names.sort_by_key(|n| n.to_lowercase());
            names.dedup();
            names.truncate(4096);
            let mut config = Config::default();
            config.terminal = settings.config;
            config.resolve_fonts(|| names.clone());
            settings.config = config.terminal;
            settings.names = names;
            settings.ready = true;
            settings.discovery_started = true;
            settings
        });
        cx.spawn(async move |view, cx| {
            let settings = task.await;
            let _ = view.update(cx, |view, cx| {
                view.terminal_font = settings;
                view.invalidate_font_geometry(cx);
                view.refresh_picker(cx);
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
            write(&path, &saved).map(|()| config)
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
