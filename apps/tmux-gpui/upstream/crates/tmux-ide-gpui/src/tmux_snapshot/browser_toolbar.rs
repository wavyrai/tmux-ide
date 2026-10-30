//! Native browser chrome. All IO belongs to the scoped background broker.
use super::{SnapshotView, browser};
use crate::search_input::SearchInput;
use gpui::{prelude::*, *};
use herdr_client::tmux_daemon::{BrowserAction, BrowserCommand, BrowserState};
use std::time::{Duration, Instant};
/// A click stays pending at most this long without a confirming observation.
pub(super) const PENDING_TTL: Duration = Duration::from_secs(3);
pub(super) const REJECTED: &str = "Page changed — try again";
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Mark {
    /// The last read failed; the controls shown are the last good observation.
    Stale,
    /// A click could not be applied to the current page; the number orders rejections.
    Rejected(u64),
}
#[derive(Clone)]
pub(super) struct Pending {
    pub pane: String,
    pub action: BrowserAction,
    pub basis: BrowserState,
    /// The worker mark seen when clicking; only a newer mark settles the click.
    pub mark: Option<Mark>,
    pub at: Instant,
}
impl Pending {
    /// Pending lasts until the observation it was sent against changes or is marked.
    pub(super) fn carried(self, next: &browser::State) -> Option<Self> {
        (self.at.elapsed() < PENDING_TTL
            && next.browser_controls.get(&self.pane) == Some(&self.basis)
            && next
                .browser_marks
                .get(&self.pane)
                .is_none_or(|mark| Some(*mark) == self.mark))
        .then_some(self)
    }
}
/// Re-targets a command to a newer observation of the same page, if it still means
/// what the user clicked: same tab, URL and loading phase, and the action is offered.
pub(super) fn rebase(
    command: &BrowserCommand,
    basis: &BrowserState,
    fresh: &BrowserState,
) -> Option<BrowserCommand> {
    let offered = match command.action {
        BrowserAction::Back => fresh.can_go_back,
        BrowserAction::Forward => fresh.can_go_forward,
        BrowserAction::Reload | BrowserAction::Stop | BrowserAction::Navigate => true,
    };
    (offered
        && fresh.enabled
        && fresh.instance == command.instance
        && fresh.pane == command.pane
        && fresh.tab == command.tab
        && fresh.url == basis.url
        && fresh.loading == basis.loading)
        .then(|| BrowserCommand {
            revision: fresh.revision,
            ..command.clone()
        })
}
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
        if event.keystroke.key == "r" && self.pending_browser(&pane).is_some() {
            return false;
        }
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
    fn observed_browser(&self, pane: &str) -> Option<&BrowserState> {
        let state = self.browser_state.browser_controls.get(pane)?;
        (self.browser_state.browser_pane_visible(pane)
            && self.browser_request == self.browser_state.request
            && !self.browser_state.retained_preview)
            .then_some(state)
    }
    fn current_browser(&self, pane: &str) -> Option<&BrowserState> {
        let state = self.observed_browser(pane)?;
        (self.presence.ready()
            && self.browser_state.input_ready
            && state.enabled
            && self.browser_state.browser_marks.get(pane) != Some(&Mark::Stale))
        .then_some(state)
    }
    fn pending_browser(&self, pane: &str) -> Option<BrowserAction> {
        self.browser_state
            .browser_pending
            .clone()
            .and_then(|p| p.carried(&self.browser_state))
            .filter(|p| p.pane == pane)
            .map(|p| p.action)
    }
    fn send_browser(&mut self, pane: &str, command: BrowserCommand, cx: &mut Context<Self>) {
        let Some(state) = self.current_browser(pane) else {
            return;
        };
        // An older revision is forwarded: the worker re-targets it or reports it, never drops it.
        if self.pending_browser(pane).is_some()
            || command.instance != state.instance
            || command.tab != state.tab
            || !command.valid()
        {
            return;
        }
        let basis = state.clone();
        let action = command.action;
        let sent = self.browser_commands.as_ref().is_some_and(|sender| {
            sender
                .try_send(browser::Command::BrowserControls {
                    request: self.browser_request,
                    id: pane.into(),
                    command: Some(command),
                })
                .is_ok()
        });
        if sent {
            // No optimistic URL/history changes: keep the observed controls, marked pending.
            let mark = self.browser_state.browser_marks.remove(pane);
            self.browser_state.browser_pending = Some(Pending {
                pane: pane.into(),
                action,
                basis,
                mark,
                at: Instant::now(),
            });
        }
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
        // Observation owns the layout; input authority only enables its actions.
        let state = self.observed_browser(pane)?;
        let ready = self.current_browser(pane).is_some();
        let pending = self.pending_browser(pane);
        let mark = self.browser_state.browser_marks.get(pane).copied();
        let palette = super::design::palette(&self.theme());
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
            let pressed = pending == Some(action);
            let available = ready && available && pending.is_none();
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
                    .when(pressed, |b| b.bg(palette.element_active))
                    .when(available, |b| {
                        b.cursor_pointer()
                            .on_click(cx.listener(move |view, _, _, cx| {
                                cx.stop_propagation();
                                view.send_browser(&pane, command.clone(), cx);
                            }))
                    })
                    .opacity(if available || pressed { 1. } else { 0.35 })
                    .child(svg().path(icon).size(px(14.)).text_color(palette.text)),
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
                    .when(mark == Some(Mark::Stale), |address| {
                        address.text_color(palette.text_muted)
                    })
                    .child(state.url.clone())
                    .when(ready, |address| {
                        address.cursor_pointer().on_click(cx.listener(
                            move |view, _, window, cx| {
                                cx.stop_propagation();
                                view.open_browser_address(pane.clone(), window, cx);
                            },
                        ))
                    }),
            )
            .when(matches!(mark, Some(Mark::Rejected(_))), |row| {
                row.child(
                    div()
                        .flex_shrink_0()
                        .text_color(palette.text_muted)
                        .child(REJECTED),
                )
            })
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
#[cfg(test)]
#[path = "browser_toolbar_tests.rs"]
mod tests;
