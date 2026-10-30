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
        let theme = self.theme();
        let palette = super::design::palette(&theme);
        let ink = super::pane_chrome::header_ink(&theme);
        let hover = palette.element_hover;
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
            row = row.child({
                use bezel_ui::widgets::Buttons as _;
                palette
                    .icon_button(
                        bezel_ui::icons::Icon::asset(icon),
                        bezel_ui::widgets::ButtonStyle::Ghost,
                        None,
                    )
                    .id(name)
                    .role(Role::Button)
                    .aria_label(label)
                    .debug_selector(move || name.into())
                    .h(px(26.))
                    .tooltip(move |window, cx| {
                        if action == BrowserAction::Reload {
                            bezel_ui::tooltip::Tooltip::with_keystroke(label, "⌘R", window, cx)
                        } else {
                            bezel_ui::tooltip::Tooltip::text(label, window, cx)
                        }
                    })
                    .when(pressed, |b| b.bg(palette.element_active))
                    .when(!available, |b| b.cursor_default())
                    .when(available, |b| {
                        b.hover(move |s| s.bg(hover)).on_click(cx.listener(
                            move |view, _, _, cx| {
                                cx.stop_propagation();
                                view.send_browser(&pane, command.clone(), cx);
                            },
                        ))
                    })
                    .opacity(if available || pressed { 1. } else { 0.35 })
            });
        }
        let pane = pane.to_owned();
        Some(
            row.child({
                use bezel_ui::widgets::Buttons as _;
                palette
                    .ghost("browser-address")
                    .role(Role::Button)
                    .aria_label("Edit browser address")
                    .tooltip(|window, cx| {
                        bezel_ui::tooltip::Tooltip::with_keystroke(
                            "Edit browser address",
                            "⌘L",
                            window,
                            cx,
                        )
                    })
                    .debug_selector(|| "browser-address".into())
                    .flex_1()
                    .min_w_0()
                    .px(px(bezel_theme::Theme::SPACE / 2.))
                    .when(mark == Some(Mark::Stale), |address| {
                        address.text_color(ink.muted)
                    })
                    .child(
                        div()
                            .min_w_0()
                            .truncate()
                            .child(state.url.clone())
                            .children(super::design::ink_probe({
                                let pane = pane.clone();
                                move || format!("browser-address:{pane}")
                            })),
                    )
                    .when(!ready, |address| address.cursor_default())
                    .when(ready, |address| {
                        address.on_click(cx.listener(move |view, _, window, cx| {
                            cx.stop_propagation();
                            view.open_browser_address(pane.clone(), window, cx);
                        }))
                    })
            })
            .when(matches!(mark, Some(Mark::Rejected(_))), |row| {
                use bezel_theme::Typeset as _;
                row.child(
                    div()
                        .flex_shrink_0()
                        .text_style(bezel_theme::TextStyle::Caption)
                        .text_color(ink.warning)
                        .child(REJECTED)
                        .children(super::design::ink_probe(|| "browser-rejected".into())),
                )
            })
            .into_any_element(),
        )
    }
    pub(super) fn browser_address_panel(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let address = self.browser_address.as_ref()?;
        let theme = self.theme();
        let palette = super::design::palette(&theme);
        let muted = super::design::dialog_muted(&theme);
        // The keycap's own wash lightens a dark card by enough to cost the
        // muted ink its 4.5:1 (Amber, 4.11), so the cap's text is inked on it too.
        let card = Hsla {
            a: 1.,
            ..palette.surface_dialog
        };
        let pack = |c: Hsla| u32::from(Rgba::from(c)) >> 8;
        let cap_plate = pack(bezel_theme::flatten(bezel_theme::ink(0.05), card));
        let cap: Hsla = rgb(crate::contrast::ink_on_chrome(
            pack(muted),
            [pack(card), cap_plate, cap_plate],
            4.6,
        ))
        .into();
        let space = px(bezel_theme::Theme::SPACE);
        Some(
            bezel_ui::popover::dialog_card(&palette)
                .id("browser-address-dialog")
                .role(Role::Dialog)
                .aria_label("Browser address")
                .absolute()
                .bottom(relative(1.))
                .left_0()
                .w(px(480.))
                .p(space)
                .gap(space)
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
                        .flex()
                        .items_center()
                        .gap(space)
                        .child(key_hint(&palette, (cap, muted), "return", "Open"))
                        .child(key_hint(&palette, (cap, muted), "esc", "Cancel")),
                )
                .into_any_element(),
        )
    }
}
/// Bezel's `key_hint_text` (a keycap and its verb) inked on the dialog card;
/// Bezel paints the verb at 45% of muted, under 4.5:1 on every preset.
fn key_hint(
    palette: &bezel_theme::Theme,
    (cap_ink, muted): (Hsla, Hsla),
    cap: &'static str,
    label: &'static str,
) -> Div {
    use bezel_theme::Typeset as _;
    div()
        .flex()
        .items_center()
        .gap(px(bezel_theme::Theme::SPACE / 2.))
        .child(
            bezel_ui::popover::key_cap(palette)
                .text_style(bezel_theme::TextStyle::Subheadline)
                .font_family(palette.font_mono.clone())
                .text_color(cap_ink)
                .child(cap)
                .children(super::design::ink_probe(move || {
                    format!("browser-address-cap-{cap}")
                })),
        )
        .child(
            div()
                .text_style(bezel_theme::TextStyle::Caption)
                .text_color(muted)
                .child(label)
                .children(super::design::ink_probe(move || {
                    format!("browser-address-hint-{label}")
                })),
        )
}
#[cfg(test)]
#[path = "browser_toolbar_tests.rs"]
mod tests;
