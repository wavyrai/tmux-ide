//! Native browser chrome. All IO belongs to the scoped background broker.
use super::{SnapshotView, browser};
use crate::search_input::SearchInput;
use gpui::{prelude::*, *};
use herdr_client::tmux_daemon::{BrowserAction, BrowserCommand, BrowserState};
pub(super) struct Address {
    request: u64,
    pane: String,
    instance: String,
    tab: u64,
    input: Entity<SearchInput>,
}
impl SnapshotView {
    pub(super) fn browser_shortcut_key(
        &mut self,
        event: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        let modifiers = event.keystroke.modifiers;
        if !modifiers.platform
            || modifiers.alt
            || modifiers.control
            || modifiers.shift
            || !matches!(event.keystroke.key.as_str(), "l" | "r")
            || self.browser_address.is_some()
            || self.picker.is_some()
            || self.new_session.is_some()
            || self.pane_actions.is_some()
            || !self.marked.is_empty()
            || !self.terminal_focus.is_focused(window)
        {
            return false;
        }
        let Some(pane) = self.browser_state.selected_pane.clone() else {
            return false;
        };
        let Some(state) = self.current_browser(&pane) else {
            return false;
        };
        let command = BrowserCommand::new(state, BrowserAction::Reload, None);
        cx.stop_propagation();
        window.prevent_default();
        if !event.is_held {
            if event.keystroke.key == "l" {
                self.open_browser_address(pane, window, cx);
            } else {
                self.send_browser(&pane, command, cx);
            }
        }
        true
    }
    fn current_browser(&self, pane: &str) -> Option<&BrowserState> {
        let state = self.browser_state.browser_controls.get(pane)?;
        (self.browser_state.browser_pane_visible(pane)
            && self.browser_request == self.browser_state.request
            && self.presence.ready()
            && self.browser_state.input_ready
            && !self.browser_state.retained_preview
            && state.enabled)
            .then_some(state)
    }
    fn send_browser(&mut self, pane: &str, command: BrowserCommand, cx: &mut Context<Self>) {
        let Some(state) = self.current_browser(pane) else {
            return;
        };
        if command.instance != state.instance
            || command.revision != state.revision
            || command.tab != state.tab
            || !command.valid()
        {
            return;
        }
        if let Some(sender) = &self.browser_commands {
            let _ = sender.try_send(browser::Command::BrowserControls {
                request: self.browser_request,
                id: pane.into(),
                command: Some(command),
            });
        }
        // No optimistic URL/history changes; wait for a fresh browser observation.
        self.browser_state.browser_controls.remove(pane);
        cx.notify();
    }
    fn open_browser_address(&mut self, pane: String, window: &mut Window, cx: &mut Context<Self>) {
        let Some(state) = self.current_browser(&pane).cloned() else {
            return;
        };
        self.discard_composition(cx);
        let theme = self.theme();
        let input = cx.new(|cx| {
            let mut input = SearchInput::new(cx).with_max_bytes(16384);
            input.set_placeholder("URL or search", cx);
            input.set_appearance(crate::config::Config::default().ui, theme, cx);
            input.set_text_selected(&state.url, cx);
            input
        });
        input.read(cx).focus.clone().focus(window, cx);
        self.browser_address = Some(Address {
            request: self.browser_request,
            pane,
            instance: state.instance,
            tab: state.tab,
            input,
        });
        cx.notify();
    }
    fn finish_browser_address(
        &mut self,
        submit: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(address) = self.browser_address.take() else {
            return;
        };
        if submit
            && !address.input.read(cx).is_composing()
            && address.request == self.browser_request
            && let Some(state) = self
                .current_browser(&address.pane)
                .filter(|s| s.instance == address.instance && s.tab == address.tab)
        {
            let command = BrowserCommand::new(
                state,
                BrowserAction::Navigate,
                Some(address.input.read(cx).text().to_owned()),
            );
            self.send_browser(&address.pane, command, cx);
        }
        self.terminal_focus.focus(window, cx);
        cx.notify();
    }
    pub(super) fn browser_header(&self, pane: &str, cx: &mut Context<Self>) -> Option<AnyElement> {
        let state = self.current_browser(pane)?;
        let mut row = div().flex().items_center().gap_1().flex_1().min_w_0();
        for (name, label, action, available) in [
            (
                "browser-back",
                "Back",
                BrowserAction::Back,
                state.can_go_back,
            ),
            (
                "browser-forward",
                "Forward",
                BrowserAction::Forward,
                state.can_go_forward,
            ),
            (
                "browser-reload",
                if state.loading { "Stop" } else { "Reload" },
                if state.loading {
                    BrowserAction::Stop
                } else {
                    BrowserAction::Reload
                },
                true,
            ),
        ] {
            let command = BrowserCommand::new(state, action, None);
            let pane = pane.to_owned();
            let icon = match action {
                BrowserAction::Back => "icons/arrow-left.svg",
                BrowserAction::Forward => "icons/arrow-right.svg",
                BrowserAction::Stop => "icons/close.svg",
                _ => "icons/refresh.svg",
            };
            row = row.child(
                div()
                    .id(name)
                    .role(Role::Button)
                    .aria_label(label)
                    .w(px(24.))
                    .h(px(26.))
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded(px(4.))
                    .when(available, |b| {
                        b.cursor_pointer()
                            .on_click(cx.listener(move |view, _, _, cx| {
                                cx.stop_propagation();
                                view.send_browser(&pane, command.clone(), cx);
                            }))
                    })
                    .opacity(if available { 1. } else { 0.35 })
                    .child(
                        svg()
                            .path(icon)
                            .size(px(14.))
                            .text_color(super::design::palette(&self.theme()).text),
                    ),
            );
        }
        let pane = pane.to_owned();
        Some(
            row.child(
                div()
                    .id("browser-address")
                    .role(Role::Button)
                    .aria_label("Edit browser address")
                    .flex_1()
                    .min_w_0()
                    .truncate()
                    .cursor_pointer()
                    .child(state.url.clone())
                    .on_click(cx.listener(move |view, _, window, cx| {
                        cx.stop_propagation();
                        view.open_browser_address(pane.clone(), window, cx);
                    })),
            )
            .into_any_element(),
        )
    }
    pub(super) fn browser_address_panel(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let address = self.browser_address.as_ref()?;
        let palette = super::design::palette(&self.theme());
        Some(
            bezel_ui::popover::dialog_card(&palette)
                .id("browser-address-dialog")
                .role(Role::Dialog)
                .aria_label("Browser address")
                .absolute()
                .bottom(relative(1.))
                .left_0()
                .w(px(480.))
                .p_2()
                .gap_2()
                .occlude()
                .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                .on_key_down(cx.listener(|view, event: &KeyDownEvent, window, cx| {
                    match event.keystroke.key.as_str() {
                        "escape" => view.finish_browser_address(false, window, cx),
                        "enter" => {
                            if view
                                .browser_address
                                .as_ref()
                                .is_some_and(|a| a.input.read(cx).is_composing())
                            {
                                return;
                            }
                            view.finish_browser_address(true, window, cx);
                        }
                        _ => return,
                    }
                    cx.stop_propagation();
                    window.prevent_default();
                }))
                .child(bezel_ui::popover::dialog_title(&palette, "URL or search"))
                .child(address.input.clone())
                .child(
                    div()
                        .text_size(px(11.))
                        .child("Enter to open · Esc to cancel"),
                )
                .into_any_element(),
        )
    }
}
