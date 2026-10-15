//! Session navigation, matching the TUI shell. Windows belong to the workspace strip.
#[path = "sidebar/control_focus.rs"]
mod control_focus;
#[path = "sidebar/footer.rs"]
mod footer;
#[path = "sidebar/hierarchy.rs"]
mod hierarchy;
#[path = "sidebar/keyboard.rs"]
mod keyboard;
#[path = "sidebar/reveal.rs"]
mod reveal;
use crate::{config::Theme, tmux_snapshot::browser};
use gpui::{prelude::*, *};
pub(in crate::tmux_snapshot) use keyboard::Keyboard;
pub(super) use keyboard::focus_shortcut;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(in crate::tmux_snapshot) enum Target {
    FleetAgent {
        scope: u64,
        revision: u64,
        key: String,
    },
    Session(String),
    FleetSession {
        machine: String,
        id: String,
        session: String,
        server: Option<(String, String)>,
        selection: String,
    },
    FleetServer {
        machine: String,
        id: String,
        generation: String,
        selection: String,
    },
    Collapse {
        machine: String,
        revision: u64,
        action: String,
        enabled: bool,
    },
    Pane {
        session: String,
        id: String,
    },
}
#[derive(Debug)]
pub(in crate::tmux_snapshot) struct Row {
    pub label: String,
    pub pane_count: Option<String>,
    pub selected: bool,
    pub target: Option<Target>,
    pub depth: u8,
    pub machine: Option<String>,
    pub agent: Option<String>,
    pub icon: Option<&'static str>,
    pub favorite: Option<(Option<String>, bool)>,
}
pub(super) fn rows(state: &browser::State) -> Vec<Row> {
    if let Some(fleet) = &state.fleet {
        return hierarchy::rows(state, fleet);
    }
    state
        .sessions
        .iter()
        .map(|session| Row {
            label: session.label.clone(),
            pane_count: session.pane_count_label(),
            selected: state.selected_session.as_ref() == Some(&session.id),
            target: Some(Target::Session(session.id.clone())),
            depth: 0,
            machine: None,
            agent: None,
            icon: Some("icons/terminal.svg"),
            favorite: None,
        })
        .collect()
}

pub(super) fn current(state: &browser::State, target: &Target) -> bool {
    match target {
        Target::FleetAgent { .. }
        | Target::FleetSession { .. }
        | Target::FleetServer { .. }
        | Target::Collapse { .. } => rows(state)
            .iter()
            .any(|r| r.target.as_ref() == Some(target)),
        Target::Session(id) => state.sessions.iter().any(|s| &s.id == id),
        Target::Pane { session, id } => {
            state.selected_session.as_ref() == Some(session)
                && state.sessions.iter().any(|s| &s.id == session)
                && state.panes.iter().any(|p| &p.id == id)
        }
    }
}
#[cfg(test)]
#[path = "sidebar/tests.rs"]
mod tests;

/// Adapt Herdr sidebar/row.rs::row_text and sidebar/layout.rs::highlight's
/// fill treatment. Keep one label renderer and fixed gutters; visual selection
/// describes the catalog only and never grants input authority.
pub(super) fn render_row(
    index: usize,
    row: &Row,
    theme: &Theme,
    _accent: u32,
    _glass: bool,
) -> Stateful<Div> {
    let active = theme.active;
    let mut element = div()
        .id(("sidebar-row", index))
        .debug_selector(move || format!("tmux-sidebar-row-{index}"))
        .relative()
        .flex()
        .items_center()
        .gap(px(6.))
        .pl(px(8. + f32::from(row.depth) * 10.))
        .pr_2()
        .py_1()
        .rounded(px(4.))
        .min_w_0()
        .flex_shrink_0()
        .overflow_hidden()
        .bg(if row.selected {
            rgb(theme.active)
        } else {
            rgba(0)
        })
        .text_color(rgb(theme.foreground))
        .font_weight(if row.selected || row.machine.is_some() {
            FontWeight::SEMIBOLD
        } else {
            FontWeight::NORMAL
        })
        .child(
            div()
                .debug_selector(move || format!("tmux-sidebar-mark-{index}"))
                .w(px(2.))
                .h(px(12.))
                .flex_none()
                .rounded(px(1.))
                .when(row.selected, |mark| mark.bg(rgb(theme.foreground))),
        )
        .children(row.icon.map(|path| {
            svg()
                .path(path)
                .size(px(14.))
                .flex_none()
                .text_color(rgb(theme.muted))
        }))
        .child(
            div()
                .debug_selector(move || format!("tmux-sidebar-label-{index}"))
                .flex_1()
                .min_w_0()
                .flex()
                .flex_col()
                .overflow_hidden()
                .child(
                    div()
                        .min_w_0()
                        .truncate()
                        .child(crate::sidebar::label_text(&row.label)),
                )
                .children(row.pane_count.as_ref().map(|count| {
                    div()
                        .debug_selector(move || format!("tmux-sidebar-count-{index}"))
                        .min_w_0()
                        .truncate()
                        .text_sm()
                        .font_weight(FontWeight::NORMAL)
                        .text_color(rgb(theme.muted))
                        .child(count.clone())
                })),
        );
    // The unselected row stays transparent: the sidebar owns its glass tint.
    if row.target.is_some() {
        element = element
            .cursor_pointer()
            .hover(move |style| style.bg(rgb(active)));
    }
    element
}
