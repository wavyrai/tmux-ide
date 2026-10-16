//! Adapt Herdr pane_menu's captured target and rename editor, without its RPC.
use super::{SnapshotView, browser};
use crate::search_input::SearchInput;
use gpui::{prelude::*, *};
use serde::Serialize;

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum Harness {
    Claude,
    Codex,
}
#[derive(Serialize)]
#[serde(tag = "action", rename_all = "lowercase")]
pub(super) enum Action {
    #[serde(rename = "new-window")]
    NewWindow,
    Close,
    #[serde(rename = "new-agent")]
    NewAgent {
        name: String,
        harness: Harness,
    },
    Rename {
        name: String,
    },
    Zoom {
        desired: Zoom,
    },
    Split {
        direction: SplitDirection,
    },
}
#[derive(Serialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum Zoom {
    Zoomed,
    Unzoomed,
}
#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum SplitDirection {
    Right,
    Down,
}
#[derive(Clone, PartialEq, Eq)]
pub(super) struct Target {
    request: u64,
    session: String,
    actions: browser::PaneActions,
}
impl Target {
    pub(super) fn capture(state: &browser::State) -> Option<Self> {
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
    pub(super) fn current(&self, state: &browser::State) -> bool {
        Self::capture(state).is_some_and(|now| {
            now.request == self.request
                && now.session == self.session
                && now.actions == self.actions
        })
    }
}
impl std::fmt::Debug for Target {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PaneActionTarget")
            .field("request", &self.request)
            .finish_non_exhaustive()
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
    pub(super) fn open_pane_actions(&mut self, window: &mut Window, cx: &mut Context<Self>) {
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
        self.cancel_attention();
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
    pub(super) fn edit_pane_name(&mut self, window: &mut Window, cx: &mut Context<Self>) {
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
        self.queue_pane_action(action, window, cx);
    }
    fn open_pane_editor(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.refresh_pane_actions(cx);
        let Some(menu) = self.pane_actions.as_ref() else {
            return;
        };
        let command = browser::Command::OpenEditor {
            request: menu.target.request,
            id: menu.target.actions.id.clone(),
            token: menu.target.actions.token.clone(),
        };
        if self
            .browser_commands
            .as_ref()
            .is_some_and(|sender| sender.try_send(command).is_ok())
        {
            // Admission only: the bridge resolves cwd and reports launch status.
            self.browser_state.pane_actions = None;
            self.close_pane_actions(window, cx);
        } else if let Some(menu) = &mut self.pane_actions {
            menu.error = Some("Action queue unavailable — cancel and reselect the pane.");
            cx.notify();
        }
    }
    fn split_pane(
        &mut self,
        direction: SplitDirection,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.queue_pane_action(Action::Split { direction }, window, cx);
    }
    fn queue_pane_action(&mut self, action: Action, window: &mut Window, cx: &mut Context<Self>) {
        self.refresh_pane_actions(cx);
        let Some(menu) = self.pane_actions.as_ref() else {
            return;
        };
        let target = menu.target.clone();
        if self.dispatch_captured_pane_action(&target, action, window, cx) {
            return;
        }
        if let Some(menu) = &mut self.pane_actions {
            menu.error = Some("Action queue unavailable — cancel and reselect the pane.");
            cx.notify();
        }
    }
    /// Shared queue admission for the pane menu and F5; never recapture a newer token.
    pub(super) fn dispatch_captured_pane_action(
        &mut self,
        target: &Target,
        action: Action,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        if self.browser_request != target.request
            || !self.presence.ready()
            || !target.current(&self.browser_state)
        {
            return false;
        }
        let command = browser::Command::PaneAction {
            request: target.request,
            id: target.actions.id.clone(),
            token: target.actions.token.clone(),
            action,
        };
        if self
            .browser_commands
            .as_ref()
            .is_none_or(|sender| sender.try_send(command).is_err())
        {
            return false;
        }
        // Admission consumes the one-use capability, not terminal input interruption.
        self.browser_state.pane_actions = None;
        self.close_pane_actions(window, cx);
        true
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
    pub(super) fn pane_actions_panel(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let menu = self.pane_actions.as_ref()?;
        let active = self.theme().active;
        let mut panel = div()
            .id("pane-actions-panel")
            .debug_selector(|| "pane-actions-panel".into())
            .absolute()
            .bottom(relative(1.))
            .left_0()
            .occlude()
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .on_scroll_wheel(|_, _, cx| cx.stop_propagation())
            .flex_none()
            .w_full()
            .max_w(px(320.))
            .max_h(px(180.))
            .overflow_y_scroll()
            .p_1()
            .bg(rgb(self.theme().surface))
            .rounded(px(crate::config::corners::PANEL))
            .border_1()
            .border_color(super::controls::separator(&self.theme()))
            .shadow_lg();
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
                        .rounded(px(crate::config::corners::CONTROL))
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
            panel = panel.child(
                div()
                    .id("pane-action-open-editor")
                    .debug_selector(|| "pane-action-open-editor".into())
                    .min_h(px(crate::config::Config::default().ui.line_height() + 12.))
                    .px_2()
                    .flex()
                    .items_center()
                    .cursor_pointer()
                    .rounded(px(crate::config::corners::CONTROL))
                    .hover(move |row| row.bg(rgb(active)))
                    .child("Open folder in VS Code")
                    .on_click(cx.listener(|view, _, window, cx| view.open_pane_editor(window, cx))),
            );
            for (direction, id, label) in [
                (
                    SplitDirection::Right,
                    "pane-action-split-right",
                    "Split pane right",
                ),
                (
                    SplitDirection::Down,
                    "pane-action-split-down",
                    "Split pane down",
                ),
            ] {
                panel = panel.child(
                    div()
                        .id(id)
                        .debug_selector(move || id.into())
                        .min_h(px(crate::config::Config::default().ui.line_height() + 12.))
                        .px_2()
                        .flex()
                        .items_center()
                        .cursor_pointer()
                        .rounded(px(crate::config::corners::CONTROL))
                        .hover(move |row| row.bg(rgb(active)))
                        .child(label)
                        .on_click(cx.listener(move |view, _, window, cx| {
                            view.split_pane(direction, window, cx)
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
