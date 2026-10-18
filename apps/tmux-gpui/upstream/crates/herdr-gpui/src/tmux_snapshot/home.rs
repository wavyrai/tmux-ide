//! Catalog-backed Home. No daemon queries or invented activity in the render path.
use super::{SnapshotView, browser, browser_ui::Selection, controls as native_controls};
use gpui::{prelude::*, *};
mod action_focus;
pub(super) mod filters;
mod fleet;
pub(super) mod machine_filter;
mod preferences;
pub(super) mod recovery;
mod selection;

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
fn status_message(state: &browser::State, connected: bool) -> String {
    if connected && let Some(setup) = &state.local_setup {
        return setup.phase.guidance().into();
    }
    crate::notifications::safe_text(&state.status, 240)
}
fn summary(state: &browser::State, connected: bool) -> String {
    if connected && let Some(fleet) = &state.fleet {
        let sessions = fleet
            .groups
            .iter()
            .flat_map(|g| &g.sessions)
            .filter(|s| s.selection.is_some())
            .count();
        return format!(
            "{} machines · {sessions} available sessions",
            fleet.groups.len()
        );
    }
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
    fn home_action_current(&self, request: u64) -> bool {
        self.browser_state.surface == browser::Surface::Home
            && self.browser_commands.is_some()
            && self.browser_request == request
            && self.picker.is_none()
            && self.new_session.is_none()
            && self.pane_actions.is_none()
    }
    fn home_refresh(&mut self, request: u64, window: &mut Window, cx: &mut Context<Self>) {
        if !self.home_action_current(request) {
            return;
        }
        if let Some(setup) = &self.browser_state.local_setup {
            if setup.phase == browser::local_setup::Phase::Running {
                return;
            }
            if setup.phase.actionable() {
                if !self.marked.is_empty()
                    || !self.presence.ready()
                    || self.browser_state.request != request
                {
                    return;
                }
                if self.browser_commands.as_ref().is_some_and(|sender| {
                    sender
                        .try_send(browser::Command::LocalSetup { request })
                        .is_ok()
                }) {
                    self.browser_state.local_setup = Some(browser::local_setup::Setup {
                        phase: browser::local_setup::Phase::Running,
                    });
                } else {
                    self.browser_state.local_setup = Some(browser::local_setup::Setup {
                        phase: browser::local_setup::Phase::Failed,
                    });
                    self.browser_state.status =
                        "Local setup request could not be sent. Try again.".into();
                }
                cx.notify();
                return;
            }
        }
        self.select(Selection::Refresh, window, cx);
    }
    pub(super) fn home_render(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        self.refresh_new_session(cx);
        self.prepare_home_filter(cx);
        if self.browser_state.appearance.is_none()
            && self.home_action_current(self.browser_request)
            && self.home_action_index(window) == Some(1)
        {
            self.terminal_focus.focus(window, cx);
        }
        self.reconcile_home_selection(cx);
        if let Some(controls) = &mut self.home_filter {
            controls.rendered_revision =
                self.browser_state.home_agents.as_ref().map(|r| r.revision);
        }
        let theme = self.theme();
        let request = self.browser_request;
        let connected = self.browser_commands.is_some();
        let setup_phase = self
            .browser_state
            .local_setup
            .as_ref()
            .map(|setup| setup.phase);
        let refresh_label = setup_phase.map_or("Refresh sessions", |phase| phase.label());
        let setup_running = setup_phase == Some(browser::local_setup::Phase::Running);
        let theme_ready = self.browser_state.appearance.is_some();
        let is_live = live(&self.browser_state, connected)
            || (connected
                && self.browser_state.fleet.as_ref().is_some_and(|f| {
                    f.groups
                        .iter()
                        .any(|g| g.state == browser::fleet::Phase::Ready)
                }));
        // Reuse Herdr window/reconnecting.rs's bounded, rounded surface card
        // and sidebar/row.rs's label renderer; only the actions/data differ.
        let mut body = div()
            .id("tmux-home-content")
            .min_w_0()
            .w_full()
            .max_w(px(1280.))
            .when(!self.glass.is_active(), |body| body.bg(rgb(self.canvas())))
            .text_color(rgb(theme.foreground))
            .text_size(px(13.))
            .p(px(24.))
            .child(
                div()
                    .text_size(px(22.))
                    .font_weight(FontWeight::SEMIBOLD)
                    .child("tmux-ide"),
            )
            .child(
                div()
                    .mt_2()
                    .text_color(rgb(theme.muted))
                    .child(summary(&self.browser_state, connected)),
            );
        if (connected && setup_phase.is_some())
            || (!is_live && !self.browser_state.status.is_empty())
        {
            body = body.child(
                div()
                    .mt_2()
                    .text_color(rgb(theme.muted))
                    .child(status_message(&self.browser_state, connected)),
            );
        }
        if self.home_diagnostics_available() {
            body = body.child(
                native_controls::button(
                    "home-copy-diagnostics",
                    Some("Copy diagnostics"),
                    "Copy safe error details",
                    native_controls::Icon::Copy,
                    &theme,
                )
                .when_some(self.home_filter.as_ref(), |control, filter| {
                    action_focus::focus_control(
                        control,
                        &filter.actions[4],
                        4,
                        theme.foreground,
                        self.canvas(),
                    )
                })
                .on_click(cx.listener(move |view, _, window, cx| {
                    cx.stop_propagation();
                    view.home_copy_diagnostics(request, window, cx);
                })),
            );
        }
        if connected {
            let action_focus = self
                .home_filter
                .as_ref()
                .map(|controls| controls.actions.clone());
            body = body.child(
                div()
                    .mt_4()
                    .tab_group()
                    .flex()
                    .flex_wrap()
                    .gap_2()
                    .child(
                        native_controls::action_button(
                            "home-browse",
                            Some("Browse sessions"),
                            "Browse sessions (⌘K)",
                            native_controls::Icon::Sessions,
                            native_controls::ButtonStyle::Primary,
                            &theme,
                        )
                        .when_some(action_focus.as_ref(), |control, focus| {
                            action_focus::focus_control(
                                control,
                                &focus[0],
                                0,
                                theme.ink(theme.primary()),
                                theme.active,
                            )
                        })
                        .on_click(cx.listener(
                            move |view, _, window, cx| {
                                if view.home_action_current(request) {
                                    view.open_picker(window, cx);
                                }
                            },
                        )),
                    )
                    .child(
                        native_controls::action_button(
                            "home-theme",
                            Some("Theme…"),
                            "Choose a theme",
                            native_controls::Icon::Theme,
                            if theme_ready {
                                native_controls::ButtonStyle::Quiet
                            } else {
                                native_controls::ButtonStyle::Unavailable
                            },
                            &theme,
                        )
                        .when(!theme_ready, |control| {
                            control.aria_description("Appearance settings are not available yet")
                        })
                        .when(theme_ready, |control| {
                            control
                                .when_some(action_focus.as_ref(), |control, focus| {
                                    action_focus::focus_control(
                                        control,
                                        &focus[1],
                                        1,
                                        theme.ink(theme.primary()),
                                        self.canvas(),
                                    )
                                })
                                .on_click(cx.listener(move |view, _, window, cx| {
                                    if view.home_action_current(request) {
                                        view.open_theme_picker(window, cx);
                                    }
                                }))
                        }),
                    )
                    .child(
                        native_controls::action_button(
                            "tmux-home-refresh",
                            Some(refresh_label),
                            refresh_label,
                            native_controls::Icon::Refresh,
                            if setup_running {
                                native_controls::ButtonStyle::Unavailable
                            } else {
                                native_controls::ButtonStyle::Quiet
                            },
                            &theme,
                        )
                        .when_some(action_focus.as_ref(), |control, focus| {
                            action_focus::focus_control(
                                control,
                                &focus[2],
                                2,
                                theme.ink(theme.primary()),
                                self.canvas(),
                            )
                        })
                        .on_click(cx.listener(
                            move |this, _, window, cx| {
                                cx.stop_propagation();
                                this.home_refresh(request, window, cx);
                            },
                        )),
                    ),
            );
        }
        let mut fleet_column = div()
            .debug_selector(|| "home-fleet-column".into())
            .min_w_0()
            .flex_1()
            .child(div().flex().items_center().justify_between().gap_2()
                .child(div().text_size(px(14.)).font_weight(FontWeight::SEMIBOLD).child("Your fleet"))
                .child(self.local_session_action(cx).when(self.local_session_available(), |control| {
                control.when_some(self.home_filter.as_ref(), |control, filters| {
                    action_focus::focus_control(control, &filters.actions[3], 3, theme.foreground, self.canvas())
                })
            })))
            .when(setup_phase.is_none() && !self.local_session_available() && self.new_session.is_none(), |column| column.child(
                div().mt_2().text_sm().text_color(rgb(theme.muted))
                    .child("Connect to a local tmux server below. If none is running, start tmux in Terminal first.")))
            .child(self.new_session_controls(cx));
        if let Some(cards) = self.fleet_cards(cx) {
            fleet_column = fleet_column.child(cards);
        } else if is_live && !self.browser_state.sessions.is_empty() {
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
            fleet_column =
                fleet_column.child(div().mt_4().flex().flex_col().gap_2().children(cards));
        } else if !connected || setup_phase.is_none() {
            let guidance = if !connected {
                "Restart the native preview to reconnect."
            } else if self.browser_state.home_phase == browser::HomePhase::Unavailable {
                "The daemon could not list sessions. Refresh to try again."
            } else if self.browser_state.home_phase == browser::HomePhase::Loading {
                "Waiting for the daemon’s session catalog."
            } else {
                "Start a new local session, or select a fleet server to create a session there."
            };
            fleet_column = fleet_column.child(
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
        let wide = window.viewport_size().width >= px(1060.);
        body = body.child(
            div()
                .mt_4()
                .w_full()
                .min_w_0()
                .flex()
                .gap_6()
                .when(!wide, |columns| columns.flex_col())
                .child(fleet_column)
                .child(
                    div()
                        .debug_selector(|| "home-agents-column".into())
                        .min_w_0()
                        .flex_1()
                        .children(self.home_agent_rows(cx)),
                ),
        );
        div()
            .id("tmux-home")
            .debug_selector(|| "tmux-home".into())
            .track_focus(&self.terminal_focus)
            .flex_1()
            .min_w_0()
            .h_full()
            .overflow_y_scroll()
            .when_some(self.home_filter.as_ref(), |element, controls| {
                element.track_scroll(&controls.page_scroll)
            })
            .flex()
            .flex_col()
            .items_center()
            .when(!self.glass.is_active(), |body| body.bg(rgb(self.canvas())))
            .child(body)
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
