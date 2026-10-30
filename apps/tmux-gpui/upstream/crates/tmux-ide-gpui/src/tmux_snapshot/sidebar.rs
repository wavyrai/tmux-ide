//! Session navigation, matching the TUI shell. Windows belong to the workspace strip.
#[path = "sidebar/activity.rs"]
mod activity;
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
    pub summary: Option<String>,
    pub attention: usize,
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
            summary: None,
            attention: 0,
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
#[path = "sidebar/row_style_tests.rs"]
mod row_style_tests;
#[cfg(test)]
#[path = "sidebar/tests.rs"]
mod tests;

/// One sidebar row on Bezel's nav-row recipe (`widgets::Layout::nav_row`):
/// the selected row takes `Selection`'s fill and shadow (emphasized while the
/// sidebar holds the keyboard), an unselected row fades in
/// `element_hover` under the pointer, at `control_radius`. Bezel's `nav_row`
/// itself draws a single truncated label; these rows also carry the painted
/// label probe, a count line and badges, so they are composed from the same
/// parts. Visual selection describes the catalog only and never grants input
/// authority.
pub(super) fn render_row(
    index: usize,
    row: &Row,
    theme: &Theme,
    bezel: &bezel_theme::Theme,
    painter: bezel_motion::Painter,
    emphasized: bool,
) -> Stateful<Div> {
    use bezel_ui::widgets::Content as _;
    // Text on the frosted chrome keeps 4.5:1 whatever the desktop behind it.
    // Ink that reads on the row's own fill (selected or hovered) as well as
    // on the frosted chrome, whatever the desktop behind it.
    let (label, muted) = crate::tmux_snapshot::design::row_ink(theme);
    let session = matches!(
        row.target,
        Some(Target::Session(_) | Target::FleetSession { .. })
    ) || row.favorite.is_some();
    let selection = bezel_theme::Selection::new(row.selected, emphasized);
    let fade = bezel_motion::Fade::new(painter, format!("sidebar-row-{index}"));
    let mut element = div()
        .id(("sidebar-row", index))
        .debug_selector(move || format!("tmux-sidebar-row-{index}"))
        .relative()
        .group("session-sidebar-row")
        .flex()
        .items_center()
        .gap(px(6.))
        .pl(px(8. + f32::from(row.depth) * 6.))
        .pr_2()
        .py(px(if session { 5. } else { 3. }))
        .rounded(px(bezel_theme::Theme::control_radius()))
        .min_w_0()
        .flex_shrink_0()
        .overflow_hidden()
        .text_color(rgb(label))
        .text_size(px(if session { 12. } else { 11. }))
        .font_weight(if row.selected || row.machine.is_some() {
            FontWeight::SEMIBOLD
        } else {
            FontWeight::NORMAL
        })
        .children(row.icon.filter(|_| !session).map(|path| {
            svg()
                .path(path)
                .size(px(14.))
                .flex_none()
                .text_color(rgb(if row.selected { label } else { muted }))
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
                .children(row.summary.as_ref().map(|summary| {
                    div()
                        .mt(px(3.))
                        .min_w_0()
                        .max_h(px(32.))
                        .overflow_hidden()
                        .text_size(px(11.))
                        .line_height(px(16.))
                        .font_weight(FontWeight::NORMAL)
                        .text_color(rgb(muted))
                        .child(summary.clone())
                }))
                .children(row.pane_count.as_ref().map(|count| {
                    div()
                        .debug_selector(move || format!("tmux-sidebar-count-{index}"))
                        .min_w_0()
                        .truncate()
                        .text_size(px(10.))
                        .mt(px(2.))
                        .font_weight(FontWeight::NORMAL)
                        .text_color(rgb(muted))
                        .child(count.clone())
                })),
        );
    if row.attention > 0 {
        element = element.child(
            bezel
                .badge(row.attention.to_string())
                // Filled, as it was before Bezel: the count is what asks for
                // the user, so it stands out of the row rather than outlining.
                .bg(rgb(theme.active))
                .border_color(rgb(theme.active))
                .text_color(rgb(crate::tmux_snapshot::design::badge_text(theme)))
                .debug_selector(move || format!("tmux-sidebar-attention-{index}")),
        );
    }
    match selection.fill(bezel) {
        Some(fill) => element.bg(fill).shadow(selection.shadows()),
        None if row.target.is_some() => {
            element = element.cursor_pointer().bg(bezel_motion::hover_blend(
                &fade,
                bezel.ink(0.0),
                bezel.element_hover,
            ));
            element
                .interactivity()
                .on_hover(bezel_motion::hover_listener(fade));
            element
        }
        None => element,
    }
}
