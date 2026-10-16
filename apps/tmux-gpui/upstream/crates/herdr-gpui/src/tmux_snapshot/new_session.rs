//! Home-only creation editor reusing Herdr SearchInput and pane rename semantics.
use super::{SnapshotView, browser, browser_ui::Selection, controls};
use crate::search_input::SearchInput;
use bezel_ui::widgets::Status;
use gpui::{prelude::*, *};

pub(super) struct Dialog {
    request: u64,
    local_target: Option<browser::fleet::SelectedServer>,
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
        self.begin_session_dialog(request, None, window, cx);
    }
    fn begin_session_dialog(
        &mut self,
        request: u64,
        local_target: Option<browser::fleet::SelectedServer>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.pending_session_open = None;
        self.cancel_attention();
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
            local_target,
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
            dialog.request != self.browser_request
                || (dialog.local_target.is_none() && !self.can_create_session())
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
        if !self.can_create_session() || !self.local_dialog_ready(dialog) {
            if let Some(dialog) = &mut self.new_session {
                dialog.error =
                    Some("Local server is not ready — wait for connection or cancel and retry.");
            }
            cx.notify();
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
    fn local_session_target(&self) -> Option<(String, browser::fleet::SelectedServer)> {
        if self.browser_commands.is_none()
            || !self.presence.ready()
            || self.browser_state.surface != browser::Surface::Home
            || self.browser_request != self.browser_state.request
            || self.new_session_queued.is_some()
        {
            return None;
        }
        let fleet = self.browser_state.fleet.as_ref()?;
        let group = fleet.groups.iter().find(|group| {
            group.id == "local" && group.state == browser::fleet::Phase::Ready && !group.conflict
        })?;
        let eligible = |server: &&browser::fleet::Server| {
            server.state == browser::fleet::ServerPhase::Online
                && server.selection.is_some()
                && server.generation.is_some()
        };
        let server = group
            .servers
            .iter()
            .filter(eligible)
            .find(|server| {
                self.browser_state
                    .selected_server
                    .as_ref()
                    .is_some_and(|selected| {
                        selected.machine_id == group.id && selected.server_id == server.id
                    })
            })
            .or_else(|| group.servers.iter().find(eligible))?;
        Some((
            server.selection.clone()?,
            browser::fleet::SelectedServer {
                machine_id: group.id.clone(),
                machine_label: group.label.clone(),
                server_id: server.id.clone(),
                generation: server.generation.clone()?,
                label: server.label.clone(),
            },
        ))
    }
    fn local_dialog_ready(&self, dialog: &Dialog) -> bool {
        dialog.local_target.as_ref().is_none_or(|target| {
            self.browser_state
                .selected_server
                .as_ref()
                .is_some_and(|selected| {
                    selected.machine_id == target.machine_id
                        && selected.server_id == target.server_id
                        && selected.generation == target.generation
                })
        })
    }
    fn open_local_session(&mut self, request: u64, window: &mut Window, cx: &mut Context<Self>) {
        if request != self.browser_request || self.new_session.is_some() || self.picker.is_some() {
            return;
        }
        let Some((token, target)) = self.local_session_target() else {
            return;
        };
        self.select(Selection::FleetServer(token), window, cx);
        if self.browser_commands.is_some() {
            self.begin_session_dialog(self.browser_request, Some(target), window, cx);
        }
    }
    pub(super) fn local_session_action(&self, cx: &mut Context<Self>) -> Stateful<Div> {
        let request = self.browser_request;
        let available = self.local_session_target().is_some() && self.new_session.is_none();
        controls::action_button(
            "home-new-local-session",
            Some("New local session…"),
            "Create a session on this Mac",
            controls::Icon::Plus,
            if available {
                controls::ButtonStyle::Primary
            } else {
                controls::ButtonStyle::Unavailable
            },
            &self.theme(),
        )
        .debug_selector(|| "home-new-local-session".into())
        .when(available, |button| {
            button.on_click(cx.listener(move |view, _, window, cx| {
                view.open_local_session(request, window, cx);
            }))
        })
        .when(!available, |button| {
            button.aria_description(
                "Connect to a local tmux server from Your fleet, then create a session.",
            )
        })
    }
    pub(super) fn local_session_available(&self) -> bool {
        self.local_session_target().is_some() && self.new_session.is_none()
    }
    pub(super) fn new_session_controls(&self, cx: &mut Context<Self>) -> AnyElement {
        let request = self.browser_request;
        let mut body = (if self.new_session.is_some() {
            bezel_ui::popover::dialog_card(&super::design::palette(&self.theme())).w_full()
        } else {
            div()
        })
        .id("new-session-controls")
        .mt_4()
        .flex()
        .flex_col()
        .items_start()
        .gap_2();
        if let Some(server) = &self.browser_state.selected_server {
            body = body.child(
                div()
                    .min_w_0()
                    .truncate()
                    .text_color(rgb(self.theme().muted))
                    .child(format!(
                        "New sessions on {} · {}",
                        server.machine_label, server.label
                    )),
            );
        }
        if let Some(dialog) = &self.new_session {
            body = body
                .p_3()
                .w_full()
                .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                .child(if dialog.local_target.is_some() {
                    "New local session"
                } else {
                    "New session"
                })
                .children(dialog.local_target.as_ref().map(|target| {
                    div().text_color(rgb(self.theme().muted)).child(format!(
                        "{} · {}{}",
                        target.machine_label,
                        target.label,
                        if self.can_create_session() && self.local_dialog_ready(dialog) {
                            ""
                        } else {
                            " — waiting for server"
                        }
                    ))
                }))
                .child(dialog.input.clone())
                .children(dialog.error.map(|error| {
                    super::design::palette(&self.theme())
                        .error_strip(error)
                        .mt_0()
                        .px_2()
                        .py_1()
                        .min_w_0()
                        .w_full()
                }))
                .child(
                    controls::action_button(
                        "new-session-submit",
                        Some("Create"),
                        "Create session",
                        controls::Icon::Plus,
                        controls::ButtonStyle::Primary,
                        &self.theme(),
                    )
                    .on_click(
                        cx.listener(|view, _, window, cx| view.submit_new_session(window, cx)),
                    ),
                )
                .child(
                    controls::action_button(
                        "new-session-cancel",
                        Some("Cancel"),
                        "Cancel session creation",
                        controls::Icon::Close,
                        controls::ButtonStyle::Quiet,
                        &self.theme(),
                    )
                    .on_click(
                        cx.listener(|view, _, window, cx| view.close_new_session(window, cx)),
                    ),
                );
        } else if self.can_create_session() {
            body = body.child(
                controls::action_button(
                    "home-new-session",
                    Some("New session…"),
                    "Create on selected server",
                    controls::Icon::Plus,
                    controls::ButtonStyle::Quiet,
                    &self.theme(),
                )
                .self_start()
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
            let message = crate::notifications::safe_text(message, 256);
            body = body.child(match state.phase {
                browser::CreatePhase::Failed => super::design::palette(&self.theme())
                    .error_strip(message)
                    .mt_0()
                    .px_2()
                    .py_1()
                    .min_w_0()
                    .w_full(),
                browser::CreatePhase::Idle if self.new_session_queued.is_some() => {
                    super::design::palette(&self.theme())
                        .warning_strip(message)
                        .mt_0()
                        .px_2()
                        .py_1()
                        .min_w_0()
                        .w_full()
                }
                _ => div().child(message),
            });
        }
        body.into_any_element()
    }
}
#[cfg(test)]
mod tests;
