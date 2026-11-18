//! "Opaque window" (owner, 18 Nov): the user's own way to turn the frosted
//! chrome off, next to the automatic rules (Reduce Transparency, Increase
//! Contrast, themes whose text can't read on frost). Off by default; saved
//! in ~/.config/tmux-ide/gpui-opaque.json in Developer mode's format.
use super::{SnapshotView, developer_mode};
use gpui::Context;
use std::{io, path::PathBuf};

#[derive(Default)]
pub(super) struct Setting {
    /// The window is opaque whatever the accessibility settings allow.
    pub enabled: bool,
    pub ready: bool,
    pub saving: bool,
    pub note: Option<&'static str>,
    started: bool,
    path: Option<PathBuf>,
}

pub(super) const SAVE_FAILED: &str = "Could not save Opaque window; previous setting retained";

impl Setting {
    pub(super) fn load(path: Option<PathBuf>) -> Self {
        let mut setting = Self {
            ready: true,
            started: true,
            path,
            ..Self::default()
        };
        if let Some(path) = &setting.path {
            match developer_mode::read(path) {
                Ok(saved) => setting.enabled = saved.enabled,
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(_) => setting.note = Some("Saved Opaque window unavailable; using Off"),
            }
        }
        setting
    }
}

impl SnapshotView {
    pub(super) fn load_opaque_window(&mut self, cx: &mut Context<Self>) {
        if self.chrome.opaque.started {
            return;
        }
        self.chrome.opaque.started = true;
        let task = cx
            .background_executor()
            .spawn(async { Setting::load(developer_mode::config_path("gpui-opaque.json")) });
        cx.spawn(async move |view, cx| {
            let setting = task.await;
            let _ = view.update(cx, |view, cx| {
                view.chrome.opaque = setting;
                cx.notify();
            });
        })
        .detach();
    }

    /// Saves first and applies on success, so the window never shows a
    /// setting the next launch would not.
    pub(super) fn set_opaque_window(&mut self, enabled: bool, cx: &mut Context<Self>) {
        let setting = &mut self.chrome.opaque;
        if !setting.ready || setting.saving || setting.enabled == enabled {
            return;
        }
        let Some(path) = setting.path.clone() else {
            setting.note = Some(SAVE_FAILED);
            cx.notify();
            return;
        };
        setting.saving = true;
        setting.note = None;
        cx.notify();
        let task = cx
            .background_executor()
            .spawn(async move { developer_mode::write(&path, enabled) });
        cx.spawn(async move |view, cx| {
            let result = task.await;
            let _ = view.update(cx, |view, cx| {
                let setting = &mut view.chrome.opaque;
                setting.saving = false;
                if result.is_ok() {
                    setting.enabled = enabled;
                    setting.note = None;
                } else {
                    setting.note = Some(SAVE_FAILED);
                }
                cx.notify();
            });
        })
        .detach();
    }
}

#[cfg(test)]
pub(super) fn for_test(path: Option<PathBuf>) -> Setting {
    Setting::load(path)
}
