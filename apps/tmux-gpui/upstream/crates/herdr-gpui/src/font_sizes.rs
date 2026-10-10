//! Immediate size previews with one background writer and at most one queued edit per face.
use crate::{
    HerdrWindow,
    config::{Config, FONT_SIZE_RANGE, FontFace},
};
use gpui::{BorrowAppContext, Context, Task};

struct Edit {
    face: FontFace,
    size: f32,
    previous: f32,
}

#[derive(Default)]
pub(crate) struct FontSizeSaves {
    pending: Vec<Edit>,
    task: Option<Task<()>>,
    error: Option<String>,
}

impl FontSizeSaves {
    pub(crate) fn is_busy(&self) -> bool {
        self.task.is_some() || !self.pending.is_empty()
    }

    pub(crate) fn status(&self) -> Option<&str> {
        self.error
            .as_deref()
            .or_else(|| self.is_busy().then_some("Saving font sizes…"))
    }

    fn queue(&mut self, face: FontFace, size: f32, previous: f32) {
        if let Some(edit) = self.pending.iter_mut().find(|edit| edit.face == face) {
            edit.size = size;
        } else {
            self.pending.push(Edit {
                face,
                size,
                previous,
            });
        }
        self.error = None;
    }

    pub(crate) fn apply_pending(&mut self, config: &mut Config) {
        for edit in &mut self.pending {
            // A reload establishes a new rollback baseline, never a new draft.
            edit.previous = edit.face.size(config);
            edit.face.set_size(config, edit.size);
        }
    }

    fn rollback(&mut self, edits: &[Edit], config: &mut Config) {
        for edit in edits {
            if let Some(newer) = self
                .pending
                .iter_mut()
                .find(|newer| newer.face == edit.face)
            {
                newer.previous = edit.previous;
            } else if edit.face.size(config) == edit.size {
                edit.face.set_size(config, edit.previous);
            }
        }
    }
}

impl HerdrWindow {
    pub(crate) fn set_font_size(&mut self, face: FontFace, size: f32, cx: &mut Context<Self>) {
        if self.native_settings_save_in_flight()
            || !FONT_SIZE_RANGE.contains(&size)
            || face.size(&self.config) == size
        {
            return;
        }
        self.font_size_saves
            .queue(face, size, face.size(&self.config));
        face.set_size(&mut self.config, size);
        crate::log_window::set_appearance(&self.config, &self.theme, cx);
        cx.notify();
        self.flush_font_sizes(cx);
    }

    pub(crate) fn flush_font_sizes(&mut self, cx: &mut Context<Self>) {
        self.flush_font_sizes_with(Config::save_font_sizes, cx);
    }

    fn flush_font_sizes_with(
        &mut self,
        save: impl Fn(&[(FontFace, f32)]) -> crate::Result<()> + Send + 'static,
        cx: &mut Context<Self>,
    ) {
        if self.config_load.is_some()
            || self.font_size_saves.task.is_some()
            || self.font_size_saves.pending.is_empty()
        {
            return;
        }
        let edits = std::mem::take(&mut self.font_size_saves.pending);
        let sizes: Vec<_> = edits.iter().map(|edit| (edit.face, edit.size)).collect();
        let saved = cx.background_executor().spawn(async move {
            let result = save(&sizes);
            (result, save)
        });
        self.font_size_saves.task = Some(cx.spawn(async move |this, cx| {
            let (result, save) = saved.await;
            let _ = this.update(cx, |this, cx| {
                this.font_size_saves.task = None;
                match result {
                    Ok(()) => {
                        this.font_size_saves.error = None;
                        for edit in &edits {
                            if edit.face == FontFace::Terminal {
                                this.configured_terminal_size = edit.size;
                            }
                        }
                        if cx.has_global::<crate::app::InitialAppearance>() {
                            cx.update_global::<crate::app::InitialAppearance, _>(
                                |appearance, _| {
                                    for edit in &edits {
                                        edit.face.set_size(&mut appearance.config, edit.size);
                                    }
                                },
                            );
                        }
                    }
                    Err(error) => {
                        tracing::warn!(%error, "Could not save font sizes");
                        this.font_size_saves.rollback(&edits, &mut this.config);
                        this.font_size_saves.error =
                            Some(format!("Could not save font sizes: {error}"));
                        crate::log_window::set_appearance(&this.config, &this.theme, cx);
                    }
                }
                // Only completion releases the writer; later clicks replace queued sizes.
                this.flush_font_sizes_with(save, cx);
                cx.notify();
            });
        }));
    }
}

#[cfg(test)]
mod tests;
