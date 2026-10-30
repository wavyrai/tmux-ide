use super::*;
use bezel_ui::widgets::{Content, Scaffolding};

// Follow Herdr sidebar/row.rs and row/configured.rs's visual hierarchy:
// labels flex and truncate; marks and trailing state keep their width.
// This is local composition using existing assets, not imported row ownership.
fn fleet_mark(path: &'static str, color: Hsla) -> Svg {
    svg()
        .path(path)
        .size(px(16.))
        .flex_shrink_0()
        .text_color(color)
}

impl SnapshotView {
    pub(in crate::tmux_snapshot) fn open_fleet_server(
        &mut self,
        request: u64,
        token: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.browser_commands.is_none()
            || request != self.browser_request
            || !self.presence.ready()
            || self.browser_state.request != request
            || self
                .browser_state
                .fleet
                .as_ref()
                .is_none_or(|f| f.server(token).is_none())
        {
            return;
        }
        self.select(Selection::FleetServer(token.into()), window, cx);
    }

    pub(in crate::tmux_snapshot) fn open_fleet_session(
        &mut self,
        request: u64,
        token: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.browser_commands.is_none()
            || request != self.browser_request
            || !self.presence.ready()
            || self.browser_state.request != request
        {
            return;
        }
        let Some(session) = self
            .browser_state
            .fleet
            .as_ref()
            .and_then(|f| f.session(token))
        else {
            return;
        };
        let Some(session_id) = session.session_id.clone() else {
            return;
        };
        self.select(
            Selection::FleetSession {
                selection: token.into(),
                session_id,
            },
            window,
            cx,
        );
    }
    fn fleet_session_row(
        &self,
        index: usize,
        row: usize,
        session: &browser::fleet::Session,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let bezel = self.home_palette();
        let hover = bezel.element_hover;
        let request = self.browser_request;
        let token = session.selection.clone();
        let enabled = token.is_some()
            && self.browser_commands.is_some()
            && self.presence.ready()
            && self.browser_state.request == request;
        div()
            .id(("fleet-session", index * 128 + row))
            .debug_selector(move || format!("fleet-session-{index}-{row}"))
            .mt_1()
            .px_2()
            .py_1()
            .min_h(px(36.))
            .min_w_0()
            .rounded(px(bezel_theme::Theme::control_radius()))
            .flex()
            .items_center()
            .gap_2()
            .when(enabled, |d| d.cursor_pointer().hover(move |d| d.bg(hover)))
            .child(self.fleet_preference_button(
                ("fleet-favorite", index * 128 + row),
                session.favorite_action.as_deref(),
                !session.favorite,
                if session.favorite {
                    "Remove favorite"
                } else {
                    "Add favorite"
                },
                if session.favorite {
                    "icons/fleet-star-filled.svg"
                } else {
                    "icons/fleet-star.svg"
                },
                cx,
            ))
            .child(fleet_mark("icons/terminal.svg", bezel.text_muted))
            .child(
                div()
                    .debug_selector(move || format!("fleet-session-label-{index}-{row}"))
                    .flex_1()
                    .min_w_0()
                    .truncate()
                    .child(crate::sidebar::label_text(&session.name)),
            )
            .child(
                bezel
                    .badge(format!(
                        "{} {} · {}",
                        session.pane_count,
                        if session.pane_count == 1 {
                            "pane"
                        } else {
                            "panes"
                        },
                        if enabled { "Open" } else { "Unavailable" }
                    ))
                    .debug_selector(move || format!("fleet-session-status-{index}-{row}")),
            )
            .on_click(cx.listener(move |view, _, window, cx| {
                cx.stop_propagation();
                if let Some(token) = &token {
                    view.open_fleet_session(request, token, window, cx);
                }
            }))
            .into_any_element()
    }
    pub(super) fn fleet_cards(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let fleet = self.browser_state.fleet.as_ref()?;
        let bezel = self.home_palette();
        let (hover, muted) = (bezel.element_hover, bezel.text_muted);
        let request = self.browser_request;
        let mut body = div().mt_4().flex().flex_col().gap_3();
        if let Some(status) = self.fleet_preference_status() {
            body = body.child(
                div()
                    .text_color(muted)
                    .children(design::ink_probe(|| "fleet-preference-status".into()))
                    .child(status.to_owned()),
            );
        }
        for (index, group) in fleet.groups.iter().enumerate() {
            // Bezel's section card: its fill, hairline and radius.
            let mut card = bezel
                .group_box()
                .debug_selector(move || format!("fleet-machine-{index}"))
                .min_w_0()
                .p_2()
                .child(
                    div()
                        .debug_selector(move || format!("fleet-machine-header-{index}"))
                        .min_w_0()
                        .min_h(px(32.))
                        .flex()
                        .items_center()
                        .gap_2()
                        .child(self.fleet_preference_button(
                            ("fleet-collapse", index),
                            group.collapse_action.as_deref(),
                            !group.collapsed,
                            if group.collapsed {
                                "Expand machine"
                            } else {
                                "Collapse machine"
                            },
                            if group.collapsed {
                                "icons/chevron-right.svg"
                            } else {
                                "icons/chevron-down.svg"
                            },
                            cx,
                        ))
                        .child(fleet_mark("icons/devices.svg", bezel.text))
                        .child(
                            div()
                                .debug_selector(move || format!("fleet-machine-label-{index}"))
                                .flex_1()
                                .min_w_0()
                                .truncate()
                                .font_weight(FontWeight::SEMIBOLD)
                                .child(crate::sidebar::label_text(&group.label)),
                        )
                        .child(
                            bezel
                                .badge(if group.conflict {
                                    "Identity conflict"
                                } else {
                                    group.state.label()
                                })
                                .debug_selector(move || format!("fleet-machine-status-{index}")),
                        ),
                );
            if let Some(message) = group.connection_hint() {
                card = card.child(
                    div()
                        .debug_selector(move || format!("fleet-machine-guidance-{index}"))
                        .ml(px(36.))
                        .mt_1()
                        .min_w_0()
                        .text_style(TextStyle::Callout)
                        .text_color(muted)
                        .children(design::ink_probe(move || {
                            format!("fleet-machine-guidance-{index}")
                        }))
                        .child(message),
                );
            }
            let mut actions = div().mt_2().ml(px(36.)).flex().flex_wrap().gap_2();
            if let Some(token) = group.retry.clone() {
                actions = actions.child(
                    div().id(("fleet-retry", index)).child(
                        native_controls::action_button_on(
                            "fleet-retry-action",
                            Some("Retry connection"),
                            "Retry connection",
                            native_controls::Icon::Refresh,
                            native_controls::ButtonStyle::Secondary,
                            &self.home_palette(),
                        )
                        .accessibility_id(format!("fleet-retry-{index}"))
                        .debug_selector(move || format!("fleet-retry-{index}"))
                        .on_click(cx.listener(
                            move |view, _, window, cx| {
                                cx.stop_propagation();
                                view.retry_fleet_machine(request, &token, window, cx);
                            },
                        )),
                    ),
                );
            }
            if let Some(token) = group.disconnect.clone() {
                actions = actions.child(
                    div().id(("fleet-disconnect", index)).child(
                        native_controls::action_button_on(
                            "fleet-disconnect-action",
                            Some("Disconnect"),
                            "Disconnect",
                            native_controls::Icon::Close,
                            native_controls::ButtonStyle::Quiet,
                            &self.home_palette(),
                        )
                        .accessibility_id(format!("fleet-disconnect-{index}"))
                        .debug_selector(move || format!("fleet-disconnect-{index}"))
                        .on_click(cx.listener(
                            move |view, _, window, cx| {
                                cx.stop_propagation();
                                view.disconnect_fleet_machine(request, &token, window, cx);
                            },
                        )),
                    ),
                );
            }
            if group.retry.is_some() || group.disconnect.is_some() {
                card = card.child(actions);
            }
            if group.sessions.is_empty() && group.servers.is_empty() {
                card = card.child(
                    div()
                        .mt_2()
                        .ml(px(36.))
                        .text_style(TextStyle::Callout)
                        .text_color(muted)
                        .child("No sessions available"),
                );
            }
            for (server_index, server) in group.servers.iter().enumerate() {
                if group.collapsed
                    && !group
                        .sessions
                        .iter()
                        .any(|s| s.server_id.as_ref() == Some(&server.id) && group.shows(s))
                {
                    continue;
                }
                let token = server.selection.clone();
                let enabled = token.is_some()
                    && self.browser_commands.is_some()
                    && self.presence.ready()
                    && self.browser_state.request == request;
                let selected =
                    self.browser_state
                        .selected_server
                        .as_ref()
                        .is_some_and(|selected| {
                            selected.machine_id == group.id
                                && selected.server_id == server.id
                                && server.generation.as_ref() == Some(&selected.generation)
                        });
                let mut section = div()
                    .ml(px(36.))
                    .mt_3()
                    .pl_2()
                    .min_w_0()
                    .flex()
                    .flex_col()
                    .border_l_1()
                    .border_color(bezel.border)
                    .child(
                        div()
                            .id(("fleet-server", index * 32 + server_index))
                            .debug_selector(move || format!("fleet-server-{index}-{server_index}"))
                            .px_2()
                            .py_1()
                            .min_h(px(32.))
                            .min_w_0()
                            .rounded(px(bezel_theme::Theme::control_radius()))
                            .flex()
                            .items_center()
                            .gap_2()
                            .when(enabled, |d| d.cursor_pointer().hover(move |d| d.bg(hover)))
                            .child(fleet_mark("icons/sessions.svg", muted))
                            .child(
                                div()
                                    .debug_selector(move || {
                                        format!("fleet-server-label-{index}-{server_index}")
                                    })
                                    .flex_1()
                                    .min_w_0()
                                    .truncate()
                                    .text_style(TextStyle::Body)
                                    .font_weight(FontWeight::MEDIUM)
                                    .child(crate::sidebar::label_text(&server.label)),
                            )
                            .child(
                                bezel
                                    .badge(if selected {
                                        "Selected"
                                    } else if enabled {
                                        "Select server"
                                    } else {
                                        "Unavailable"
                                    })
                                    .debug_selector(move || {
                                        format!("fleet-server-status-{index}-{server_index}")
                                    }),
                            )
                            .on_click(cx.listener(move |view, _, window, cx| {
                                cx.stop_propagation();
                                if let Some(token) = &token {
                                    view.open_fleet_server(request, token, window, cx);
                                }
                            })),
                    );
                let mut count = 0;
                for (row, session) in group
                    .sessions
                    .iter()
                    .enumerate()
                    .filter(|(_, s)| s.server_id.as_ref() == Some(&server.id) && group.shows(s))
                {
                    count += 1;
                    section = section.child(self.fleet_session_row(index, row, session, cx));
                }
                if count == 0 {
                    section = section.child(
                        div()
                            .ml_3()
                            .py_1()
                            .text_style(TextStyle::Callout)
                            .text_color(muted)
                            .child("No sessions"),
                    );
                }
                card = card.child(section);
            }
            for (row, session) in group.sessions.iter().enumerate().filter(|(_, s)| {
                group.shows(s)
                    && s.server_id
                        .as_ref()
                        .is_none_or(|id| !group.servers.iter().any(|server| &server.id == id))
            }) {
                card = card.child(
                    div()
                        .ml(px(36.))
                        .min_w_0()
                        .child(self.fleet_session_row(index, row, session, cx)),
                );
            }
            if group.omitted_servers > 0 {
                card = card.child(
                    div()
                        .text_color(muted)
                        .child(format!("{} more servers not shown", group.omitted_servers)),
                );
            }
            if group.omitted_sessions > 0 {
                card = card.child(div().text_color(muted).child(format!(
                    "{} more sessions not shown",
                    group.omitted_sessions
                )));
            }
            body = body.child(card);
        }
        if fleet.omitted_groups > 0 {
            body = body.child(format!("{} more machines not shown", fleet.omitted_groups));
        }
        Some(body.into_any_element())
    }
}
