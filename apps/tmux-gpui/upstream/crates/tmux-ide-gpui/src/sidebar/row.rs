//! One sidebar row: its icon, tree guides, badges, and the label budget that
//! decides what still fits. Text is elided against measured glyph widths, not
//! guessed, so a long label cannot overflow the row it was laid out in.

#[cfg(any(test, feature = "integration-test"))]
use super::layout_tests;
use super::{
    ARROW_RESERVE, ICON_RESERVE, STATUS_WIDTH,
    agents::{Indicators, status_indicator},
    cell::{RowContext, RowState},
    glyph_width, line_height, segment_budgets,
    tokens::ResolvedToken,
};
use crate::config::{FontConfig, Theme};
use gpui::{prelude::*, *};
use herdr_client::protocol::AgentStatus;
use std::sync::Arc;
use unicode_width::UnicodeWidthStr;

mod badge;
mod configured;

pub(crate) use badge::compact;
pub(super) use badge::{PrBadge, RowBadge, Upstream};
use configured::configured_lines;
pub(super) use configured::{
    TokenLook, configured_status, configured_status_style, leading_status, token_column,
};

/// What a row shows in its leading icon slot: a repository owner's avatar when
/// one is cached, the GitHub mark while it is not, and nothing for the child
/// rows that reserve no slot at all.
pub(super) enum RowIcon {
    None,
    Mark,
    Avatar(Arc<Image>),
}

impl RowIcon {
    fn slot(self, key: &str, font: &FontConfig, color: u32) -> Div {
        div()
            .debug_selector(|| format!("github-{key}"))
            .absolute()
            .left_0()
            .top(px((line_height(font) - 12.) / 2.))
            .size(px(12.))
            .flex_none()
            .overflow_hidden()
            .child(self.element(color))
    }

    /// The icon filling its parent, or nothing for rows without one. An
    /// avatar still loading or failing to decode shows the mark instead.
    pub(super) fn element(self, color: u32) -> AnyElement {
        match self {
            Self::None => Empty.into_any_element(),
            Self::Mark => github_mark(color).size_full().into_any_element(),
            Self::Avatar(image) => img(image)
                .size_full()
                .rounded_full()
                .with_fallback(move || github_mark(color).size_full().into_any_element())
                .with_loading(move || github_mark(color).size_full().into_any_element())
                .into_any_element(),
        }
    }
}

/// The mark paints as vector rather than a rasterized image, so it stays sharp
/// at every size it stands in for an avatar.
pub(crate) fn github_mark(color: u32) -> Svg {
    svg()
        .path("icons/github.svg")
        .flex_none()
        .text_color(rgb(color))
}
/// What a row lists, which decides how its two lines are weighted: upstream
/// keeps agent names bold throughout and reserves bold workspaces for the
/// current one, with the branch picking up the accent while it is focused.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum RowKind {
    Workspace,
    Agent(crate::icons::AgentIcon),
}

/// Name color, name weight, and detail color for a row.
pub(super) fn row_text(kind: RowKind, focused: bool, theme: &Theme) -> (u32, FontWeight, u32) {
    let weight = if focused || matches!(kind, RowKind::Agent(_)) {
        FontWeight::BOLD
    } else {
        FontWeight::NORMAL
    };
    let name = if focused {
        theme.foreground
    } else {
        theme.subtext()
    };
    let detail = if focused && kind == RowKind::Workspace {
        theme.primary()
    } else {
        theme.muted
    };
    (name, weight, detail)
}

/// A teleported checkout's name: its work lives on another host now, so the
/// name fades toward the background to read as the copy not to use. The fade
/// stops at the standard mark contrast even when high contrast is on: high
/// contrast already lifts dim labels to its own floor, so honoring it here
/// would leave the fade invisible, and the teleport icon beside the name
/// keeps the meaning readable.
pub(super) fn left_behind(color: u32, theme: &Theme) -> u32 {
    crate::contrast::ink_on_chrome(
        crate::config::mix(theme.background, color, 45),
        [theme.background, theme.sidebar_background(), theme.active],
        crate::contrast::Contrast::Standard.mark_ratio(),
    )
}

/// Where a row stands while a workspace is dragged: rows the lifted card
/// passes over stop answering hover, so only the drop line marks a place.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(super) enum RowLift {
    #[default]
    Resting,
    Passed,
    Lifted,
}

/// Where a row sits in its worktree group, which decides whether the gutter
/// carries a trunk through the row or ends in an elbow.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum RowTree {
    None,
    Child,
    LastChild,
}

/// Trunk and tick for a child row, given the gutter the row reserves between
/// the parent's label column and the child's status dot. Snapped to whole
/// device pixels and painted as quads rather than borders: a bordered box
/// rounds each edge on its own, which left the trunk thinner than its tick.
pub(super) fn tree_lines(
    gutter: Bounds<Pixels>,
    tree: RowTree,
    font: &FontConfig,
    padding: f32,
    scale: f32,
) -> [Bounds<Pixels>; 2] {
    let device = |value: Pixels| f32::from(value) * scale;
    let logical = |value: f32| px(value / scale);
    let weight = scale.round().max(1.);
    let snap = |value: Pixels| logical(device(value).round());
    // The trunk runs down the gutter's leading edge; the tick crosses it at the
    // status dot's middle row and stops where the dot begins.
    let x = snap(gutter.origin.x);
    let middle = logical(
        (device(gutter.origin.y + px(padding + line_height(font) / 2.)) - weight / 2.).round(),
    );
    let end = if tree == RowTree::LastChild {
        middle + logical(weight)
    } else {
        snap(gutter.bottom())
    };
    [
        Bounds::from_corners(
            point(x, snap(gutter.origin.y)),
            point(x + logical(weight), end),
        ),
        Bounds::from_corners(
            point(x, middle),
            point(snap(gutter.right()), middle + logical(weight)),
        ),
    ]
}

/// A row's first line: segments joined by upstream's separator, the primary one
/// carrying the row's weight and color while the rest stay muted. Segments are
/// placed at measured offsets rather than flexed, because GPUI 0.2.2 only
/// ellipsizes text whose width its parent already fixed.
pub(super) fn name_line(
    segments: &[(&str, bool)],
    appearance: (u32, FontWeight, u32),
    width: f32,
    font: &FontConfig,
) -> Div {
    let (primary, weight, muted) = appearance;
    let glyph = glyph_width(font);
    let separator = 3. * glyph;
    let separators = segments.len().saturating_sub(1);
    let lengths: Vec<usize> = segments.iter().map(|(text, _)| text.width()).collect();
    let available = (width - separators as f32 * separator).max(0.);
    let budgets = segment_budgets(&lengths, (available / glyph).floor() as usize);
    // The last segment takes the rounding remainder, so one segment fills the
    // line exactly as it did before a line could carry several.
    let used: f32 = budgets.iter().map(|budget| *budget as f32 * glyph).sum();
    let slack = (available - used).max(0.);
    let parts =
        segments
            .iter()
            .zip(budgets)
            .enumerate()
            .map(|(index, ((text, is_primary), budget))| {
                let advance = budget as f32 * glyph
                    + if index + 1 == segments.len() {
                        slack
                    } else {
                        0.
                    };
                let cell = div()
                    .truncate()
                    .when(*is_primary, |part| {
                        part.font_weight(weight).text_color(rgb(primary))
                    })
                    .when(!*is_primary, |part| part.text_color(rgb(muted)))
                    .child(label_text(text));
                (if index == 0 { "" } else { " · " }, advance, cell)
            });
    place_line(parts, width, font, muted)
}

fn place_line(
    parts: impl IntoIterator<Item = (&'static str, f32, Div)>,
    width: f32,
    font: &FontConfig,
    muted: u32,
) -> Div {
    let mut line = div()
        .relative()
        .w(px(width))
        .h(px(line_height(font)))
        .flex_none()
        .overflow_hidden();
    let mut x = 0.;
    for (separator, advance, cell) in parts {
        if !separator.is_empty() {
            let gap = separator.chars().count() as f32 * glyph_width(font);
            line = line.child(
                div()
                    .absolute()
                    .left(px(x))
                    .w(px(gap))
                    .text_color(rgb(muted))
                    .child(label_text(separator)),
            );
            x += gap;
        }
        line = line.child(cell.absolute().left(px(x)).w(px(advance)));
        x += advance;
    }
    line
}

pub(super) fn removing_dot(selector: &'static str, theme: &Theme) -> Div {
    div()
        .debug_selector(move || selector.into())
        .size(px(STATUS_WIDTH))
        .flex_none()
        .child(
            div()
                .size_full()
                .rounded_full()
                .bg(rgb(theme.primary()))
                .with_animation(
                    SharedString::from(format!("{selector}-pulse")),
                    Animation::new(std::time::Duration::from_secs(1)).repeat(),
                    |dot, delta| dot.opacity(0.3 + 0.7 * (delta * std::f32::consts::PI).sin()),
                ),
        )
}

#[allow(clippy::too_many_arguments)]
pub(super) fn row(
    // Rows are probed by key, not by label: an agent names its workspace, which
    // already names a row of its own.
    key: &str,
    name: &[(&str, bool)],
    detail: &str,
    kind: RowKind,
    status: AgentStatus,
    indicators: Indicators,
    removing: bool,
    state: RowState,
    tree: RowTree,
    reserve_arrow: bool,
    workspace_icon: RowIcon,
    arrow: Option<Stateful<Div>>,
    badge: Option<RowBadge>,
    upstream: Option<Upstream>,
    // The status word the daemon's `state_text` token asks to show, when its
    // sidebar config names it. Painted at the row's trailing edge in the dot's
    // color so a status reads at a glance, not only by hue.
    status_text: Option<&str>,
    lines: &[Vec<ResolvedToken>],
    cx: &RowContext<'_>,
) -> Div {
    let (font, theme, look, width) = (cx.font, cx.theme, cx.look, cx.width);
    let focused = state.selected;
    let layout = look.density;
    let configured = !lines.is_empty();
    let teleported = badge.as_ref().is_some_and(|badge| badge.teleported);
    let leading_icon = leading_status(lines);
    let show_status = !configured || leading_icon.is_some() || removing;
    let status_text = status_text.filter(|_| !configured);
    let text_lines = if configured {
        let badge_lines = badge.as_ref().map_or(0, |badge| badge.lines(&layout));
        lines.len().max(badge_lines)
    } else {
        0
    };
    let padding = layout.padding();
    let content_x = look.content_x();
    let gap = layout.gap();
    let vertical_padding = look.row_padding();
    // Content starts below the highlight's edge, which sits half the row
    // spacing in from the row's own.
    let content_top = vertical_padding + look.spacing() / 2.;
    let show_detail = matches!(kind, RowKind::Agent(_))
        || if tree == RowTree::None {
            layout.workspace_details()
        } else {
            layout.child_details()
        };
    let (name_color, weight, detail_color) = row_text(kind, focused, theme);
    let name_color = if teleported {
        left_behind(name_color, theme)
    } else {
        name_color
    };
    let icon_reserve = match workspace_icon {
        RowIcon::None => 0.,
        _ => ICON_RESERVE,
    };
    let muted = theme.muted;
    let status_width = indicators.width(font);
    let extra_status_width = status_width - STATUS_WIDTH;
    let indent = cx.nest
        + if tree == RowTree::None {
            0.
        } else {
            layout.child_indent() + extra_status_width
        };
    // Room for tree lines between the parent's label column and this row's own
    // dot: `child_indent - STATUS_WIDTH - gap`. A configured indent or gap can
    // leave none, and then no lines are drawn rather than a box of negative width.
    let tree_width = padding + indent - cx.nest - layout.tree_gutter() - extra_status_width;
    let draw_tree = tree != RowTree::None && look.density.tree_lines && tree_width > 0.;
    let arrow_reserve = if reserve_arrow { ARROW_RESERVE } else { 0. };
    let arrow_absent = arrow.is_none();
    let status_gutter = if show_status { status_width + gap } else { 0. };
    let available = (look.content_width(width) - status_gutter - indent - arrow_reserve).max(0.);
    // Narrow sidebars and large fonts can leave less room than a badge needs.
    // Clip its column within the row rather than painting over the terminal.
    let badge_width = badge.as_ref().map_or(0., |badge| {
        badge.width(font, &layout).min((available - gap).max(0.))
    });
    let pr_reserve = if badge.is_some() {
        badge_width + gap
    } else {
        0.
    };
    // The status word keeps its own trailing column, so the label yields to it
    // the same way it yields to a badge, and like the badge it is clipped to
    // the room left rather than painting past the row.
    let status_width = status_text.map_or(0., |text| {
        (text.width() as f32 * glyph_width(font))
            .ceil()
            .min((available - pr_reserve - gap).max(0.))
    });
    let status_reserve = if status_text.is_some() {
        status_width + gap
    } else {
        0.
    };
    let status_color = indicators.color(status);
    let glyph = glyph_width(font);
    // A workspace's second line carries the counts after its branch, as the
    // TUI does. A one-line row has no branch line, so a trailing column keeps
    // them visible in compact densities and on worktree children.
    // Configured rows show the counts only through their `git_status` token.
    let upstream = upstream.filter(|_| !configured);
    let upstream_inline = upstream.filter(|_| show_detail && kind == RowKind::Workspace);
    let upstream_trailing = upstream.filter(|_| upstream_inline.is_none());
    let upstream_width = upstream_trailing.map_or(0., |upstream| {
        upstream
            .width(glyph)
            .min((available - pr_reserve - status_reserve - gap).max(0.))
    });
    let upstream_reserve = if upstream_trailing.is_some() {
        upstream_width + gap
    } else {
        0.
    };
    let label_width = (available - pr_reserve - status_reserve - upstream_reserve).max(0.);
    let agent_icon = match kind {
        RowKind::Agent(icon) => Some(icon),
        RowKind::Workspace => None,
    };
    // An orphan's name is on the first line; normal rows name the agent below
    // its location. Reserve the same fixed icon + gap on whichever line owns it.
    let agent_first = agent_icon.filter(|_| detail.is_empty());
    let agent_detail = agent_icon.filter(|_| !detail.is_empty());
    let (agent_size, agent_reserve) = agent_icon_size(font);
    let name_reserve = icon_reserve + agent_first.map_or(0., |_| agent_reserve);
    div()
        .debug_selector(|| format!("row-{key}"))
        .h(px(look.row_height(
            line_height(font)
                * if configured {
                    text_lines as f32
                } else if show_detail {
                    2.
                } else {
                    1.
                },
        )))
        .w_full()
        .min_w_0()
        .flex_none()
        .relative()
        .pl(px(content_x + indent))
        .pr(px(content_x))
        .flex()
        .items_start()
        .gap(px(gap))
        .py(px(content_top))
        .cursor_pointer()
        .map(|row| cx.mark.apply(row, key, &look))
        .map(|row| look.mark(row, key, state, theme))
        // Tree lines run in the indent the row already reserves, so a child is
        // tied to its parent without box-drawing glyphs in the label.
        .when(draw_tree, |row| {
            let (color, font) = (theme.muted, font.clone());
            let gutter = cx.nest + look.tree_gutter() + extra_status_width;
            row.child(
                div()
                    .debug_selector(|| format!("tree-{key}"))
                    .absolute()
                    .left(px(gutter))
                    .w(px(tree_width))
                    .top_0()
                    .bottom_0()
                    .child(
                        canvas(
                            |_, _, _| (),
                            move |bounds, _, window, _| {
                                for line in tree_lines(
                                    bounds,
                                    tree,
                                    &font,
                                    content_top,
                                    window.scale_factor(),
                                ) {
                                    window.paint_quad(fill(line, rgb(color)));
                                }
                            },
                        )
                        .size_full(),
                    ),
            )
        })
        .when(show_status, |row| {
            row.child(if removing {
                div()
                    .w(px(indicators.width(font)))
                    .mt(px((line_height(font) - STATUS_WIDTH) / 2.))
                    .flex_none()
                    .flex()
                    .justify_center()
                    .child(removing_dot("worktree-removing", theme))
            } else if let Some(token) = leading_icon {
                configured_status(token, status, cx)
            } else {
                status_indicator(status, font, indicators)
            })
        })
        .child(
            div()
                .flex()
                .flex_col()
                // Avoid zero-basis measurement: GPUI 0.2.2 mutates text run
                // lengths when truncating and reuses them on wider measurements.
                .w(px(label_width))
                .flex_none()
                .overflow_hidden()
                .debug_selector(|| format!("column-{key}"))
                .map(|column| {
                    if configured {
                        return configured_lines(
                            column,
                            key,
                            lines,
                            TokenLook {
                                kind,
                                status,
                                focused,
                                teleported,
                            },
                            label_width,
                            workspace_icon,
                            cx,
                        );
                    }
                    column
                        .child(
                            div()
                                .relative()
                                .w(px(label_width))
                                .h(px(line_height(font)))
                                .when_some(agent_first, |line, icon| {
                                    line.child(agent_mark(key, icon, agent_size, name_color, font))
                                })
                                .when(!matches!(workspace_icon, RowIcon::None), |title| {
                                    title.child(workspace_icon.slot(key, font, muted))
                                })
                                .child(
                                    name_line(
                                        name,
                                        (name_color, weight, theme.muted),
                                        (label_width - name_reserve).max(0.),
                                        font,
                                    )
                                    .debug_selector(|| format!("name-{key}"))
                                    .ml(px(name_reserve.min(label_width))),
                                ),
                        )
                        .when(show_detail, |column| {
                            let detail_x =
                                agent_detail.map_or(0., |_| agent_reserve.min(label_width));
                            let room = (label_width - detail_x).max(0.);
                            // The counts follow the branch and win the room it would
                            // take, so a long branch ellipsizes before they do.
                            let (detail_width, upstream_x) = match upstream_inline {
                                None => (room, room),
                                Some(_) if detail.is_empty() => (0., 0.),
                                Some(upstream) => {
                                    let natural = (detail.chars().count() as f32 * glyph).ceil();
                                    let width =
                                        natural.min((room - upstream.width(glyph) - glyph).max(0.));
                                    (width, width + glyph)
                                }
                            };
                            column.child(
                                div()
                                    .relative()
                                    .w(px(label_width))
                                    .h(px(line_height(font)))
                                    .when_some(agent_detail, |line, icon| {
                                        line.child(agent_mark(
                                            key,
                                            icon,
                                            agent_size,
                                            detail_color,
                                            font,
                                        ))
                                    })
                                    .child(
                                        div()
                                            .debug_selector(|| format!("detail-{key}"))
                                            .ml(px(detail_x))
                                            .w(px(detail_width))
                                            .truncate()
                                            .text_color(rgb(detail_color))
                                            .child(label_text(detail)),
                                    )
                                    .when_some(upstream_inline, |line, upstream| {
                                        line.child(
                                            div()
                                                .absolute()
                                                .top_0()
                                                .left(px(detail_x + upstream_x))
                                                .w(px((room - upstream_x).max(0.)))
                                                .overflow_hidden()
                                                .child(upstream.element(key, glyph, theme)),
                                        )
                                    }),
                            )
                        })
                }),
        )
        .when_some(status_text, |row, text| {
            row.child(
                div()
                    .debug_selector(|| format!("status-{key}"))
                    .w(px(status_width))
                    .flex_none()
                    .h(px(line_height(font)))
                    .flex()
                    .items_center()
                    .overflow_hidden()
                    .text_color(rgb(status_color))
                    .child(div().w(px(status_width)).truncate().child(label_text(text))),
            )
        })
        .when_some(upstream_trailing, |row, upstream| {
            row.child(
                div()
                    .w(px(upstream_width))
                    .flex_none()
                    .h(px(line_height(font)))
                    .flex()
                    .items_center()
                    .overflow_hidden()
                    .child(upstream.element(key, glyph, theme)),
            )
        })
        // The collapse column comes first so the badge can hug the row's edge;
        // a reserved-but-empty column keeps every badge on the same right edge.
        .when_some(arrow, |row, arrow| row.child(arrow))
        .when(arrow_absent && reserve_arrow, |row| {
            // The row's gap already covers part of the reserve; a wide gap
            // covers all of it.
            row.child(div().w(px((ARROW_RESERVE - gap).max(0.))).flex_none())
        })
        .when_some(badge, |row, badge| {
            row.child(badge.element(key, badge_width, font, theme, &layout))
        })
}

fn agent_icon_size(font: &FontConfig) -> (f32, f32) {
    let size = line_height(font).min(12.);
    (size, size + 4.)
}

fn agent_mark(
    key: &str,
    icon: crate::icons::AgentIcon,
    size: f32,
    color: u32,
    font: &FontConfig,
) -> Div {
    div()
        .debug_selector(|| format!("agent-icon-{key}"))
        .absolute()
        .left_0()
        .top(px((line_height(font) - size) / 2.))
        .size(px(size))
        .child(svg().path(icon.path()).size_full().text_color(rgb(color)))
}

pub(crate) fn label_text(text: &str) -> impl IntoElement {
    shared_label_text(SharedString::from(text))
}

#[cfg(not(any(test, feature = "integration-test")))]
fn shared_label_text(text: SharedString) -> SharedString {
    text
}

#[cfg(any(test, feature = "integration-test"))]
fn shared_label_text(text: SharedString) -> layout_tests::ProbeText {
    layout_tests::ProbeText(text)
}

pub(super) fn first_text<'a>(
    values: impl IntoIterator<Item = Option<&'a str>>,
    fallback: &'a str,
) -> &'a str {
    values
        .into_iter()
        .flatten()
        .map(str::trim)
        .find(|s| !s.is_empty())
        .unwrap_or(fallback)
}
