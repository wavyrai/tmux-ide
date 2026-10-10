//! Home-only creation editor reusing Herdr SearchInput and pane rename semantics.
use super::{SnapshotView, browser};
use crate::search_input::SearchInput;
use gpui::{prelude::*, *};

pub(super) struct Dialog {
    request: u64,
    input: Entity<SearchInput>,
    error: Option<&'static str>,
}
fn name(value: &str) -> Option<String> {
    // Match ECMAScript String.trim used by the canonical Zod display-name schema.
    // Rust whitespace additionally includes U+0085 (a forbidden control) and omits FEFF.
    let value = value.trim_matches(|c| {
        matches!(c,
        '\u{0009}'..='\u{000D}' | '\u{0020}' | '\u{00A0}' | '\u{1680}' |
        '\u{2000}'..='\u{200A}' | '\u{2028}' | '\u{2029}' | '\u{202F}' |
        '\u{205F}' | '\u{3000}' | '\u{FEFF}')
    });
    (!value.is_empty()
        && value.encode_utf16().count() <= 100
        && !value.starts_with('-')
        && !value.chars().any(char::is_control))
    .then(|| value.to_owned())
}
impl SnapshotView {
    fn can_create_session(&self) -> bool {
        self.browser_commands.is_some()
            && self.presence.ready()
            && self.browser_state.surface == browser::Surface::Home
            && self.browser_state.home_phase == browser::HomePhase::Live
            && self.browser_state.request == self.browser_request
            && self.new_session_queued.is_none()
            && self
                .browser_state
                .create_session
                .as_ref()
                .is_some_and(|state| state.phase == browser::CreatePhase::Idle)
    }
    pub(super) fn open_new_session(
        &mut self,
        request: u64,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if request != self.browser_request || !self.can_create_session() {
            return;
        }
        self.pending_session_open = None;
        self.picker = None;
        self.pane_actions = None;
        self.divider = None;
        self.clear_selection(cx);
        self.discard_composition(cx);
        let theme = self.theme();
        let input = cx.new(|cx| {
            let mut input = SearchInput::new(cx).with_max_bytes(400);
            input.set_placeholder("Session name", cx);
            input.set_appearance(crate::config::Config::default().ui, theme, cx);
            input
        });
        input.read(cx).focus.clone().focus(window, cx);
        self.new_session = Some(Dialog {
            request,
            input,
            error: None,
        });
        cx.notify();
    }
    pub(super) fn refresh_new_session(&mut self, cx: &mut Context<Self>) {
        if self
            .new_session_queued
            .is_some_and(|(request, _)| request != self.browser_request)
        {
            self.new_session_queued = None;
        }
        if self.new_session_queued.is_some_and(|(_, revision)| {
            self.browser_state
                .create_session
                .as_ref()
                .is_some_and(|state| {
                    state.revision > revision && state.phase != browser::CreatePhase::Pending
                })
        }) {
            self.new_session_queued = None;
        }
        if self.new_session.as_ref().is_some_and(|dialog| {
            dialog.request != self.browser_request || !self.can_create_session()
        }) {
            self.new_session = None;
            cx.notify();
        }
    }
    fn close_new_session(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.new_session = None;
        self.discard_composition(cx);
        self.terminal_focus.focus(window, cx);
        cx.notify();
    }
    fn submit_new_session(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.refresh_new_session(cx);
        let Some(dialog) = &self.new_session else {
            return;
        };
        if dialog.input.read(cx).is_composing() {
            return;
        }
        let Some(name) = name(dialog.input.read(cx).text()) else {
            if let Some(dialog) = &mut self.new_session {
                dialog.error = Some("Use 1–100 characters, without controls or a leading hyphen.");
            }
            cx.notify();
            return;
        };
        let request = dialog.request;
        let revision = self
            .browser_state
            .create_session
            .as_ref()
            .map_or(0, |state| state.revision);
        if self.browser_commands.as_ref().is_some_and(|sender| {
            sender
                .try_send(browser::Command::CreateSession { request, name })
                .is_ok()
        }) {
            self.new_session_queued = Some((request, revision));
            self.close_new_session(window, cx);
        } else {
            if let Some(dialog) = &mut self.new_session {
                dialog.error = Some("Creation queue unavailable — cancel and refresh.");
            }
            cx.notify();
        }
    }
    pub(super) fn new_session_key(
        &mut self,
        event: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(dialog) = &self.new_session else {
            return;
        };
        if dialog.input.read(cx).is_composing() {
            return;
        }
        match event.keystroke.key.as_str() {
            "escape" => self.close_new_session(window, cx),
            "enter" => self.submit_new_session(window, cx),
            _ => return,
        }
        cx.stop_propagation();
        window.prevent_default();
    }
    pub(super) fn new_session_controls(&self, cx: &mut Context<Self>) -> AnyElement {
        let request = self.browser_request;
        let mut body = div()
            .id("new-session-controls")
            .mt_4()
            .flex()
            .flex_col()
            .gap_2();
        if let Some(dialog) = &self.new_session {
            body = body
                .p_3()
                .rounded(px(4.))
                .bg(rgb(self.theme().surface))
                .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                .child("New session")
                .child(dialog.input.clone())
                .children(dialog.error.map(|error| div().child(error)))
                .child(
                    div()
                        .id("new-session-submit")
                        .cursor_pointer()
                        .child("Create")
                        .on_click(
                            cx.listener(|view, _, window, cx| view.submit_new_session(window, cx)),
                        ),
                )
                .child(
                    div()
                        .id("new-session-cancel")
                        .cursor_pointer()
                        .child("Cancel")
                        .on_click(
                            cx.listener(|view, _, window, cx| view.close_new_session(window, cx)),
                        ),
                );
        } else if self.can_create_session() {
            body = body.child(
                div()
                    .id("home-new-session")
                    .debug_selector(|| "home-new-session".into())
                    .cursor_pointer()
                    .px_3()
                    .py_1()
                    .bg(rgb(self.theme().surface))
                    .child("New session…")
                    .on_click(cx.listener(move |view, _, window, cx| {
                        view.open_new_session(request, window, cx)
                    })),
            );
        } else if let Some(state) = &self.browser_state.create_session {
            let message = match state.phase {
                browser::CreatePhase::Failed => state
                    .error
                    .as_deref()
                    .unwrap_or("Creation unavailable — refresh sessions."),
                browser::CreatePhase::Pending => "Creating session…",
                browser::CreatePhase::Idle if self.new_session_queued.is_some() => {
                    "Creation submitted — refresh sessions before trying again."
                }
                browser::CreatePhase::Idle => "New session unavailable",
            };
            body = body.child(crate::notifications::safe_text(message, 256));
        }
        body.into_any_element()
    }
}
#[cfg(test)]
mod tests;
