//! The collapsed sidebar's compact rail, as Herdr's default
//! `ui.sidebar_collapsed_mode = "compact"` draws it: per host a header mark,
//! then a status mark per workspace and per agent. Every mark navigates where
//! its expanded row would, and its tooltip names what the narrow column cannot.

use super::{
    agent_name,
    agents::{Indicators, agent_place, state_label, status_indicator, status_text},
    cell::RowState,
    label_text,
    layout::{self, SidebarLook},
    line_height, visible_workspace_entries,
    workspaces::workspace_label,
};
use crate::{
    Command, HerdrWindow, NavigationTarget,
    config::{FontConfig, Theme},
    fonts::StyledFont,
    herdr_settings::SidebarCollapsedMode,
};
use gpui::{prelude::*, *};
use herdr_client::protocol::{AgentStatus, ClientShellAgent};
use std::borrow::Cow;

/// Wide enough for a two-digit workspace number beside a symbol indicator.
pub(crate) const RAIL_WIDTH: f32 = 48.;
const HOST_MARK: f32 = 22.;
const AGENT_ICON: f32 = 14.;
const MARK_GAP: f32 = 4.;

/// What the sidebar column shows.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SidebarMode {
    Expanded,
    Rail,
    Hidden,
}

impl SidebarMode {
    /// The column's width, under the same terminal reserve the expanded
    /// sidebar keeps, so a narrow window never loses its terminal to it.
    pub(crate) fn width(self, preferred: Option<f32>, window_width: f32) -> Option<f32> {
        match self {
            Self::Expanded => Some(super::sidebar_width(preferred, window_width)),
            // A window too narrow for any rail gets none rather than a border.
            Self::Rail => Some(RAIL_WIDTH.min(window_width - 240.)).filter(|width| *width > 0.),
            Self::Hidden => None,
        }
    }
}

impl HerdrWindow {
    /// Collapsing follows the local daemon's `ui.sidebar_collapsed_mode`,
    /// also while an SSH host is shown, as Herdr keeps presentation local.
    /// Before shared settings load, Herdr's default rail applies.
    pub(crate) fn sidebar_mode(&self) -> SidebarMode {
        if self.sidebar_visible {
            return SidebarMode::Expanded;
        }
        match self
            .settings
            .shared
            .as_ref()
            .map_or(SidebarCollapsedMode::Compact, |shared| {
                shared.sidebar_collapsed_mode
            }) {
            SidebarCollapsedMode::Compact => SidebarMode::Rail,
            SidebarCollapsedMode::Hidden => SidebarMode::Hidden,
        }
    }

    pub(crate) fn toggle_sidebar(&mut self) {
        self.sidebar_visible = !self.sidebar_visible;
        self.sidebar_start_pending = false;
    }

    /// Applies `ui.sidebar_start_collapsed` once, from the first shared
    /// settings to load. Later reloads, and a toggle made before the first
    /// load arrives, leave the user's choice alone, as Herdr reads the setting
    /// at startup only.
    pub(crate) fn apply_sidebar_start(&mut self) {
        if !std::mem::take(&mut self.sidebar_start_pending) {
            return;
        }
        if self
            .settings
            .shared
            .as_ref()
            .is_some_and(|shared| shared.sidebar_start_collapsed)
        {
            self.sidebar_visible = false;
        }
    }

    pub(crate) fn render_rail(
        &self,
        indicators: Indicators,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Stateful<Div> {
        let width = SidebarMode::Rail
            .width(None, f32::from(window.viewport_size().width))
            .unwrap_or(0.);
        let look = layout::for_config(&self.config);
        let font = &self.config.sidebar;
        let theme = &self.theme;
        let hint = Hint::new(theme);
        let multi = self.endpoints.len() > 1;
        let split = self.sidebar_split.unwrap_or(0.5).clamp(0.1, 0.9);
        let mut spaces = div()
            .id("rail-spaces")
            .debug_selector(|| "rail-spaces".into())
            .flex()
            .flex_col()
            .flex_1()
            .min_h_0()
            .overflow_y_scroll();
        let mut agents = div()
            .id("rail-agents")
            .debug_selector(|| "rail-agents".into())
            .flex()
            .flex_col()
            .flex_1()
            .min_h_0()
            .overflow_y_scroll();
        for (endpoint_index, endpoint) in self.endpoints.iter().enumerate() {
            if !self.device_visible(&endpoint.id) {
                continue;
            }
            let selected = endpoint_index == self.selected_endpoint;
            let endpoint_id = endpoint.id.clone();
            let initial = host_initial(&endpoint.label);
            if multi {
                let select_id = endpoint_id.clone();
                let menu_id = endpoint_id.clone();
                let connected = endpoint.live.status.is_connected();
                let text = if endpoint.collapsed {
                    format!("{} (collapsed)", endpoint.label)
                } else {
                    endpoint.label.clone()
                };
                spaces = spaces.child(
                    rail_row(
                        &format!("rail-host-{endpoint_id}"),
                        RowState {
                            selected,
                            ..RowState::default()
                        },
                        font,
                        look,
                        theme,
                    )
                    .child(
                        div()
                            .relative()
                            .size(px(HOST_MARK))
                            .flex_none()
                            .flex()
                            .items_center()
                            .justify_center()
                            .rounded(px(crate::config::corners::SMALL))
                            .border_1()
                            .border_color(rgb(theme.active))
                            .text_color(rgb(if endpoint.enabled {
                                theme.foreground
                            } else {
                                theme.muted
                            }))
                            .child(label_text(&initial))
                            .child(
                                div()
                                    .debug_selector(|| format!("rail-host-status-{endpoint_id}"))
                                    .absolute()
                                    .right(px(-2.))
                                    .bottom(px(-2.))
                                    .size(px(6.))
                                    .rounded_full()
                                    .bg(rgb(if connected {
                                        crate::menu::online(theme)
                                    } else {
                                        theme.muted
                                    })),
                            ),
                    )
                    .id(SharedString::from(format!("rail-host-{endpoint_id}")))
                    .debug_selector(|| format!("rail-host-{endpoint_id}"))
                    .cursor_pointer()
                    .tooltip(hint.with(text))
                    .on_mouse_down(
                        MouseButton::Right,
                        cx.listener(move |this, event: &MouseDownEvent, window, cx| {
                            cx.stop_propagation();
                            this.open_host_menu(&menu_id, event.position, window, cx);
                            this.menu.opening_right_click =
                                this.menu.page == Some(crate::menu::Page::Host);
                        }),
                    )
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.select_endpoint(&select_id, cx);
                        window.focus(&this.focus, cx);
                    })),
                );
            }
            if multi && endpoint.collapsed {
                continue;
            }
            let live = if selected { &self.live } else { &endpoint.live };
            let Some(snapshot) = &live.snapshot else {
                continue;
            };
            let collapsed_repos = if endpoint_index == 0 {
                &self.collapsed_repos
            } else {
                &endpoint.collapsed_repos
            };
            let host = multi.then_some(endpoint.label.as_str());
            for (index, indented, _) in
                visible_workspace_entries(&snapshot.workspaces, collapsed_repos)
            {
                let workspace = &snapshot.workspaces[index];
                let id = workspace.workspace_id.clone();
                let key = format!("rail-workspace-{endpoint_id}-{id}");
                let navigate_endpoint = endpoint_id.clone();
                let context_endpoint = endpoint_id.clone();
                let context_id = id.clone();
                let focused = selected && workspace.focused;
                spaces = spaces.child(
                    rail_row(
                        &key,
                        RowState {
                            selected: focused,
                            ..RowState::default()
                        },
                        font,
                        look,
                        theme,
                    )
                    .gap(px(MARK_GAP))
                    .child(
                        div()
                            .flex_none()
                            .text_color(rgb(if focused {
                                theme.foreground
                            } else {
                                theme.muted
                            }))
                            .child(label_text(&workspace.number.to_string())),
                    )
                    .child(indicator(workspace.agent_status, font, indicators))
                    .id(SharedString::from(key.clone()))
                    .debug_selector(|| key)
                    .cursor_pointer()
                    .tooltip(hint.with(describe(
                        host,
                        workspace_label(workspace, indented),
                        None,
                        status_word(workspace.agent_status),
                    )))
                    .on_mouse_down(
                        MouseButton::Right,
                        cx.listener(move |this, event: &MouseDownEvent, window, cx| {
                            cx.stop_propagation();
                            if this.navigate_endpoint(
                                &context_endpoint,
                                NavigationTarget::Workspace(&context_id),
                                cx,
                            ) {
                                this.open_workspace_menu(&context_id, event.position, window, cx);
                                this.menu.opening_right_click =
                                    this.menu.page == Some(crate::menu::Page::Workspace);
                            }
                        }),
                    )
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.navigate_endpoint(
                            &navigate_endpoint,
                            NavigationTarget::Workspace(&id),
                            cx,
                        );
                        window.focus(&this.focus, cx);
                    })),
                );
            }
        }
        // Agents come after every host: the panel interleaves them.
        let panel = if self.config.show_agents {
            self.panel_agents()
        } else {
            Vec::new()
        };
        for (index, agent) in panel {
            let Some(endpoint) = self.endpoints.get(index) else {
                continue;
            };
            // A collapsed host folds its agents away with its workspaces.
            if multi && endpoint.collapsed {
                continue;
            }
            let selected = index == self.selected_endpoint;
            let live = if selected { &self.live } else { &endpoint.live };
            let Some(snapshot) = live.snapshot.as_deref() else {
                continue;
            };
            let endpoint_id = &endpoint.id;
            let host = multi.then_some(endpoint.label.as_str());
            let id = agent.pane_id.clone();
            let key = format!("rail-agent-{endpoint_id}-{id}");
            let navigate_endpoint = endpoint_id.clone();
            let focused = selected && agent.focused;
            let place = agent_place(agent, snapshot);
            let place = place.map(|(workspace, tab)| match tab {
                Some(tab) => format!("{workspace} / {tab}"),
                None => workspace.to_owned(),
            });
            agents = agents.child(
                rail_row(
                    &key,
                    RowState {
                        selected: focused,
                        ..RowState::default()
                    },
                    font,
                    look,
                    theme,
                )
                .gap(px(MARK_GAP))
                // Herdr's rail prefixes each agent with its machine's
                // initial once more than one host shares the list.
                .when(multi, |row| {
                    row.child(
                        div()
                            .flex_none()
                            .text_color(rgb(theme.muted))
                            .child(label_text(&host_initial(&endpoint.label))),
                    )
                })
                .child(
                    svg()
                        .debug_selector(|| format!("rail-agent-icon-{id}"))
                        .path(crate::icons::AgentIcon::from_identity(agent.agent.as_deref()).path())
                        .size(px(AGENT_ICON.min(font.size + 1.)))
                        .flex_none()
                        .text_color(rgb(if focused {
                            theme.foreground
                        } else {
                            theme.muted
                        })),
                )
                .child(indicator(agent.agent_status, font, indicators))
                .id(SharedString::from(key.clone()))
                .debug_selector(|| key)
                .cursor_pointer()
                .tooltip(hint.with(describe(
                    host,
                    agent_name(agent),
                    place.as_deref(),
                    agent_status_word(agent).as_deref(),
                )))
                .on_click(cx.listener(move |this, _, window, cx| {
                    this.navigate_endpoint(&navigate_endpoint, NavigationTarget::Pane(&id), cx);
                    window.focus(&this.focus, cx);
                })),
            );
        }
        div()
            .id("sidebar-rail")
            .debug_selector(|| "sidebar-rail".into())
            .relative()
            .w(px(width))
            .flex_none()
            .h_full()
            .min_h_0()
            .overflow_hidden()
            .flex()
            .flex_col()
            .text_font(font)
            .text_size(px(font.size))
            .line_height(px(line_height(font)))
            .text_color(rgb(theme.foreground))
            .bg(rgb(theme.sidebar_background()))
            .border_r_1()
            .border_color(rgb(theme.active))
            // No expand control of its own: the title bar's sidebar toggle,
            // in the header or leading the tab row, is always on screen.
            .child(
                div()
                    .debug_selector(|| "rail-spaces-section".into())
                    .flex()
                    .flex_col()
                    .flex_1()
                    .map(|mut section| {
                        section.style().flex_grow =
                            Some(if self.config.show_agents { split } else { 1. });
                        section
                    })
                    .min_h_0()
                    .overflow_hidden()
                    .child(spaces),
            )
            .when(self.config.show_agents, |rail| {
                rail.child(div().flex_none().h(px(1.)).bg(rgb(theme.active)))
                    .child(
                        div()
                            .debug_selector(|| "rail-agents-section".into())
                            .flex()
                            .flex_col()
                            .flex_1()
                            .map(|mut section| {
                                section.style().flex_grow = Some(1. - split);
                                section
                            })
                            .min_h_0()
                            .overflow_hidden()
                            .child(agents),
                    )
            })
            .child(
                rail_button("rail-new-workspace", font, look, theme)
                    .text_color(rgb(theme.muted))
                    .hover(|s| s.text_color(rgb(theme.foreground)))
                    .tooltip(hint.with("New workspace"))
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.command(Command::Workspace, window, cx);
                    }))
                    .child(label_text("+")),
            )
    }
}

/// A rail row: centered marks over the active layout's highlight, so the rail
/// keeps the expanded rows' look in every sidebar layout.
fn rail_row(
    key: &str,
    state: RowState,
    font: &FontConfig,
    look: SidebarLook,
    theme: &Theme,
) -> Div {
    look.mark(
        div()
            .relative()
            .flex_none()
            .h(px(look.row_height(line_height(font).max(HOST_MARK))))
            .flex()
            .items_center()
            .justify_center()
            .overflow_hidden(),
        key,
        state,
        theme,
    )
}

fn rail_button(
    id: &'static str,
    font: &FontConfig,
    look: SidebarLook,
    theme: &Theme,
) -> Stateful<Div> {
    rail_row(id, RowState::default(), font, look, theme)
        .id(id)
        .debug_selector(move || id.into())
        .cursor_pointer()
}

/// The indicator centered on its line, whichever style draws it.
fn indicator(status: AgentStatus, font: &FontConfig, indicators: Indicators) -> Div {
    div()
        .flex_none()
        .h(px(line_height(font)))
        .child(status_indicator(status, font, indicators))
}

/// The host's initial, as Herdr marks a machine in its rail.
pub(super) fn host_initial(label: &str) -> String {
    label
        .trim()
        .chars()
        .next()
        .map_or_else(|| "?".into(), |initial| initial.to_uppercase().collect())
}

/// The status word a tooltip names, none for an unknown status.
fn status_word(status: AgentStatus) -> Option<&'static str> {
    (status != AgentStatus::Unknown).then(|| status_text(status))
}

/// An agent's status word: its integration's state label when it set one.
fn agent_status_word(agent: &ClientShellAgent) -> Option<Cow<'static, str>> {
    let word = state_label(agent, status_word(agent.agent_status).unwrap_or(""));
    (!word.is_empty()).then_some(word)
}

/// A rail mark's tooltip: what the expanded row would have spelled out.
/// `status` is the word for the mark's status: an agent's own state label
/// when its integration set one.
pub(super) fn describe(
    host: Option<&str>,
    name: &str,
    place: Option<&str>,
    status: Option<&str>,
) -> SharedString {
    let mut text = String::new();
    if let Some(host) = host {
        text.push_str(host);
        text.push_str(": ");
    }
    text.push_str(name);
    if let Some(place) = place {
        text.push_str(" in ");
        text.push_str(place);
    }
    if let Some(status) = status {
        text.push_str(" (");
        text.push_str(status);
        text.push(')');
    }
    text.into()
}

#[derive(Clone, Copy)]
struct Hint {
    foreground: u32,
    surface: u32,
}

impl Hint {
    fn new(theme: &Theme) -> Self {
        Self {
            foreground: theme.foreground,
            surface: theme.surface,
        }
    }

    fn with(
        self,
        text: impl Into<SharedString>,
    ) -> impl Fn(&mut Window, &mut App) -> AnyView + 'static {
        let text = text.into();
        move |_, cx| {
            cx.new(|_| crate::usage::Hint {
                text: text.clone(),
                foreground: self.foreground,
                surface: self.surface,
            })
            .into()
        }
    }
}

#[cfg(test)]
mod tests;
