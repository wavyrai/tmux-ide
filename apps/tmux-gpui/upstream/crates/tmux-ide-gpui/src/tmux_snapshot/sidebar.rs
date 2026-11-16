//! Session navigation, matching the TUI shell. Windows belong to the workspace strip.
#[path = "sidebar/activity.rs"]
pub(in crate::tmux_snapshot) mod activity;
#[path = "sidebar/control_focus.rs"]
mod control_focus;
#[path = "sidebar/footer.rs"]
mod footer;
#[path = "sidebar/hierarchy.rs"]
mod hierarchy;
#[path = "sidebar/keyboard.rs"]
mod keyboard;
#[path = "sidebar/pane_row.rs"]
pub(in crate::tmux_snapshot) mod pane_row;
#[path = "sidebar/panes.rs"]
pub(in crate::tmux_snapshot) mod panes;
#[path = "sidebar/reveal.rs"]
mod reveal;
use crate::{config::Theme, tmux_snapshot::browser};
pub(in crate::tmux_snapshot) use footer::height as footer_height;
use gpui::{prelude::*, *};
pub(in crate::tmux_snapshot) use keyboard::Keyboard;
pub(super) use keyboard::focus_shortcut;

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(in crate::tmux_snapshot) enum Target {
    /// The sidebar's Home row (#746).
    Home,
    /// An agent on Home's roster, under its project (#746).
    HomeAgent {
        revision: u64,
        key: String,
    },
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
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
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
    /// Listed from a remote machine that is away (r4): muted ink.
    pub away: bool,
    /// Its agent state may be old (#362): this Mac's agent lane is paused for
    /// a drop that showed its words, or the machine is away. The badge and
    /// the spoken label say "last known".
    pub last_known: bool,
}
pub(in crate::tmux_snapshot) fn rows(state: &browser::State) -> Vec<Row> {
    rows_at(state, std::time::Instant::now())
}
/// The rows as of `now`: a remote machine that is away reads as before for
/// 8 s, as the footer slot does, and then as away (r4).
pub(in crate::tmux_snapshot) fn rows_at(
    state: &browser::State,
    now: std::time::Instant,
) -> Vec<Row> {
    if let Some(fleet) = &state.fleet {
        return hierarchy::rows(state, fleet, now);
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
        Target::FleetAgent { .. } | Target::FleetSession { .. } | Target::HomeAgent { .. } => {
            rows(state)
                .iter()
                .any(|r| r.target.as_ref() == Some(target))
        }
        Target::Home => true,
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
/// A pane row's kind tile (#746 v3): 18 pt, radius 5, its icon 11 pt.
pub(super) const TILE: f32 = 18.;
const TILE_RADIUS: f32 = 5.;
const TILE_ICON: f32 = 11.;
/// A project heading's slot (#746 v3).
pub(super) const HEADING_SLOT: f32 = 26.;
/// How many agents wait on the user, as the "needs input" pill (#746).
fn attention_badge(theme: &Theme, count: usize, index: usize, last_known: bool) -> Div {
    // A count that may be old stays loud, as needs-input does, and says so.
    let words = if last_known {
        format!(
            "{count} · {}",
            crate::tmux_snapshot::agent_indicator::LAST_KNOWN
        )
    } else {
        count.to_string()
    };
    crate::tmux_snapshot::agent_indicator::attention_pill(
        theme,
        crate::tmux_snapshot::agent_indicator::Plate::Sidebar,
        words.clone(),
    )
    .children(crate::tmux_snapshot::design::ink_probe(move || {
        format!("sidebar-badge-{index}")
    }))
    .children(crate::tmux_snapshot::design::text_probe(
        move || format!("sidebar-badge-{index}"),
        words,
    ))
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
    // A pane, or an agent under its project, sits on a kind tile, indented
    // past the project's heading as in the mockup (#746).
    let tiled = !heading && !window && !session && (row.pane.is_some() || row.agent.is_some());
    let role = if heading || window {
        TextStyle::Subheadline
    } else if tiled {
        // A pane's label reads at Body, as in the mockup (#746).
        TextStyle::Body
    } else if session {
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
        .gap(px(if tiled { 8. } else { 6. }))
        // A window subheading lines up with the pane labels under it.
        .pl(px(if window { indent + 28. } else { indent }))
        .pr_2()
        .py(px(if session || tiled { 5. } else { 3. }))
        // A project's heading (#746 v3): a 26 pt slot, 12 pt below the
        // group above (the list's 2 pt gap included).
        .when(heading, |h| h.py_0().min_h(px(HEADING_SLOT)).mt(px(10.)))
        // A pane row is the mockup's 30 pt whatever Body's leading.
        .when(tiled, |r| r.py_0().h(px(30.)))
        // A row, selected or hovered, is a full capsule (#746 v3).
        .rounded_full()
        .min_w_0()
        .flex_shrink_0()
        .overflow_hidden()
        // Three inks (#746 v3): the full text only on the selection, the
        // middle label ink on other rows, muted on headings.
        // An away machine's rows (r4) take the muted ink too.
        .text_color(rgb(if heading || window || row.away {
            muted
        } else if row.selected {
            label
        } else {
            crate::tmux_snapshot::design::row_label(theme)
        }))
        // The ladder's sizes at gpui's own leading, which the rows' heights
        // are laid out on.
        .text_style(role)
        .when(window, |w| w.text_style(TextStyle::Caption))
        .line_height(phi())
        .font_weight(if heading {
            FontWeight::MEDIUM
        } else if row.selected {
            // The mockup's selected row (#746): medium, not semibold.
            FontWeight::MEDIUM
        } else if row.machine.is_some() {
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
        // A heading without a favicon: the terminal glyph at the favicon's
        // size, so every project has a tile (#746).
        .children(
            row.icon
                .filter(|_| heading && row.favicon.is_none())
                .map(|path| {
                    bezel
                        .icon_at(TextStyle::Caption, bezel_ui::icons::Icon::asset(path))
                        .debug_selector(move || format!("tmux-sidebar-glyph-{index}"))
                        .flex_none()
                        .size(px(12.))
                        .text_color(rgb(muted))
                }),
        )
        .children(
            row.icon
                .filter(|_| !session && !heading && !window)
                .map(|path| {
                    let icon = bezel
                        .icon_at(
                            if tiled {
                                TextStyle::Callout
                            } else {
                                TextStyle::Body
                            },
                            bezel_ui::icons::Icon::asset(path),
                        )
                        .flex_none()
                        .when(tiled, |icon| icon.size(px(TILE_ICON)))
                        .text_color(rgb(if row.selected { label } else { muted }));
                    if tiled {
                        // A pane's or agent's kind sits on a small tile, as in
                        // the mockup.
                        div()
                            .debug_selector(move || format!("tmux-sidebar-tile-{index}"))
                            .flex_none()
                            .size(px(TILE))
                            .rounded(px(TILE_RADIUS))
                            .border_1()
                            .border_color(bezel.border)
                            // Filled with the terminal's background, so the
                            // tile reads as a small card on the plate (#746 v3).
                            .bg(bezel.terminal_bg)
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
            attention_badge(theme, row.attention, index, row.last_known)
                .debug_selector(move || format!("tmux-sidebar-attention-{index}")),
        );
    }
    match selection
        .is_selected()
        .then(|| crate::tmux_snapshot::design::selected_capsule(theme))
    {
        Some((fill, ring)) => element.bg(fill).shadow(ring),
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
