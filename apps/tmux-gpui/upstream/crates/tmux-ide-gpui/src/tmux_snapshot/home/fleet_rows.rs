//! A row of Home's session table (#705, Option A) and the table's column
//! labels: the favicon, the name, the session's agent, windows and panes,
//! and when it was last active.
use super::fleet::{
    ACTIVE_WIDTH, FAVICON, HINT_WIDTH, LAYOUT_WIDTH, ROW_GAP, ROW_HEIGHT, glyph, panes,
};
use super::*;

impl SnapshotView {
    /// One 34px session row with no rule (#705, Option A): the star (shown
    /// on a favourite, or under the pointer), the project's favicon or the
    /// terminal glyph, the name with "attached" and its agent, then windows
    /// and panes, when it was last active, and the keyboard row's ↵ hint.
    pub(super) fn fleet_session_row(
        &self,
        index: usize,
        row: usize,
        session: &browser::fleet::Session,
        cursor: bool,
        now: i64,
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
        let group: SharedString = format!("fleet-row-{index}-{row}").into();
        let star = div()
            .flex_none()
            .debug_selector(move || format!("fleet-star-{index}-{row}"))
            .when(!session.favorite, |star| {
                star.invisible().group_hover(group.clone(), |s| s.visible())
            })
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
            ));
        let icon = match &session.favicon {
            Some(image) => img(image.clone())
                .debug_selector(move || format!("fleet-session-favicon-{index}-{row}"))
                .size(px(FAVICON))
                .flex_none()
                .rounded(px(3.))
                .into_any_element(),
            None => div()
                .debug_selector(move || format!("fleet-session-glyph-{index}-{row}"))
                .flex_none()
                .size(px(FAVICON))
                .flex()
                .items_center()
                .justify_center()
                .child(glyph("icons/terminal.svg", bezel.text_muted))
                .into_any_element(),
        };
        let name = div()
            .flex_1()
            .min_w_0()
            .flex()
            .items_center()
            .gap(px(SPACE * 1.5))
            .child(
                div()
                    .debug_selector(move || format!("fleet-session-label-{index}-{row}"))
                    .min_w_0()
                    .truncate()
                    .text_style(TextStyle::Body)
                    .child(crate::sidebar::label_text(&session.name)),
            )
            .when(session.active, |line| {
                // Plain words, not a pill: one box fewer on the row.
                line.child(
                    div()
                        .flex_none()
                        .text_style(TextStyle::Callout)
                        .text_color(bezel.text_muted)
                        .debug_selector(move || format!("fleet-session-attached-{index}-{row}"))
                        .children(design::ink_probe(move || {
                            format!("fleet-session-attached-{index}-{row}")
                        }))
                        .child("attached"),
                )
            })
            .children(self.fleet_session_agent(index, row, session, cx));
        let layout = layout(session);
        div()
            .id(("fleet-session", index * 128 + row))
            .group(group)
            .debug_selector(move || format!("fleet-session-{index}-{row}"))
            .h(px(ROW_HEIGHT))
            .px(px(ROW_GAP))
            .flex()
            .items_center()
            .gap(px(ROW_GAP))
            .min_w_0()
            .rounded(px(bezel_theme::Theme::control_radius()))
            .when(cursor, |d| d.bg(bezel.card_selected_bg()))
            .when(enabled && !cursor, |d| d.hover(move |d| d.bg(hover)))
            .when(enabled, |d| d.cursor_pointer())
            .child(star)
            .child(icon)
            .child(name)
            .child(
                div()
                    .debug_selector(move || format!("fleet-session-status-{index}-{row}"))
                    .flex_none()
                    .w(px(LAYOUT_WIDTH))
                    .text_style(TextStyle::Callout)
                    .text_color(bezel.text_muted)
                    .children(design::ink_probe(move || {
                        format!("fleet-session-status-{index}-{row}")
                    }))
                    .child(if enabled {
                        layout
                    } else {
                        "Unavailable".into()
                    }),
            )
            .child(
                div()
                    .debug_selector(move || format!("fleet-session-active-{index}-{row}"))
                    .flex_none()
                    .w(px(ACTIVE_WIDTH))
                    .flex()
                    .justify_end()
                    .text_style(TextStyle::Callout)
                    .text_color(bezel.text_muted)
                    .children(design::ink_probe(move || {
                        format!("fleet-session-active-{index}-{row}")
                    }))
                    .children(session.last_activity.map(|then| last_active(now, then))),
            )
            // The ↵ hint holds its width on every row so the columns line up.
            .child(
                div()
                    .flex_none()
                    .w(px(HINT_WIDTH))
                    .flex()
                    .justify_end()
                    .when(cursor, |cell| {
                        cell.child(
                            bezel_ui::popover::kbd_hint(&bezel, "↵")
                                .debug_selector(move || {
                                    format!("fleet-session-enter-{index}-{row}")
                                })
                                .text_color(bezel.text_muted)
                                .children(design::ink_probe(move || {
                                    format!("fleet-session-enter-{index}-{row}")
                                })),
                        )
                    }),
            )
            .on_click(cx.listener(move |view, _, window, cx| {
                cx.stop_propagation();
                if let Some(token) = &token {
                    view.open_fleet_session(request, token, window, cx);
                }
            }))
            .into_any_element()
    }

    /// The session's agent, inline after its name: the agent's name and its
    /// status badge, and "+N" for more. A click opens that agent.
    fn fleet_session_agent(
        &self,
        index: usize,
        row: usize,
        session: &browser::fleet::Session,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let roster = self.browser_state.home_agents.as_ref()?;
        let live = session.session_id.as_deref()?;
        let mut agents = roster.rows.iter().filter(|r| r.session_id == live);
        let agent = agents.next()?;
        let more = agents.count();
        let bezel = self.home_palette();
        let request = self.browser_request;
        let revision = roster.revision;
        let key = agent.key.clone();
        let enabled = self.browser_commands.is_some() && roster.available(&key);
        Some(
            div()
                .id(("fleet-session-agent", index * 128 + row))
                .debug_selector(move || format!("fleet-session-agent-{index}-{row}"))
                .flex_none()
                .flex()
                .items_center()
                .gap(px(6.))
                .text_style(TextStyle::Callout)
                .child(
                    div()
                        .text_color(bezel.text)
                        .children(design::ink_probe(move || {
                            format!("fleet-session-agent-{index}-{row}")
                        }))
                        .child(crate::sidebar::label_text(&agent.name)),
                )
                // The app's agent status: Bezel's colours and the spinner.
                .child(self.agent_indicator(
                    agent,
                    !agent.available
                        || !matches!(
                            roster.phase,
                            browser::home_agents::Phase::Live
                                | browser::home_agents::Phase::Partial
                        ),
                ))
                .when(more > 0, |line| {
                    line.child(div().text_color(bezel.text_muted).child(format!("+{more}")))
                })
                .when(enabled, |line| {
                    line.cursor_pointer()
                        .on_click(cx.listener(move |view, _, window, cx| {
                            cx.stop_propagation();
                            view.home_agent_select(request, revision, &key, window, cx);
                        }))
                })
                .into_any_element(),
        )
    }

    /// The table's column labels, once at its top, on the rows' tracks.
    pub(super) fn fleet_column_header(&self) -> Div {
        let bezel = self.home_palette();
        div()
            .debug_selector(|| "fleet-columns".into())
            .px(px(ROW_GAP))
            .pb(px(4.))
            .flex()
            .items_center()
            .gap(px(ROW_GAP))
            .min_w_0()
            .text_style(TextStyle::Caption)
            .text_color(bezel.text_muted)
            .children(design::ink_probe(|| "fleet-columns".into()))
            // In line with the session names, past the star and the icon.
            .child(
                div()
                    .flex_none()
                    .w(px(bezel_theme::Theme::BUTTON_HEIGHT + ROW_GAP + FAVICON)),
            )
            .child(div().flex_1().min_w_0().child("Session"))
            .child(div().flex_none().w(px(LAYOUT_WIDTH)).child("Windows"))
            .child(
                div()
                    .flex_none()
                    .w(px(ACTIVE_WIDTH))
                    .flex()
                    .justify_end()
                    .child("Last active"),
            )
            .child(div().flex_none().w(px(HINT_WIDTH)))
    }
}

/// A session's windows and panes; a version 1 daemon reports panes only.
pub(super) fn layout(session: &browser::fleet::Session) -> String {
    match session.window_count {
        Some(windows) => format!(
            "{} · {}",
            crate::plural::count(windows, "window", "windows"),
            panes(session.pane_count)
        ),
        None => panes(session.pane_count),
    }
}

/// When a session was last active, said the way a person would.
pub(super) fn last_active(now: i64, then: i64) -> String {
    let ago = (now - then).max(0);
    match ago {
        0..60 => "now".into(),
        60..3600 => format!("{} min ago", ago / 60),
        3600..86_400 => format!("{} h ago", ago / 3600),
        86_400..172_800 => "yesterday".into(),
        _ if ago < 7 * 86_400 => format!("{} days ago", ago / 86_400),
        _ if ago < 14 * 86_400 => "last week".into(),
        _ => format!("{} weeks ago", ago / (7 * 86_400)),
    }
}
