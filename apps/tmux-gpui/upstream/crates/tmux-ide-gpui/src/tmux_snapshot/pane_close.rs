//! Closing a pane asks first, in a small card anchored to the pane's close
//! button, and says what ends (close-pane cards c1 and c2).
use super::{
    SnapshotView,
    browser::home_agents::{Row, Status},
    pane_actions::{Action, Target},
};
use gpui::{prelude::*, *};
use std::rc::Rc;

/// The card's width.
pub(super) const WIDTH: f32 = 300.;
/// How far the card sits from the close button.
pub(super) const GAP: f32 = 6.;
/// How far the card stays inside the window.
pub(super) const MARGIN: f32 = 8.;
/// The room below the button the card needs before it flips above.
pub(super) const FLIP_BELOW: f32 = 140.;

/// The open card: the pane it would close and what it says.
pub(super) struct Card {
    pub(super) identity: Rc<()>,
    target: Target,
    pane: String,
    title: String,
    body: Vec<Segment>,
    icon: &'static str,
    /// The focused button: 0 Cancel (the default), 1 Close pane.
    focused: usize,
    /// The card holds keyboard focus while it is open (focus trapped).
    focus: FocusHandle,
    pub(super) error: Option<&'static str>,
}

/// Where the card goes for a close button at `button` in a window of
/// `viewport`: its top-right corner 6 pt under the button, trailing edges
/// aligned, or its bottom-right 6 pt above when there is no room below.
pub(super) fn placement(button: Bounds<Pixels>, viewport: Size<Pixels>) -> (Point<Pixels>, Anchor) {
    let below = button.bottom() + px(GAP);
    if below + px(FLIP_BELOW) > viewport.height - px(MARGIN) {
        (
            point(button.right(), button.top() - px(GAP)),
            Anchor::BottomRight,
        )
    } else {
        (point(button.right(), below), Anchor::TopRight)
    }
}

impl SnapshotView {
    /// Opens the card for `target`'s pane (header button, Cmd-W, the menu
    /// bar, the palette's row).
    pub(super) fn begin_pane_close(
        &mut self,
        target: Target,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !self.presence.ready()
            || !target.current(&self.browser_state)
            || self.browser_state.request != self.browser_request
            || self.pane_close.is_some()
            || self.picker.is_some()
            || self.new_session.is_some()
            || self.pane_actions.is_some()
        {
            return;
        }
        let pane = target.pane_id().to_owned();
        let label = self
            .browser_state
            .panes
            .iter()
            .find(|p| p.id == pane)
            .map(|p| p.label.clone())
            .unwrap_or_default();
        let rows = self
            .browser_state
            .workspace_agents
            .as_ref()
            .map(|w| w.roster.rows.as_slice())
            .unwrap_or_default();
        // While the lane is paused for a drop, the roster may be old (#362):
        // claim neither working nor finished.
        let agent = agent_on(rows, &pane, self.browser_state.agents_last_known);
        let icon = agent.map_or("icons/terminal.svg", |(row, _)| {
            super::pane_chrome::agent_icon_path(row.harness.as_deref())
        });
        let body =
            body(agent.map(|(row, state)| (row.name.as_str(), row.harness.as_deref(), state)));
        let focus = cx.focus_handle();
        focus.focus(window, cx);
        self.pane_close = Some(Card {
            identity: Rc::new(()),
            target,
            pane,
            title: title(&label),
            body,
            icon,
            focused: 0,
            focus,
            error: None,
        });
        cx.notify();
    }

    pub(super) fn confirm_pane_close(
        &mut self,
        identity: &Rc<()>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(card) = &self.pane_close else {
            return;
        };
        if !Rc::ptr_eq(identity, &card.identity) {
            return;
        }
        let target = card.target.clone();
        if !self.presence.ready()
            || !target.current(&self.browser_state)
            || self.browser_state.request != self.browser_request
        {
            if let Some(card) = &mut self.pane_close {
                card.error = Some("Pane changed. Cancel and close it again.");
            }
            cx.notify();
            return;
        }
        if self.dispatch_captured_pane_action(&target, Action::Close, window, cx) {
            self.cancel_pane_close(window, cx);
        } else if let Some(card) = &mut self.pane_close {
            card.error = Some("Action queue unavailable. Cancel and select the pane again.");
            cx.notify();
        }
    }

    pub(super) fn cancel_pane_close(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.pane_close.take().is_some() {
            self.terminal_focus.focus(window, cx);
            cx.notify();
        }
    }

    /// Whether the open card has lost what it asks about: its pane left the
    /// layout, or the window no longer shows the workspace it was opened in
    /// (another session, Home, a navigation, a held or switching frame, no
    /// connection). A target that is merely stale (its one-use capability
    /// spent, input briefly not ready) keeps the card, which then says
    /// "Pane changed" if confirmed.
    fn pane_close_lost(&self) -> bool {
        let Some(card) = &self.pane_close else {
            return false;
        };
        let state = &self.browser_state;
        let (request, session) = card.target.origin();
        self.browser_commands.is_none()
            || self.browser_request != request
            || state.request != request
            || state.surface != super::browser::Surface::Workspace
            || state.selected_session.as_deref() != Some(session)
            || state.retained_preview
            || state.frame.is_none()
            || !state.panes.iter().any(|p| p.id == card.pane)
            || !state.regions.iter().any(|r| r.id == card.pane)
    }

    /// Ends the card when it has lost its pane (see `pane_close_lost`).
    /// Called where a publication is applied, so it never waits for the
    /// card to fail to draw, and again before each frame for a layout
    /// written without a publication (a window switch's retained frame).
    /// Dropping the card drops its focus handle, so nothing holds focus and
    /// that frame gives it to the terminal (browser_render's no-focus rule).
    pub(super) fn refresh_pane_close(&mut self, cx: &mut Context<Self>) {
        if self.pane_close_lost() {
            self.pane_close = None;
            cx.notify();
        }
    }

    /// The card's keys: Return activates the focused button (Cancel unless
    /// Tab moved), Escape cancels, Cmd-W again confirms, Tab and Shift-Tab
    /// move between the buttons; nothing reaches the terminal meanwhile.
    pub(super) fn pane_close_key(
        &mut self,
        event: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        cx.stop_propagation();
        window.prevent_default();
        let Some(card) = &self.pane_close else {
            return;
        };
        let identity = card.identity.clone();
        let focused = card.focused;
        let key = &event.keystroke;
        if event.is_held {
            return;
        }
        let m = &key.modifiers;
        if m.platform && !m.control && !m.alt && !m.shift && key.key == "w" {
            self.confirm_pane_close(&identity, window, cx);
            return;
        }
        if m.platform || m.control || m.alt {
            return;
        }
        match key.key.as_str() {
            "escape" => self.cancel_pane_close(window, cx),
            "enter" if focused == 1 => self.confirm_pane_close(&identity, window, cx),
            "enter" => self.cancel_pane_close(window, cx),
            "tab" => {
                if let Some(card) = &mut self.pane_close {
                    card.focused = 1 - card.focused;
                }
                cx.notify();
            }
            _ => {}
        }
    }

    /// Whether the card is open for `pane`: its close button shows pressed.
    pub(super) fn pane_close_open_for(&self, pane: &str) -> bool {
        self.pane_close.as_ref().is_some_and(|c| c.pane == pane)
    }

    /// The card, anchored to its pane's close button in window coordinates.
    pub(super) fn pane_close_card(
        &self,
        window: &Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let card = self.pane_close.as_ref()?;
        let button = self.close_button_bounds(&card.pane)?;
        let (position, corner) = placement(button, window.viewport_size());
        Some(
            deferred(
                anchored()
                    .position(position)
                    .anchor(corner)
                    .snap_to_window_with_margin(px(MARGIN))
                    .child(self.pane_close_render(card, cx)),
            )
            .with_priority(3)
            .into_any_element(),
        )
    }

    fn pane_close_render(&self, card: &Card, cx: &mut Context<Self>) -> AnyElement {
        use bezel_theme::{TextStyle, Typeset as _};
        use bezel_ui::{popover, surface::Surfaced as _};
        let theme = super::glass_ink::on_regular_glass(bezel_theme::Theme::of(cx));
        let mono: SharedString = crate::config::Config::default().terminal.family.into();
        let cancel = card.identity.clone();
        let confirm = card.identity.clone();
        let ring = theme.ring;
        let button = |id: &'static str, label: &'static str, hint: &'static str, focused: bool| {
            div()
                .id(id)
                .debug_selector(move || id.into())
                .role(Role::Button)
                .aria_label(label)
                .h(px(bezel_theme::Theme::BUTTON_HEIGHT))
                .px(px(10.))
                .flex()
                .items_center()
                .gap(px(8.))
                .rounded(px(bezel_theme::Theme::button_radius()))
                .border_1()
                .border_color(if focused { ring } else { transparent_black() })
                .cursor_pointer()
                .text_style(TextStyle::Body)
                .child(label)
                .child(
                    div()
                        .text_style(TextStyle::Subheadline)
                        .opacity(0.8)
                        .child(hint),
                )
        };
        // The words in the UI face and muted ink, a command in the terminal's
        // mono face at 12 pt and the text ink (the mockup's <code>). A text
        // run has one size, so the line flows as words that wrap.
        let ui: SharedString = crate::config::Config::default().ui.family.into();
        let body =
            div()
                .flex()
                .flex_wrap()
                .items_baseline()
                .children(words(&card.body).into_iter().map(|word| {
                    div()
                        .flex()
                        .items_baseline()
                        .children(word.into_iter().map(|(piece, code)| {
                            let run = div().whitespace_nowrap().child(piece);
                            if code {
                                run.font_family(mono.clone())
                                    .text_size(px(12.))
                                    .text_color(theme.text)
                            } else {
                                run.font_family(ui.clone()).text_color(theme.text_muted)
                            }
                        }))
                }));
        popover::popover_card(&theme)
            .id("pane-close-card")
            .debug_selector(|| "pane-close-card".into())
            .track_focus(&card.focus)
            .on_key_down(cx.listener(Self::pane_close_key))
            .role(Role::AlertDialog)
            .aria_label(card.title.clone())
            .w(px(WIDTH))
            .pt(px(14.))
            .px(px(14.))
            .pb(px(12.))
            .occlude()
            .on_mouse_down_out(
                cx.listener(|view, _, window, cx| view.cancel_pane_close(window, cx)),
            )
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .text_style(TextStyle::Body)
            .text_color(theme.text)
            .child(
                div()
                    .flex()
                    .gap(px(8.))
                    .items_start()
                    .child(
                        bezel_ui::icons::icon(bezel_ui::icons::Icon::asset(card.icon))
                            .size(px(14.))
                            .mt(px(1.))
                            .flex_none()
                            .text_color(theme.text),
                    )
                    .child(
                        div()
                            .min_w_0()
                            .font_weight(FontWeight::BOLD)
                            .child(card.title.clone()),
                    ),
            )
            .child(
                div()
                    .debug_selector(|| "pane-close-body".into())
                    .mt(px(6.))
                    .ml(px(22.))
                    .line_height(px(18.))
                    .children(super::design::text_probe(
                        || "pane-close-body".into(),
                        card.body
                            .iter()
                            .map(|s| match s {
                                Segment::Text(t) => t.as_str(),
                                Segment::Code(c) => c,
                            })
                            .collect::<String>(),
                    ))
                    .child(body),
            )
            .children(card.error.map(|error| {
                div()
                    .mt(px(6.))
                    .ml(px(22.))
                    .text_color(theme.text)
                    .child(error)
            }))
            .child(
                div()
                    .mt(px(14.))
                    .flex()
                    .justify_end()
                    .gap(px(8.))
                    .child(
                        button("pane-close-cancel", "Cancel", "esc", card.focused == 0)
                            .bg(theme.element_hover)
                            .text_color(theme.text)
                            .on_click(cx.listener(move |view, _, window, cx| {
                                if view
                                    .pane_close
                                    .as_ref()
                                    .is_some_and(|c| Rc::ptr_eq(&c.identity, &cancel))
                                {
                                    view.cancel_pane_close(window, cx);
                                }
                            })),
                    )
                    .child(
                        button(
                            "pane-close-confirm",
                            "Close pane",
                            "\u{2318}W",
                            card.focused == 1,
                        )
                        .bg(theme.danger_strong)
                        .text_color(white())
                        .font_weight(FontWeight::MEDIUM)
                        .on_click(cx.listener(
                            move |view, _, window, cx| {
                                view.confirm_pane_close(&confirm, window, cx)
                            },
                        )),
                    ),
            )
            .surface(&theme, theme.popover_surface)
            .into_any_element()
    }
}

/// A run of the card's body: plain words, or a command set in the mono face.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum Segment {
    Text(String),
    Code(&'static str),
}

/// The body as the words its line wraps between: each word is its runs
/// (text, and whether it is the mono command), its trailing space included,
/// so a command keeps the space after it and never starts a line with one.
pub(super) fn words(body: &[Segment]) -> Vec<Vec<(String, bool)>> {
    let mut words: Vec<Vec<(String, bool)>> = Vec::new();
    let mut push = |piece: &str, code: bool| {
        let open = words
            .last()
            .and_then(|w| w.last())
            .is_some_and(|(text, _)| !text.ends_with(' '));
        match words.last_mut() {
            Some(word) if open => word.push((piece.to_owned(), code)),
            _ => words.push(vec![(piece.to_owned(), code)]),
        }
    };
    for segment in body {
        match segment {
            Segment::Text(text) => text.split_inclusive(' ').for_each(|p| push(p, false)),
            Segment::Code(code) => push(code, true),
        }
    }
    words
}

/// What a pane runs, as far as the card can tell: an agent working (or
/// waiting on the user), at rest (done or idle), not reporting its state
/// (Disconnected: unknown or a stale report, so it may still be running),
/// stopped with an error, or anything else. A shell's foreground command is
/// not reported yet, so "anything else" is generic.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Agent {
    Working,
    AtRest,
    Unknown,
    Failed,
}

/// The agent on `pane`, if the workspace roster has one, and its state;
/// Unknown when `last_known` (the roster may be old).
pub(super) fn agent_on<'a>(
    rows: &'a [Row],
    pane: &str,
    last_known: bool,
) -> Option<(&'a Row, Agent)> {
    let row = rows.iter().find(|r| r.pane_id.as_deref() == Some(pane))?;
    let state = if last_known {
        Agent::Unknown
    } else if row.attention || matches!(row.status, Status::Working | Status::Blocked) {
        Agent::Working
    } else {
        match row.status {
            Status::Disconnected => Agent::Unknown,
            Status::Failed => Agent::Failed,
            _ => Agent::AtRest,
        }
    };
    Some((row, state))
}

/// The card's body line (c2): what closing ends, and for an agent how to
/// pick its conversation back up.
pub(super) fn body(agent: Option<(&str, Option<&str>, Agent)>) -> Vec<Segment> {
    let text = |s: String| Segment::Text(s);
    let Some((name, harness, state)) = agent else {
        return vec![text("The shell and anything running in it end.".into())];
    };
    let resume = super::agent_resume::resume_command(harness);
    match (state, resume) {
        (Agent::Working, Some(command)) => vec![
            text(format!(
                "{name} is working on this. Closing stops it mid-turn. The conversation is saved; "
            )),
            Segment::Code(command),
            text(" in a new pane picks it up.".into()),
        ],
        (Agent::Working, None) => vec![text(format!(
            "{name} is working on this. The agent stops mid-turn."
        ))],
        (Agent::AtRest, Some(command)) => vec![
            text(format!(
                "{name} has finished. Closing ends the agent; the conversation is saved, and "
            )),
            Segment::Code(command),
            text(" in a new pane picks it up.".into()),
        ],
        (Agent::AtRest, None) => vec![text(format!(
            "{name} has finished. Closing ends the agent."
        ))],
        (Agent::Unknown, Some(command)) => vec![
            text(format!(
                "{name} isn't reporting its state, so it may still be running. Closing stops it if it is. The conversation is saved; "
            )),
            Segment::Code(command),
            text(" in a new pane picks it up.".into()),
        ],
        (Agent::Unknown, None) => vec![text(format!(
            "{name} isn't reporting its state, so it may still be running. Closing stops it if it is."
        ))],
        (Agent::Failed, Some(command)) => vec![
            text(format!(
                "{name} stopped with an error. Closing ends the agent; the conversation is saved, and "
            )),
            Segment::Code(command),
            text(" in a new pane picks it up.".into()),
        ],
        (Agent::Failed, None) => vec![text(format!(
            "{name} stopped with an error. Closing ends the agent."
        ))],
    }
}

/// The card's title: the pane's own label, quoted.
pub(super) fn title(label: &str) -> String {
    format!("Close “{label}”?")
}

#[cfg(test)]
#[path = "pane_close_tests.rs"]
mod tests;
