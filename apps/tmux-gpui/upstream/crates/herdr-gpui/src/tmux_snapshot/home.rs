//! Catalog-backed Home. No daemon queries or invented activity in the render path.
use super::{SnapshotView, browser, browser_ui::Selection};
use gpui::{prelude::*, *};

/// Before the first browser publication, absence of a catalog is not an empty catalog.
pub(super) fn initial_state() -> browser::State {
    browser::State {
        home_phase: browser::HomePhase::Loading,
        status: "Loading sessions…".into(),
        ..Default::default()
    }
}

fn live(state: &browser::State, connected: bool) -> bool {
    connected && state.home_phase == browser::HomePhase::Live
}
fn summary(state: &browser::State, connected: bool) -> String {
    if !connected || state.home_phase == browser::HomePhase::Unavailable {
        return "Session catalog unavailable".into();
    }
    if state.home_phase == browser::HomePhase::Loading {
        return "Loading sessions…".into();
    }
    match state.sessions.len() {
        0 => "No live sessions".into(),
        1 => "1 live session".into(),
        n => format!("{n} live sessions"),
    }
}
fn current(state: &browser::State, connected: bool, request: u64, captured: u64, id: &str) -> bool {
    state.surface == browser::Surface::Home
        && live(state, connected)
        && request == captured
        && state.sessions.iter().any(|session| session.id == id)
}

impl SnapshotView {
    fn home_select(&mut self, request: u64, id: &str, window: &mut Window, cx: &mut Context<Self>) {
        if current(
            &self.browser_state,
            self.browser_commands.is_some(),
            self.browser_request,
            request,
            id,
        ) {
            self.select(Selection::Session(id.into()), window, cx);
        }
    }
    fn home_refresh(&mut self, request: u64, window: &mut Window, cx: &mut Context<Self>) {
        if self.browser_state.surface == browser::Surface::Home
            && self.browser_commands.is_some()
            && self.browser_request == request
        {
            self.select(Selection::Refresh, window, cx);
        }
    }
    pub(super) fn home_render(
        &mut self,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        self.refresh_new_session(cx);
        let theme = self.theme();
        let request = self.browser_request;
        let connected = self.browser_commands.is_some();
        let is_live = live(&self.browser_state, connected);
        // Reuse Herdr window/reconnecting.rs's bounded, rounded surface card
        // and sidebar/row.rs's label renderer; only the actions/data differ.
        let mut body = div()
            .id("tmux-home-content")
            .min_w_0()
            .w_full()
            .max_w(px(880.))
            .bg(rgb(self.canvas()))
            .text_color(rgb(theme.foreground))
            .p(px(32.))
            .child(
                div()
                    .text_xl()
                    .font_weight(FontWeight::SEMIBOLD)
                    .child("tmux-ide"),
            )
            .child(
                div()
                    .mt_2()
                    .text_color(rgb(theme.muted))
                    .child(summary(&self.browser_state, connected)),
            );
        body = body.child(
            div()
                .mt_2()
                .text_color(rgb(theme.muted))
                .child("Your sessions on this machine"),
        );
        if !self.browser_state.status.is_empty() && !is_live {
            body = body.child(div().mt_2().text_color(rgb(theme.muted)).child(
                crate::notifications::safe_text(&self.browser_state.status, 240),
            ));
        }
        if connected {
            body = body.child(
                div()
                    .mt_4()
                    .flex()
                    .flex_wrap()
                    .gap_2()
                    .child(
                        div()
                            .id("home-browse")
                            .px_3()
                            .py_1()
                            .rounded(px(4.))
                            .bg(rgb(theme.active))
                            .cursor_pointer()
                            .child("Browse sessions  ⌘K")
                            .on_click(cx.listener(move |view, _, window, cx| {
                                if view.browser_request == request
                                    && view.browser_state.surface == browser::Surface::Home
                                {
                                    view.open_picker(window, cx);
                                }
                            })),
                    )
                    .child(
                        div()
                            .id("home-theme")
                            .px_3()
                            .py_1()
                            .rounded(px(4.))
                            .cursor_pointer()
                            .child("Theme…")
                            .on_click(cx.listener(move |view, _, window, cx| {
                                if view.browser_request == request
                                    && view.browser_state.surface == browser::Surface::Home
                                {
                                    view.open_theme_picker(window, cx);
                                }
                            })),
                    )
                    .child(
                        div()
                            .id("tmux-home-refresh")
                            .w(px(160.))
                            .debug_selector(|| "tmux-home-refresh".into())
                            .px_3()
                            .py_1()
                            .rounded(px(crate::config::corners::CONTROL))
                            .border_1()
                            .border_color(rgb(theme.active))
                            .cursor_pointer()
                            .hover(move |s| s.bg(rgb(theme.active)))
                            .child("Refresh sessions")
                            .on_click(cx.listener(move |this, _, window, cx| {
                                cx.stop_propagation();
                                this.home_refresh(request, window, cx);
                            })),
                    ),
            );
        }
        if is_live && !self.browser_state.sessions.is_empty() {
            let cards = self
                .browser_state
                .sessions
                .iter()
                .enumerate()
                .map(|(index, session)| {
                    let id = session.id.clone();
                    div()
                        .id(("tmux-home-session", index))
                        .debug_selector(move || format!("tmux-home-session-{index}"))
                        .min_w_0()
                        .w_full()
                        .max_w(px(640.))
                        .flex()
                        .items_center()
                        .gap_3()
                        .p_3()
                        .rounded(px(crate::config::corners::PANEL))
                        .border_1()
                        .border_color(rgb(theme.active))
                        .bg(rgb(theme.surface))
                        .cursor_pointer()
                        .hover(move |s| s.bg(rgb(theme.active)))
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .flex()
                                .flex_col()
                                .overflow_hidden()
                                .child(
                                    div()
                                        .min_w_0()
                                        .truncate()
                                        .font_weight(FontWeight::SEMIBOLD)
                                        .child(crate::sidebar::label_text(&session.label)),
                                )
                                .children(session.pane_count_label().map(|count| {
                                    div()
                                        .debug_selector(move || format!("tmux-home-count-{index}"))
                                        .min_w_0()
                                        .truncate()
                                        .text_sm()
                                        .text_color(rgb(theme.muted))
                                        .child(count)
                                })),
                        )
                        .child(div().flex_none().text_color(rgb(theme.muted)).child("Open"))
                        .on_click(cx.listener(move |this, _, window, cx| {
                            cx.stop_propagation();
                            this.home_select(request, &id, window, cx);
                        }))
                });
            body = body.child(div().mt_4().flex().flex_col().gap_2().children(cards));
        } else {
            let guidance = if !connected {
                "Restart the native preview to reconnect."
            } else if self.browser_state.home_phase == browser::HomePhase::Unavailable {
                "The daemon could not list sessions. Refresh to try again."
            } else if self.browser_state.home_phase == browser::HomePhase::Loading {
                "Waiting for the daemon’s session catalog."
            } else {
                "Create a session in your terminal with tmux new-session, then refresh here."
            };
            body = body.child(
                div()
                    .mt_4()
                    .max_w(px(640.))
                    .p_3()
                    .rounded(px(crate::config::corners::PANEL))
                    .border_1()
                    .border_color(rgb(theme.active))
                    .bg(rgb(theme.surface))
                    .child(guidance),
            );
        }
        body = body.children(self.home_agent_rows(cx));
        div()
            .id("tmux-home")
            .debug_selector(|| "tmux-home".into())
            .track_focus(&self.terminal_focus)
            .flex_1()
            .min_w_0()
            .h_full()
            .overflow_y_scroll()
            .flex()
            .flex_col()
            .items_center()
            .bg(rgb(self.canvas()))
            .child(body.child(self.new_session_controls(cx)))
            .into_any_element()
    }
}
#[cfg(test)]
#[path = "home/tests.rs"]
mod tests;

#[cfg(test)]
#[path = "home_keyboard_tests.rs"]
mod keyboard_tests;

#[path = "home/agents.rs"]
mod agents;
