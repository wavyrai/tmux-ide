//! Home's fleet: the left list (All sessions, Favourites, machines, Add
//! machine) and the session table for the list's entry (#684, #705 Option A):
//! machines are label lines over their rows, with no card and no rules. The
//! rows themselves are in `fleet_rows`.
use super::*;
use bezel_ui::widgets::{Content, status_dot};
use fleet_nav::View;

/// The left list's width.
pub(super) const NAV_WIDTH: f32 = 232.;
/// How far server and session rows sit in from their machine's header.
pub(super) const ROW_INDENT: f32 = 36.;
/// Option A's tracks (#705): a row's height and gap, the favicon, the
/// windows-and-panes column and the last-active column.
pub(super) const ROW_HEIGHT: f32 = 34.;
pub(super) const ROW_GAP: f32 = SPACE * 1.5;
pub(super) const FAVICON: f32 = 16.;
pub(super) const LAYOUT_WIDTH: f32 = 150.;
pub(super) const ACTIVE_WIDTH: f32 = 96.;
/// The widest the table gets, so a value sits near its name.
pub(super) const TABLE_MAX: f32 = 760.;
/// The trailing column that holds the keyboard row's ↵ hint.
pub(super) const HINT_WIDTH: f32 = 28.;

pub(super) fn glyph(path: &'static str, color: Hsla) -> Svg {
    bezel_ui::icons::icon(bezel_ui::icons::Icon::asset(path))
        .size(px(bezel_ui::widgets::ICON_GLYPH))
        .flex_none()
        .text_color(color)
}

/// The tone of a machine's status dot.
fn machine_tone(bezel: &bezel_theme::Theme, group: &browser::fleet::Group) -> Hsla {
    if group.conflict {
        return bezel.danger;
    }
    match group.state {
        browser::fleet::Phase::Ready => bezel.success,
        browser::fleet::Phase::Connecting => bezel.warning,
        browser::fleet::Phase::Disconnected => bezel.text_muted,
    }
}

pub(super) fn panes(count: u64) -> String {
    format!("{count} {}", if count == 1 { "pane" } else { "panes" })
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

    /// The left list's entry, reconciled with the current fleet.
    pub(in crate::tmux_snapshot) fn home_fleet_view(&self) -> View {
        let view = self
            .home_filter
            .as_ref()
            .map_or(View::All, |c| c.fleet_view.clone());
        fleet_nav::reconcile(&view, self.browser_state.fleet.as_ref())
    }

    fn choose_fleet_view(&mut self, view: View, window: &mut Window, cx: &mut Context<Self>) {
        if self.browser_state.surface != browser::Surface::Home {
            return;
        }
        if let Some(controls) = &mut self.home_filter {
            controls.fleet_view = view;
            controls.waiting_only = false;
            controls.fleet_nav.focus(window, cx);
            cx.notify();
        }
    }

    fn fleet_nav_row(
        &self,
        index: usize,
        entry: &View,
        selected: bool,
        cx: &mut Context<Self>,
    ) -> Stateful<Div> {
        let bezel = self.home_palette();
        let fleet = self.browser_state.fleet.as_ref();
        let group = match entry {
            View::Machine(id) => fleet.and_then(|f| f.groups.iter().find(|g| &g.id == id)),
            _ => None,
        };
        let (icon, label) = match (entry, group) {
            (View::All, _) => ("icons/sessions.svg", "All sessions".to_owned()),
            (View::Favourites, _) => ("icons/fleet-star.svg", "Favourites".to_owned()),
            (View::Machine(_), Some(group)) => ("icons/devices.svg", group.label.clone()),
            (View::Machine(id), None) => ("icons/devices.svg", id.clone()),
        };
        let selector = entry.selector(index);
        let hover = bezel.element_hover;
        let entry = entry.clone();
        div()
            .id(("home-nav", index))
            .debug_selector(move || selector.clone())
            .role(Role::Tab)
            .aria_label(label.clone())
            .aria_selected(selected)
            .w_full()
            .min_w_0()
            .flex()
            .items_center()
            .gap(px(SPACE))
            .px(px(SPACE))
            .py(px(6.))
            .rounded(px(bezel_theme::Theme::control_radius()))
            .cursor_pointer()
            .map(|row| {
                if selected {
                    row.bg(bezel.card_selected_bg())
                } else {
                    row.hover(move |s| s.bg(hover))
                }
            })
            .child(glyph(
                icon,
                if selected {
                    bezel.text
                } else {
                    bezel.text_muted
                },
            ))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .truncate()
                    .text_style(TextStyle::Body)
                    .child(crate::sidebar::label_text(&label)),
            )
            .children(group.map(|g| status_dot(machine_tone(&bezel, g))))
            .child(
                div()
                    .flex_none()
                    .text_style(TextStyle::Callout)
                    .text_color(bezel.text_muted)
                    .children(design::ink_probe(move || format!("home-nav-count-{index}")))
                    .child(fleet_nav::count(&entry, fleet).to_string()),
            )
            .on_click(cx.listener(move |view, _, window, cx| {
                cx.stop_propagation();
                view.choose_fleet_view(entry.clone(), window, cx);
            }))
    }

    /// The left list, or in a narrow window a wrapping row of the same
    /// entries over the table. `None` without a fleet.
    pub(super) fn fleet_nav(&self, wide: bool, cx: &mut Context<Self>) -> Option<AnyElement> {
        let fleet = self.browser_state.fleet.as_ref()?;
        let bezel = self.home_palette();
        let current = self.home_fleet_view();
        let request = self.browser_request;
        let entries = fleet_nav::entries(Some(fleet));
        let mut list = div()
            .id("home-fleet-nav")
            .debug_selector(|| "home-fleet-nav".into())
            .role(Role::TabList)
            .aria_label("Fleet")
            .flex_none()
            .flex()
            .gap(px(2.))
            .map(|list| {
                if wide {
                    list.w(px(NAV_WIDTH)).flex_col()
                } else {
                    list.w_full().flex_row().flex_wrap().items_center()
                }
            })
            .when_some(self.home_filter.as_ref(), |list, c| {
                list.track_focus(&c.fleet_nav)
            });
        for (index, entry) in entries.iter().enumerate() {
            if index == 2 && wide {
                list = list.child(
                    div()
                        .mt(px(SPACE * 1.5))
                        .px(px(SPACE))
                        .pb(px(4.))
                        .text_style(TextStyle::Subheadline)
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(bezel.text_muted)
                        .children(design::ink_probe(|| "home-nav-machines".into()))
                        .child("Machines"),
                );
            }
            let row = self.fleet_nav_row(index, entry, *entry == current, cx);
            list = list.child(if wide {
                row
            } else {
                row.w_auto().max_w(px(NAV_WIDTH))
            });
        }
        if fleet.omitted_groups > 0 {
            list = list.child(
                div()
                    .px(px(SPACE))
                    .text_style(TextStyle::Callout)
                    .text_color(bezel.text_muted)
                    .child(format!("{} more machines not shown", fleet.omitted_groups)),
            );
        }
        let hover = bezel.element_hover;
        list = list.child(
            div()
                .id("home-add-machine")
                .debug_selector(|| "home-add-machine".into())
                .role(Role::Button)
                .aria_label("Add machine…")
                .when(wide, |row| row.mt(px(SPACE)))
                .px(px(SPACE))
                .py(px(6.))
                .rounded(px(bezel_theme::Theme::control_radius()))
                .flex()
                .items_center()
                .gap(px(SPACE))
                .text_style(TextStyle::Callout)
                .text_color(bezel.text_muted)
                .cursor_pointer()
                .hover(move |s| s.bg(hover))
                .children(design::ink_probe(|| "home-add-machine".into()))
                .child(glyph("icons/plus.svg", bezel.text_muted))
                .child("Add machine…")
                .on_click(cx.listener(move |view, _, window, cx| {
                    cx.stop_propagation();
                    if view.home_action_current(request) {
                        view.open_add_machine(window, cx);
                    }
                })),
        );
        Some(list.into_any_element())
    }

    /// A machine's quiet label line: its name, any state other than
    /// connected, and its actions. It shows when the table holds more than
    /// one machine, or when this one has something to say or do.
    fn fleet_machine_header(
        &self,
        index: usize,
        group: &browser::fleet::Group,
        several: bool,
        collapsible: bool,
        cx: &mut Context<Self>,
    ) -> Option<Div> {
        let bezel = self.home_palette();
        let request = self.browser_request;
        let ready = group.state == browser::fleet::Phase::Ready && !group.conflict;
        let mut actions: Vec<AnyElement> = Vec::new();
        if let [server] = group.servers.as_slice() {
            actions.extend(self.fleet_server_default(index, 0, group, server, cx));
        }
        if let Some(token) = group.retry.clone() {
            actions.push(
                div()
                    .id(("fleet-retry", index))
                    .child(
                        native_controls::action_button_on(
                            "fleet-retry-action",
                            Some("Retry connection"),
                            "Retry connection",
                            native_controls::Icon::Refresh,
                            native_controls::ButtonStyle::Secondary,
                            &bezel,
                        )
                        .accessibility_id(format!("fleet-retry-{index}"))
                        .debug_selector(move || format!("fleet-retry-{index}"))
                        .on_click(cx.listener(
                            move |view, _, window, cx| {
                                cx.stop_propagation();
                                view.retry_fleet_machine(request, &token, window, cx);
                            },
                        )),
                    )
                    .into_any_element(),
            );
        }
        if let Some(token) = group.disconnect.clone() {
            actions.push(
                div()
                    .id(("fleet-disconnect", index))
                    .child(
                        native_controls::action_button_on(
                            "fleet-disconnect-action",
                            Some("Disconnect"),
                            "Disconnect",
                            native_controls::Icon::Close,
                            native_controls::ButtonStyle::Quiet,
                            &bezel,
                        )
                        .accessibility_id(format!("fleet-disconnect-{index}"))
                        .debug_selector(move || format!("fleet-disconnect-{index}"))
                        .on_click(cx.listener(
                            move |view, _, window, cx| {
                                cx.stop_propagation();
                                view.disconnect_fleet_machine(request, &token, window, cx);
                            },
                        )),
                    )
                    .into_any_element(),
            );
        }
        // One machine needs no collapse (Favourites does that), unless it
        // was collapsed before and must be able to open again.
        let collapse = collapsible && (several || group.collapsed);
        if !several && ready && actions.is_empty() && !collapse {
            return None;
        }
        Some(
            div()
                .debug_selector(move || format!("fleet-machine-header-{index}"))
                .min_w_0()
                .min_h(px(ROW_HEIGHT))
                .px(px(ROW_GAP))
                .flex()
                .items_center()
                .gap(px(SPACE))
                .when(collapse, |header| {
                    header.child(self.fleet_preference_button(
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
                })
                .child(
                    div()
                        .debug_selector(move || format!("fleet-machine-label-{index}"))
                        .min_w_0()
                        .truncate()
                        .text_style(TextStyle::Subheadline)
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(bezel.text_muted)
                        .children(design::ink_probe(move || {
                            format!("fleet-machine-label-{index}")
                        }))
                        .child(crate::sidebar::label_text(&group.label)),
                )
                // Connected says nothing the left list's dot does not.
                .when(!ready, |header| {
                    header.child(
                        div()
                            .debug_selector(move || format!("fleet-machine-status-{index}"))
                            .flex_none()
                            .flex()
                            .items_center()
                            .gap(px(6.))
                            .text_style(TextStyle::Callout)
                            .text_color(bezel.text_muted)
                            .child(status_dot(machine_tone(&bezel, group)))
                            .children(design::ink_probe(move || {
                                format!("fleet-machine-status-{index}")
                            }))
                            .child(if group.conflict {
                                "Identity conflict"
                            } else {
                                group.state.label()
                            }),
                    )
                })
                .child(div().flex_1())
                .children(actions),
        )
    }

    fn fleet_server_row(
        &self,
        index: usize,
        server_index: usize,
        group: &browser::fleet::Group,
        server: &browser::fleet::Server,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let bezel = self.home_palette();
        let (hover, muted) = (bezel.element_hover, bezel.text_muted);
        let request = self.browser_request;
        let token = server.selection.clone();
        let enabled = token.is_some()
            && self.browser_commands.is_some()
            && self.presence.ready()
            && self.browser_state.request == request;
        div()
            .id(("fleet-server", index * 32 + server_index))
            .debug_selector(move || format!("fleet-server-{index}-{server_index}"))
            .min_h(px(28.))
            .pl(px(ROW_INDENT))
            .pr(px(ROW_GAP))
            .flex()
            .items_center()
            .gap(px(SPACE))
            .min_w_0()
            .rounded(px(bezel_theme::Theme::control_radius()))
            .when(enabled, |d| d.cursor_pointer().hover(move |d| d.bg(hover)))
            .child(
                div()
                    .debug_selector(move || format!("fleet-server-label-{index}-{server_index}"))
                    .flex_1()
                    .min_w_0()
                    .truncate()
                    .text_style(TextStyle::Callout)
                    .text_color(muted)
                    .children(design::ink_probe(move || {
                        format!("fleet-server-label-{index}-{server_index}")
                    }))
                    .child(crate::sidebar::label_text(&format!(
                        "tmux · {}",
                        server.label
                    ))),
            )
            .children(self.fleet_server_default(index, server_index, group, server, cx))
            .on_click(cx.listener(move |view, _, window, cx| {
                cx.stop_propagation();
                if let Some(token) = &token {
                    view.open_fleet_server(request, token, window, cx);
                }
            }))
            .into_any_element()
    }

    /// Whether new sessions go to `server`.
    fn fleet_server_is_default(
        &self,
        group: &browser::fleet::Group,
        server: &browser::fleet::Server,
    ) -> bool {
        self.browser_state
            .selected_server
            .as_ref()
            .is_some_and(|selected| {
                selected.machine_id == group.id
                    && selected.server_id == server.id
                    && server.generation.as_ref() == Some(&selected.generation)
            })
    }

    /// Where a server's "Use for new sessions" lives: a labelled Bezel button
    /// while it is not the default, a muted "Default" once it is, but only
    /// where there is more than one place new sessions could go. The tooltip
    /// names the server.
    fn fleet_server_default(
        &self,
        index: usize,
        server_index: usize,
        group: &browser::fleet::Group,
        server: &browser::fleet::Server,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let bezel = self.home_palette();
        let request = self.browser_request;
        let id = index * 32 + server_index;
        if self.fleet_server_is_default(group, server) {
            let several = group.servers.len() > 1
                || self
                    .browser_state
                    .fleet
                    .as_ref()
                    .is_some_and(|f| f.groups.len() > 1);
            return several.then(|| {
                div()
                    .debug_selector(move || format!("fleet-server-default-{index}-{server_index}"))
                    .flex_none()
                    .text_style(TextStyle::Callout)
                    .text_color(bezel.text_muted)
                    .children(design::ink_probe(move || {
                        format!("fleet-server-default-{index}-{server_index}")
                    }))
                    .child("Default")
                    .into_any_element()
            });
        }
        let token = server.selection.clone()?;
        let enabled = self.browser_commands.is_some()
            && self.presence.ready()
            && self.browser_state.request == request;
        let tip: SharedString = format!("Use {} for new sessions", server.label).into();
        let button =
            bezel_ui::widgets::Button::new(("fleet-use-server", id), "Use for new sessions")
                .icon(bezel_ui::icons::Icon::asset("icons/check.svg"))
                .enabled(enabled)
                .text_color(bezel.text_muted)
                .on_press(cx.listener(move |view, _, window, cx| {
                    cx.stop_propagation();
                    view.open_fleet_server(request, &token, window, cx);
                }));
        Some(
            div()
                .id(("fleet-use-server-tip", id))
                .debug_selector(move || format!("fleet-use-server-{index}-{server_index}"))
                .flex_shrink_0()
                .child(button)
                .when(enabled, |tip_el| {
                    tip_el.tooltip(move |window, cx| {
                        bezel_ui::tooltip::Tooltip::text(tip.clone(), window, cx)
                    })
                })
                .into_any_element(),
        )
    }

    fn fleet_note(&self, text: impl Into<SharedString>) -> Div {
        let bezel = self.home_palette();
        div()
            .min_h(px(28.))
            .pl(px(ROW_INDENT))
            .flex()
            .items_center()
            .text_style(TextStyle::Callout)
            .text_color(bezel.text_muted)
            .child(text.into())
    }

    /// The session table for the left list's entry. `None` without a fleet.
    /// No card and no rules: machines are label lines over their rows.
    pub(super) fn fleet_cards(
        &self,
        window: &Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let fleet = self.browser_state.fleet.as_ref()?;
        let bezel = self.home_palette();
        let view = self.home_fleet_view();
        let waiting = filters::waiting_sessions(
            &self.browser_state,
            self.home_filter.as_ref().is_some_and(|c| c.waiting_only),
        );
        let only = waiting.as_ref();
        // A machine shows when its view does, and, under the pill's filter,
        // when one of its sessions waits.
        let shows_group = |group: &browser::fleet::Group| {
            view.shows_group(group)
                && (only.is_none()
                    || group
                        .sessions
                        .iter()
                        .any(|s| fleet_nav::shows(&view, only, group, s)))
        };
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_secs() as i64);
        // The keyboard row, while the table has focus.
        let cursor = self
            .home_filter
            .as_ref()
            .filter(|c| c.fleet_table.is_focused(window))
            .and_then(|c| {
                fleet_nav::step_row(&view, only, Some(fleet), c.table_cursor.as_ref(), "")
            });
        let is_cursor = |index: usize, row: usize| {
            cursor
                .as_ref()
                .is_some_and(|key| *key == fleet_nav::row_key(fleet, (index, row)))
        };
        let mut body = div()
            .id("home-fleet-table")
            .debug_selector(|| "home-fleet-table".into())
            .role(Role::Grid)
            .aria_label("Sessions")
            .when_some(self.home_filter.as_ref(), |body, c| {
                body.track_focus(&c.fleet_table)
            })
            .w_full()
            .min_w_0()
            .flex()
            .flex_col();
        if let Some(status) = self.fleet_preference_status() {
            body = body.child(match status {
                preferences::Status::Progress(message) => div()
                    .debug_selector(|| "fleet-preference-status".into())
                    .pb(px(SPACE))
                    .text_style(TextStyle::Callout)
                    .text_color(bezel.text_muted)
                    .children(design::ink_probe(|| "fleet-preference-status".into()))
                    .child(message.to_owned()),
                preferences::Status::Error(message) => {
                    bezel_ui::popover::error_row(&bezel, message.to_owned())
                        .p_0()
                        .pb(px(SPACE))
                        .text_color(bezel.danger_muted)
                        .debug_selector(|| "fleet-preference-error".into())
                        .children(design::ink_probe(|| "fleet-preference-status".into()))
                }
            });
        }
        let no_rows = fleet_nav::table_rows(&view, only, Some(fleet)).is_empty();
        // Connected machines with no session between them: one invitation
        // instead of an empty table (#705). Favourites keeps its own.
        let shown_groups: Vec<_> = fleet.groups.iter().filter(|g| shows_group(g)).collect();
        if no_rows
            && view != View::Favourites
            && only.is_none()
            && !shown_groups.is_empty()
            && shown_groups.iter().all(|g| {
                // A collapsed machine hides its rows; it keeps its line
                // so it can open again.
                g.state == browser::fleet::Phase::Ready
                    && !g.collapsed
                    && !g.conflict
                    && g.omitted_sessions == 0
                    && g.connection_hint().is_none()
            })
        {
            let title = match shown_groups.as_slice() {
                [group] => format!("No sessions on {} yet", group.label),
                _ => "No sessions yet".to_owned(),
            };
            return Some(
                body.child(
                    bezel
                        .empty_state(
                            bezel_ui::icons::Icon::asset("icons/terminal.svg"),
                            title,
                            "Start one with New session, or add a machine from the list.",
                        )
                        .debug_selector(|| "home-fleet-no-sessions".into())
                        .text_color(bezel.text),
                )
                .into_any_element(),
            );
        }
        if !no_rows {
            body = body.child(self.fleet_column_header());
        }
        let several = fleet.groups.iter().filter(|g| shows_group(g)).count() > 1;
        let mut shown = 0;
        for (index, group) in fleet.groups.iter().enumerate() {
            if !shows_group(group) {
                continue;
            }
            shown += 1;
            let mut block = div()
                .debug_selector(move || format!("fleet-machine-{index}"))
                .min_w_0()
                .flex()
                .flex_col()
                .when(several && shown > 1, |block| block.pt(px(SPACE)))
                .children(self.fleet_machine_header(index, group, several, view == View::All, cx));
            // A lone server is its machine; two or more get a line each.
            let server_rows = group.servers.len() > 1;
            if let Some(message) = group.connection_hint() {
                block = block.child(
                    self.fleet_note(message)
                        .debug_selector(move || format!("fleet-machine-guidance-{index}"))
                        .children(design::ink_probe(move || {
                            format!("fleet-machine-guidance-{index}")
                        })),
                );
            }
            if group.sessions.is_empty() && group.servers.is_empty() {
                block = block.child(self.fleet_note("No sessions available"));
            }
            for (server_index, server) in group.servers.iter().enumerate() {
                let rows: Vec<_> = group
                    .sessions
                    .iter()
                    .enumerate()
                    .filter(|(_, s)| {
                        s.server_id.as_ref() == Some(&server.id)
                            && fleet_nav::shows(&view, only, group, s)
                    })
                    .collect();
                // All sessions hides an empty server only on a collapsed
                // machine; Favourites hides every server without a favourite.
                let hide = only.is_some()
                    || match &view {
                        View::All => group.collapsed,
                        View::Favourites => true,
                        View::Machine(_) => false,
                    };
                if rows.is_empty() && hide {
                    continue;
                }
                if server_rows {
                    block =
                        block.child(self.fleet_server_row(index, server_index, group, server, cx));
                }
                if rows.is_empty() {
                    block = block.child(self.fleet_note("No sessions"));
                }
                for (row, session) in rows {
                    block = block.child(self.fleet_session_row(
                        index,
                        row,
                        session,
                        is_cursor(index, row),
                        now,
                        cx,
                    ));
                }
            }
            for (row, session) in group.sessions.iter().enumerate().filter(|(_, s)| {
                fleet_nav::shows(&view, only, group, s)
                    && s.server_id
                        .as_ref()
                        .is_none_or(|id| !group.servers.iter().any(|server| &server.id == id))
            }) {
                block = block.child(self.fleet_session_row(
                    index,
                    row,
                    session,
                    is_cursor(index, row),
                    now,
                    cx,
                ));
            }
            if group.omitted_servers > 0 {
                block = block.child(
                    self.fleet_note(format!("{} more servers not shown", group.omitted_servers)),
                );
            }
            if group.omitted_sessions > 0 {
                block = block.child(self.fleet_note(format!(
                    "{} more sessions not shown",
                    group.omitted_sessions
                )));
            }
            body = body.child(block);
        }
        if shown == 0 {
            let (title, hint) = match view {
                View::Favourites => (
                    "No favourites",
                    "Star a session to keep it here, on every machine.",
                ),
                _ => ("No machines", "Add a machine to see its sessions here."),
            };
            body = body.child(
                bezel
                    .empty_state(
                        bezel_ui::icons::Icon::asset("icons/fleet-star.svg"),
                        title,
                        hint,
                    )
                    .debug_selector(|| "home-fleet-empty".into()),
            );
        }
        Some(body.into_any_element())
    }
}
