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
#[path = "sidebar/pane_row.rs"]
mod pane_row;
#[path = "sidebar/panes.rs"]
pub(in crate::tmux_snapshot) mod panes;
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
    Pane {
        session: String,
        id: String,
    },
}
/// How a row reads in the sidebar (#746): a project's heading, a window's
/// subheading inside the open project, or an item (a pane, an agent).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(in crate::tmux_snapshot) enum Kind {
    Heading,
    Window,
    #[default]
    Item,
}
#[derive(Debug, Default)]
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
    pub kind: Kind,
    /// A heading's project favicon.
    pub favicon: Option<std::sync::Arc<Image>>,
    /// A heading's muted aside, the machine of a remote session.
    pub aside: Option<String>,
    /// A pane row's pane: its agent state and its menu.
    pub pane: Option<String>,
}
pub(super) fn rows(state: &browser::State) -> Vec<Row> {
    if let Some(fleet) = &state.fleet {
        return hierarchy::rows(state, fleet);
    }
    let mut out = Vec::new();
    for session in &state.sessions {
        let open = state.selected_session.as_ref() == Some(&session.id);
        out.push(Row {
            label: session.label.clone(),
            selected: open,
            target: Some(Target::Session(session.id.clone())),
            kind: Kind::Heading,
            ..Row::default()
        });
        if open && state.surface == browser::Surface::Workspace {
            out.extend(panes::rows(state, 0));
        }
    }
    out
}

pub(super) fn current(state: &browser::State, target: &Target) -> bool {
    match target {
        Target::FleetAgent { .. } | Target::FleetSession { .. } => rows(state)
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
#[cfg(test)]
#[path = "sidebar/text_role_tests.rs"]
mod text_role_tests;

/// The attention count: Bezel's badge, filled as it was before Bezel, since
/// the count is what asks for the user and should stand out of the row
/// rather than outline. Its count is inked on the pill.
fn attention_badge(theme: &Theme, bezel: &bezel_theme::Theme, count: usize, index: usize) -> Div {
    use bezel_ui::widgets::Content as _;
    bezel
        .badge(count.to_string())
        .bg(rgb(theme.active))
        .border_color(rgb(theme.active))
        .text_color(rgb(crate::tmux_snapshot::design::badge_text(theme)))
        .children(crate::tmux_snapshot::design::ink_probe(move || {
            format!("sidebar-badge-{index}")
        }))
}

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
    use bezel_theme::{TextStyle, Typeset as _};
    use bezel_ui::widgets::Icons as _;
    // Text on the frosted chrome keeps 4.5:1 whatever the desktop behind it.
    // Ink that reads on the row's own fill (selected or hovered) as well as
    // on the frosted chrome, whatever the desktop behind it.
    let (label, muted) = crate::tmux_snapshot::design::row_ink(theme);
    let heading = row.kind == Kind::Heading;
    let window = row.kind == Kind::Window;
    let session = !heading
        && !window
        && (matches!(
            row.target,
            Some(Target::Session(_) | Target::FleetSession { .. })
        ) || row.favorite.is_some());
    let role = if heading || window {
        TextStyle::Subheadline
    } else if session || row.pane.is_some() {
        TextStyle::Callout
    } else {
        TextStyle::Subheadline
    };
    let selection = bezel_theme::Selection::new(row.selected && !heading, emphasized);
    let fade = bezel_motion::Fade::new(painter, format!("sidebar-row-{index}"));
    let indent = bezel_theme::Theme::SPACE + f32::from(row.depth) * 6.;
    let mut element = div()
        .id(("sidebar-row", index))
        .debug_selector(move || format!("tmux-sidebar-row-{index}"))
        .relative()
        .group("session-sidebar-row")
        .flex()
        .items_center()
        .gap(px(if row.pane.is_some() { 8. } else { 6. }))
        // A window subheading lines up with the pane labels under it.
        .pl(px(if window { indent + 28. } else { indent }))
        .pr_2()
        .py(px(if session || row.pane.is_some() {
            5.
        } else {
            3.
        }))
        .when(heading, |h| h.mt(px(10.)))
        .rounded(px(bezel_theme::Theme::control_radius()))
        .min_w_0()
        .flex_shrink_0()
        .overflow_hidden()
        .text_color(rgb(if heading || window { muted } else { label }))
        // The ladder's sizes at gpui's own leading, which the rows' heights
        // are laid out on.
        .text_style(role)
        .when(window, |w| w.text_style(TextStyle::Caption))
        .line_height(phi())
        .font_weight(if heading {
            FontWeight::MEDIUM
        } else if row.selected || row.machine.is_some() {
            FontWeight::SEMIBOLD
        } else {
            FontWeight::NORMAL
        })
        .children(row.favicon.clone().map(|image| {
            img(image)
                .debug_selector(move || format!("tmux-sidebar-favicon-{index}"))
                .flex_none()
                .size(px(12.))
                .rounded(px(3.))
        }))
        .children(
            row.icon
                .filter(|_| !session && !heading && !window)
                .map(|path| {
                    let icon = bezel
                        .icon_at(
                            if row.pane.is_some() {
                                TextStyle::Callout
                            } else {
                                TextStyle::Body
                            },
                            bezel_ui::icons::Icon::asset(path),
                        )
                        .flex_none()
                        .text_color(rgb(if row.selected { label } else { muted }));
                    if row.pane.is_some() {
                        // A pane's kind sits on a small tile, as in the mockup.
                        div()
                            .flex_none()
                            .size(px(20.))
                            .rounded(px(bezel_theme::Theme::control_radius()))
                            .border_1()
                            .border_color(bezel.border)
                            .flex()
                            .items_center()
                            .justify_center()
                            .child(icon)
                            .into_any_element()
                    } else {
                        icon.into_any_element()
                    }
                }),
        )
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
                        .child(crate::sidebar::label_text(&row.label))
                        .children(row.aside.as_ref().map(|aside| {
                            div()
                                .flex_none()
                                .font_weight(FontWeight::NORMAL)
                                .child(format!(" · {aside}"))
                        }))
                        .when(row.aside.is_some(), |l| l.flex().flex_row())
                        .children(crate::tmux_snapshot::design::ink_probe(move || {
                            format!("sidebar-label-{index}")
                        })),
                )
                .children(row.summary.as_ref().filter(|_| !heading).map(|summary| {
                    div()
                        .mt(px(3.))
                        .min_w_0()
                        .max_h(px(32.))
                        .overflow_hidden()
                        .text_style(TextStyle::Subheadline)
                        .line_height(px(16.))
                        .text_color(rgb(muted))
                        .child(summary.clone())
                        .children(crate::tmux_snapshot::design::ink_probe(move || {
                            format!("sidebar-summary-{index}")
                        }))
                }))
                .children(row.pane_count.as_ref().map(|count| {
                    div()
                        .debug_selector(move || format!("tmux-sidebar-count-{index}"))
                        .min_w_0()
                        .truncate()
                        .text_style(TextStyle::Caption)
                        .line_height(phi())
                        .mt(px(2.))
                        .text_color(rgb(muted))
                        .child(count.clone())
                        .children(crate::tmux_snapshot::design::ink_probe(move || {
                            format!("sidebar-count-{index}")
                        }))
                })),
        );
    if row.attention > 0 && !heading {
        element = element.child(
            attention_badge(theme, bezel, row.attention, index)
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
