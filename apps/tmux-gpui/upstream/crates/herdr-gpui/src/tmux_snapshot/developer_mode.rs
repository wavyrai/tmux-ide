//! Local presentation preference; never changes daemon or terminal authority.
use super::SnapshotView;
use gpui::Context;
use serde::{Deserialize, Serialize};
use std::{
    io::{self, Read, Write},
    path::{Path, PathBuf},
};

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Saved {
    version: u8,
    enabled: bool,
}
#[derive(Default)]
pub(super) struct Settings {
    pub enabled: bool,
    pub ready: bool,
    pub saving: bool,
    pub note: Option<&'static str>,
    started: bool,
    path: Option<PathBuf>,
}
fn path() -> Option<PathBuf> {
    std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .or_else(|| std::env::var_os("HOME").map(|p| PathBuf::from(p).join(".config")))
        .filter(|p| p.is_absolute())
        .map(|p| p.join("tmux-ide/gpui-developer.json"))
}
fn read(path: &Path) -> io::Result<Saved> {
    if !std::fs::metadata(path)?.is_file() {
        return Err(io::Error::other("developer preferences must be a file"));
    }
    let mut bytes = Vec::new();
    std::fs::File::open(path)?
        .take(1025)
        .read_to_end(&mut bytes)?;
    if bytes.len() > 1024 {
        return Err(io::Error::other("developer preferences exceed limit"));
    }
    let saved: Saved = serde_json::from_slice(&bytes).map_err(io::Error::other)?;
    if saved.version != 1 {
        return Err(io::Error::other(
            "unsupported developer preferences version",
        ));
    }
    Ok(saved)
}
fn write(path: &Path, enabled: bool) -> io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::other("missing preferences parent"))?;
    std::fs::create_dir_all(parent)?;
    let temporary = parent.join(format!(".gpui-developer-{}.tmp", std::process::id()));
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)?;
    let result = (|| {
        file.write_all(
            &serde_json::to_vec(&Saved {
                version: 1,
                enabled,
            })
            .map_err(io::Error::other)?,
        )?;
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
    #[cfg(test)]
    pub(super) fn for_test(path: PathBuf) -> Self {
        Self::load(Some(path))
    }

    fn load(path: Option<PathBuf>) -> Self {
        let mut settings = Self {
            path,
            ready: true,
            started: true,
            ..Default::default()
        };
        if let Some(path) = &settings.path {
            match read(path) {
                Ok(saved) => settings.enabled = saved.enabled,
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(_) => settings.note = Some("Saved Developer mode unavailable; using Off"),
            }
        }
        settings
    }
}
impl SnapshotView {
    pub(super) fn load_developer_mode(&mut self, cx: &mut Context<Self>) {
        if self.developer_mode.started {
            return;
        }
        self.developer_mode.started = true;
        let task = cx
            .background_executor()
            .spawn(async { Settings::load(path()) });
        cx.spawn(async move |view, cx| {
            let settings = task.await;
            let _ = view.update(cx, |view, cx| {
                view.developer_mode = settings;
                view.refresh_picker(cx);
                cx.notify();
            });
        })
        .detach();
    }
    pub(super) fn set_developer_mode(&mut self, enabled: bool, cx: &mut Context<Self>) {
        if !self.developer_mode.ready
            || self.developer_mode.saving
            || self.developer_mode.enabled == enabled
        {
            return;
        }
        let Some(path) = self.developer_mode.path.clone() else {
            self.developer_mode.note =
                Some("Developer settings location unavailable; previous setting retained");
            cx.notify();
            return;
        };
        self.developer_mode.saving = true;
        self.developer_mode.note = Some("Saving Developer mode…");
        cx.notify();
        let task = cx
            .background_executor()
            .spawn(async move { write(&path, enabled) });
        cx.spawn(async move |view, cx| {
            let result = task.await;
            let _ = view.update(cx, |view, cx| {
                view.developer_mode.saving = false;
                if result.is_ok() {
                    view.developer_mode.enabled = enabled;
                    view.developer_mode.note = Some("Developer mode saved");
                } else {
                    view.developer_mode.note =
                        Some("Could not save Developer mode; previous setting retained");
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
