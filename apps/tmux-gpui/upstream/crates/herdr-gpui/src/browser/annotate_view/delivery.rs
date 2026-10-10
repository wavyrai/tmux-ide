//! Sending a tab's notes to the agent that opened its page, through the
//! shared delivery in `agent_notes`, or copying them.

use super::{
    super::{Tab, annotate},
    screenshots::save_screenshots,
};
use crate::{HerdrWindow, window::Flash};
use gpui::{prelude::*, *};
use std::sync::Arc;

impl HerdrWindow {
    /// The queued notes as a prompt, after their screenshots are saved to
    /// files the agent can read. Saving runs off the UI thread; `then` gets
    /// the prompt back on it.
    fn with_notes_prompt(
        &mut self,
        tab: &Tab,
        cx: &mut Context<Self>,
        then: impl FnOnce(&mut Self, String, &mut Context<Self>) + 'static,
    ) {
        let notes = self.tab_notes(tab.id).notes.clone();
        if notes.is_empty() {
            return;
        }
        let reload = crate::control::reload_command();
        if notes.iter().all(|note| note.image.is_none()) {
            let text = annotate::prompt(tab, &notes, &[], &reload);
            then(self, text, cx);
            return;
        }
        let images: Vec<Option<Arc<Image>>> = notes.iter().map(|note| note.image.clone()).collect();
        let saving = cx
            .background_executor()
            .spawn(async move { save_screenshots(&images) });
        let tab = tab.clone();
        cx.spawn(async move |this, cx| {
            let paths = saving.await;
            this.update(cx, |this, cx| {
                let paths = paths.unwrap_or_else(|error| {
                    tracing::warn!(%error, "Could not save note screenshots");
                    this.show_flash(Flash::warning("Screenshots could not be saved"), cx);
                    Vec::new()
                });
                let text = annotate::prompt(&tab, &notes, &paths, &reload);
                then(this, text, cx);
            })
            .ok();
        })
        .detach();
    }

    pub(super) fn copy_notes(&mut self, tab: &Tab, cx: &mut Context<Self>) {
        self.with_notes_prompt(tab, cx, |this, text, cx| {
            cx.write_to_clipboard(ClipboardItem::new_string(text));
            this.show_flash(Flash::success("Notes copied"), cx);
        });
    }

    /// Sends the queued notes to the agent that opened the page: to it
    /// directly when it waits in `browser feedback`, otherwise into its pane
    /// once it is idle, and kept for `browser feedback` when its pane is gone.
    pub(in crate::browser) fn send_notes(&mut self, tab: &Tab, cx: &mut Context<Self>) {
        // The queue is cleared at once, so a second Send cannot repeat it
        // while screenshots are still being saved.
        let pane_id = tab.origin.clone();
        let here = super::super::view::scope(&self.endpoints[self.selected_endpoint]) == tab.scope;
        self.with_notes_prompt(tab, cx, move |this, text, cx| {
            this.deliver_notes(pane_id, here, text, cx);
        });
        self.clear_notes(tab.id, cx);
    }
}
