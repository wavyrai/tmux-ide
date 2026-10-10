//! The daemon's update notice and release notes. Closing the sheet tells the
//! daemon the notes were read, so its other clients agree. An install command
//! is shown for the user to review and run; nothing here runs it.
use super::Page;
use crate::{HerdrWindow, fonts::StyledFont, notifications::safe_text};
use gpui::{prelude::*, *};
use herdr_client::Method;

const MAX_BODY_HEIGHT: f32 = 360.;
const MAX_COMMAND: usize = 1024;

impl HerdrWindow {
    /// The menu entry for the sheet, when the daemon has something for it.
    pub(super) fn release_notes_item(&self) -> Option<&'static str> {
        let snapshot = self.live.snapshot.as_deref()?;
        if snapshot.update_available.is_some() {
            Some("update ready")
        } else if snapshot.release_notes.is_some() {
            Some("what's new")
        } else {
            None
        }
    }

    pub(super) fn render_release_notes(&self, cx: &mut Context<Self>) -> Div {
        let theme = &self.theme;
        let snapshot = self.live.snapshot.as_deref();
        let update = snapshot.and_then(|s| s.update_available.as_deref());
        let notes = snapshot.and_then(|s| s.release_notes.as_ref());
        let title = match (update, notes) {
            (Some(version), _) => format!("Update ready: Herdr {}", safe_text(version, 64)),
            (None, Some(notes)) => {
                format!("What's new in Herdr {}", safe_text(&notes.version, 64))
            }
            (None, None) => "Release notes are unavailable".into(),
        };
        let mut sheet = div()
            .debug_selector(|| "release-notes".into())
            .flex()
            .flex_col()
            .child(
                div()
                    .debug_selector(|| "release-notes-title".into())
                    .p(px(8.))
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(title),
            );
        if update.is_some() {
            let command = snapshot
                .map(|s| s.update_install_command.trim())
                .filter(|command| !command.is_empty());
            sheet = sheet
                .child(
                    div()
                        .p(px(8.))
                        .child("Suggested command (review and run yourself):"),
                )
                .child(
                    div()
                        .debug_selector(|| "release-notes-command".into())
                        .mx(px(8.))
                        .p(px(8.))
                        .rounded(px(crate::config::corners::CONTROL))
                        .bg(rgb(theme.active))
                        .text_font(&self.config.terminal)
                        .child(command.map_or_else(
                            || "No install command provided by daemon.".into(),
                            |command| safe_text(command, MAX_COMMAND),
                        )),
                )
                .child(
                    div()
                        .p(px(8.))
                        .text_color(rgb(theme.subtext()))
                        .child("Nothing is installed or executed by this panel."),
                );
        }
        if let Some(notes) = notes {
            let lines = self.daemon_text.release_notes.lines(&notes.body);
            sheet = sheet
                .when(update.is_some(), |sheet| {
                    sheet.child(div().p(px(8.)).text_color(rgb(theme.muted)).child(format!(
                        "Release notes for {}",
                        safe_text(&notes.version, 64)
                    )))
                })
                .child(
                    div()
                        .id("release-notes-body")
                        .debug_selector(|| "release-notes-body".into())
                        .px(px(8.))
                        .py(px(4.))
                        .max_h(px(MAX_BODY_HEIGHT))
                        .overflow_y_scroll()
                        .child(crate::release_notes::render(
                            "release-notes",
                            &lines,
                            theme,
                            &self.config.terminal,
                        )),
                );
        }
        sheet.child(
            div()
                .id("menu-close")
                .debug_selector(|| "release-notes-close".into())
                .p(px(8.))
                .cursor_pointer()
                .child("Close")
                .on_click(cx.listener(|this, _, window, cx| {
                    cx.stop_propagation();
                    this.dismiss_menu(window, cx);
                })),
        )
    }

    /// Tells the daemon the shown release notes were read, as the sheet closes.
    pub(super) fn dismiss_release_notes(&mut self) {
        if self.menu.page != Some(Page::Update)
            || !self.menu_target_current()
            || !self.live.supports_release_notes_dismiss
        {
            return;
        }
        let Some(snapshot) = self.live.snapshot.as_deref() else {
            return;
        };
        let Some(notes) = snapshot.release_notes.as_ref() else {
            return;
        };
        let Some(handle) = &self.endpoints[self.selected_endpoint].connection.handle else {
            return;
        };
        if let Err(error) = handle.request(
            &snapshot.boot_id,
            Method::ReleaseNotesDismiss,
            serde_json::json!({ "version": notes.version }),
        ) {
            self.local_error = Some(format!("Release notes: {error}"));
        }
    }
}
