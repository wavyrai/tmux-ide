//! Live layout choice, committed through Settings' serial save path on close.
use super::SettingsWindow;
use crate::config::{Config, LayoutMode};
use gpui::{App, Context, Global};

#[derive(Default)]
struct LayoutDraft {
    active: bool,
    revision: u64,
    mode: Option<LayoutMode>,
}
impl Global for LayoutDraft {}

pub(crate) fn layout_load_revision(cx: &App) -> u64 {
    cx.try_global::<LayoutDraft>()
        .map_or(0, |draft| draft.revision)
}

pub(crate) fn apply_loaded_layout(config: &mut Config, revision: u64, cx: &App) {
    if let Some(draft) = cx.try_global::<LayoutDraft>()
        && (draft.active || draft.revision != revision)
        && let Some(mode) = draft.mode
    {
        // Reads started before commit must not put the old layout back either.
        config.layout.mode = mode;
    }
}

pub(super) fn clear_layout_draft(cx: &mut App) {
    let draft = cx.default_global::<LayoutDraft>();
    draft.active = false;
    draft.revision = draft.revision.wrapping_add(1);
}

#[cfg(test)]
#[derive(Clone)]
pub(super) struct LayoutIo {
    pub write: std::sync::Arc<dyn Fn(LayoutMode) -> crate::Result<()> + Send + Sync>,
    pub load: std::sync::Arc<dyn Fn() -> crate::Result<super::Loaded> + Send + Sync>,
}

impl SettingsWindow {
    pub(super) fn accept_layout_choice(&mut self, mode: LayoutMode, cx: &mut Context<Self>) {
        if self.quitting || self.closing.is_some() || self.config.layout.mode == mode {
            return;
        }
        self.layout_intent = Some(mode);
        self.config.layout.mode = mode;
        let draft = cx.default_global::<LayoutDraft>();
        draft.active = true;
        draft.mode = Some(mode);
        draft.revision = draft.revision.wrapping_add(1);
        self.status = Some("Layout draft; saved when Settings closes or the app quits".into());
        self.broadcast_layout(cx);
    }

    pub(super) fn broadcast_layout(&self, cx: &mut Context<Self>) {
        for handle in cx.windows() {
            if let Some(handle) = handle.downcast::<crate::HerdrWindow>() {
                let _ = handle.update(cx, |view, _, cx| {
                    view.config.layout.mode = self.config.layout.mode;
                    cx.notify();
                });
            }
        }
        let mut appearance = cx
            .try_global::<crate::app::InitialAppearance>()
            .cloned()
            .unwrap_or_default();
        appearance.config.layout.mode = self.config.layout.mode;
        cx.set_global(appearance);
        crate::menus::install(cx);
        cx.notify();
    }

    pub(super) fn layout_operation(
        &self,
        mode: LayoutMode,
    ) -> impl FnOnce() -> crate::Result<()> + Send + 'static + use<> {
        #[cfg(test)]
        let io = self.layout_io.clone();
        move || {
            #[cfg(test)]
            if let Some(io) = io {
                return (io.write)(mode);
            }
            Config::save_layout(mode)
        }
    }

    pub(super) fn save_layout_draft(&mut self, cx: &mut Context<Self>) {
        let Some(mode) = self.layout_intent else {
            return;
        };
        let operation = self.layout_operation(mode);
        self.layout_saving = true;
        #[cfg(test)]
        if let Some(io) = self.layout_io.clone() {
            self.save_with(operation, move || (io.load)(), false, cx);
            return;
        }
        self.save_with(operation, self.loader(cx), false, cx);
    }
}
