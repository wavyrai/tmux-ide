//! Adapt Herdr pane_menu's captured target and rename editor, without its RPC.
use super::{SnapshotView, browser};
use crate::search_input::SearchInput;
use gpui::{prelude::*, *};
use serde::Serialize;

#[derive(Serialize)]
#[serde(tag = "action", rename_all = "lowercase")]
pub(super) enum Action {
    Rename { name: String },
    Zoom { desired: Zoom },
}
#[derive(Serialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum Zoom {
    Zoomed,
    Unzoomed,
}
#[derive(Clone)]
struct Target {
    request: u64,
    session: String,
    actions: browser::PaneActions,
}
impl Target {
    fn capture(state: &browser::State) -> Option<Self> {
        let actions = state.pane_actions.clone()?;
        if state.surface != browser::Surface::Workspace
            || !state.input_ready
            || state.frame.is_none()
            || state.selected_pane.as_ref() != Some(&actions.id)
            || !state.panes.iter().any(|p| p.id == actions.id)
        {
            return None;
        }
        Some(Self {
            request: state.request,
            session: state.selected_session.clone()?,
            actions,
        })
    }
    fn current(&self, state: &browser::State) -> bool {
        Self::capture(state).is_some_and(|now| {
            now.request == self.request
                && now.session == self.session
                && now.actions == self.actions
        })
    }
}
pub(super) struct Menu {
    target: Target,
    input: Option<Entity<SearchInput>>,
    error: Option<&'static str>,
}
fn name(text: &str) -> Option<String> {
    let text = text.trim();
    (!text.is_empty() && text.encode_utf16().count() <= 80 && !text.chars().any(char::is_control))
        .then(|| text.to_owned())
}
impl SnapshotView {
    fn open_pane_actions(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(target) = Target::capture(&self.browser_state) else {
            return;
        };
        if self.browser_commands.is_none()
            || self.browser_request != target.request
            || !self.presence.ready()
        {
            return;
        }
        self.pending_session_open = None;
        self.picker = None;
        self.divider = None;
        self.clear_selection(cx);
        self.discard_composition(cx);
        self.pane_actions = Some(Menu {
            target,
            input: None,
            error: None,
        });
        self.terminal_focus.focus(window, cx);
        cx.notify();
    }
    pub(super) fn refresh_pane_actions(&mut self, cx: &mut Context<Self>) {
        if self.pane_actions.as_ref().is_some_and(|m| {
            self.browser_commands.is_none()
                || !self.presence.ready()
                || self.browser_request != m.target.request
                || !m.target.current(&self.browser_state)
        }) {
            self.pane_actions = None;
            cx.notify();
        }
    }
    fn close_pane_actions(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.pane_actions = None;
        self.terminal_focus.focus(window, cx);
        cx.notify();
    }
    fn edit_pane_name(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.refresh_pane_actions(cx);
        let Some(menu) = self.pane_actions.as_ref() else {
            return;
        };
        let label = self
            .browser_state
            .panes
            .iter()
            .find(|p| p.id == menu.target.actions.id)
            .map(|p| p.label.clone())
            .unwrap_or_default();
        let theme = self.theme();
        let input = cx.new(|cx| {
            let mut input = SearchInput::new(cx).with_max_bytes(320);
            input.set_placeholder("Pane name (1–80 characters)", cx);
            input.set_appearance(crate::config::Config::default().ui, theme, cx);
            if name(&label).is_some() {
                input.set_text_selected(&label, cx);
            }
            input
        });
        input.read(cx).focus.clone().focus(window, cx);
        if let Some(menu) = &mut self.pane_actions {
            menu.input = Some(input);
            menu.error = None;
        }
        cx.notify();
    }
    fn send_pane_action(&mut self, rename: bool, window: &mut Window, cx: &mut Context<Self>) {
        self.refresh_pane_actions(cx);
        let Some(menu) = self.pane_actions.as_ref() else {
            return;
        };
        let action = if rename {
            let Some(input) = &menu.input else {
                return;
            };
            if input.read(cx).is_composing() {
                return;
            }
            let Some(name) = name(input.read(cx).text()) else {
                if let Some(menu) = &mut self.pane_actions {
                    menu.error = Some("Use 1–80 characters without control characters.");
                }
                cx.notify();
                return;
            };
            Action::Rename { name }
        } else {
            Action::Zoom {
                desired: if menu.target.actions.zoomed {
                    Zoom::Unzoomed
                } else {
                    Zoom::Zoomed
                },
            }
        };
        let command = browser::Command::PaneAction {
            request: menu.target.request,
            id: menu.target.actions.id.clone(),
            token: menu.target.actions.token.clone(),
            action,
        };
        if self
            .browser_commands
            .as_ref()
            .is_some_and(|sender| sender.try_send(command).is_ok())
        {
            // Queue admission is not acknowledgement. The one-use token prevents
            // another action until a fresh daemon publication grants capability.
            self.browser_state.pane_actions = None;
            self.close_pane_actions(window, cx);
        } else if let Some(menu) = &mut self.pane_actions {
            menu.error = Some("Action queue unavailable — cancel and reselect the pane.");
            cx.notify();
        }
    }
    pub(super) fn pane_actions_key(
        &mut self,
        event: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(menu) = self.pane_actions.as_ref() else {
            return;
        };
        if menu
            .input
            .as_ref()
            .is_some_and(|input| input.read(cx).is_composing())
        {
            return;
        }
        match event.keystroke.key.as_str() {
            "escape" => self.close_pane_actions(window, cx),
            "enter" if menu.input.is_some() => self.send_pane_action(true, window, cx),
            _ => return,
        }
        cx.stop_propagation();
        window.prevent_default();
    }
    pub(super) fn pane_actions_button(&self, cx: &mut Context<Self>) -> AnyElement {
        let available = self.browser_commands.is_some()
            && self.presence.ready()
            && Target::capture(&self.browser_state)
                .is_some_and(|t| t.request == self.browser_request);
        div()
            .id("pane-actions-open")
            .px_2()
            .py_1()
            .flex_shrink_0()
            .text_color(rgb(self.theme().muted))
            .child(if available {
                "Actions…"
            } else {
                "Actions unavailable"
            })
            .when(available, |button| {
                button
                    .cursor_pointer()
                    .on_click(cx.listener(|view, _, window, cx| view.open_pane_actions(window, cx)))
            })
            .into_any_element()
    }
    pub(super) fn pane_actions_panel(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let menu = self.pane_actions.as_ref()?;
        let active = self.theme().active;
        let mut panel = div()
            .id("pane-actions-panel")
            .absolute()
            .bottom(relative(1.))
            .left_0()
            .occlude()
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .on_scroll_wheel(|_, _, cx| cx.stop_propagation())
            .flex_none()
            .w_full()
            .max_h(px(180.))
            .overflow_y_scroll()
            .p_2()
            .bg(rgb(self.theme().surface))
            .border_t_1()
            .border_color(rgb(active));
        if let Some(input) = &menu.input {
            panel = panel
                .child(div().child("Rename pane"))
                .child(input.clone())
                .child(
                    div()
                        .id("pane-name-submit")
                        .cursor_pointer()
                        .p_1()
                        .child("Rename")
                        .on_click(cx.listener(|view, _, window, cx| {
                            view.send_pane_action(true, window, cx)
                        })),
                );
        } else {
            for (rename, label) in [
                (true, "Rename"),
                (
                    false,
                    if menu.target.actions.zoomed {
                        "Restore"
                    } else {
                        "Zoom"
                    },
                ),
            ] {
                panel = panel.child(
                    div()
                        .id(if rename {
                            "pane-action-rename"
                        } else {
                            "pane-action-zoom"
                        })
                        .min_h(px(crate::config::Config::default().ui.line_height() + 12.))
                        .px_2()
                        .flex()
                        .items_center()
                        .cursor_pointer()
                        .hover(move |row| row.bg(rgb(active)))
                        .child(label)
                        .on_click(cx.listener(move |view, _, window, cx| {
                            if rename {
                                view.edit_pane_name(window, cx)
                            } else {
                                view.send_pane_action(false, window, cx)
                            }
                        })),
                );
            }
        }
        Some(
            panel
                .children(menu.error.map(|error| div().child(error)))
                .child(
                    div()
                        .id("pane-actions-cancel")
                        .cursor_pointer()
                        .p_1()
                        .child("Cancel")
                        .on_click(
                            cx.listener(|view, _, window, cx| view.close_pane_actions(window, cx)),
                        ),
                )
                .into_any_element(),
        )
    }
}
#[cfg(test)]
mod tests;
