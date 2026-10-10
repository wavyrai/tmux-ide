//! Superset's single-line rows: one icon slot that reports the row's state,
//! the name, and the pull request's change counts on the right. The focused
//! row is filled and marked with a stripe down its leading edge. Rows Herdr's
//! sidebar config defines replace the name with its lines; the slot keeps its
//! dot only when those lines lead with the status.

use super::{
    super::{
        agents::{status_mark, status_style},
        cell::{AgentRow, RowContext, RowLayout, RowState, WorkspaceRow},
        line_height,
        row::{
            RowIcon, RowKind, RowLift, RowTree, TokenLook, configured_status_style, leading_status,
            left_behind, removing_dot, token_column,
        },
        tokens::ResolvedToken,
    },
    parts::{self, Line, glyph_at, wash},
};
use crate::config::Theme;
use gpui::{prelude::*, *};
use herdr_client::protocol::AgentStatus;

pub(in super::super) struct Superset;

/// Width of the leading edge stripe on the focused row.
const STRIPE: f32 = 2.;

/// Geometry shared by both kinds of row, scaled from the sidebar font so a
/// larger font grows the icon slot with the text.
struct Metrics {
    icon: f32,
    glyph: f32,
    gap: f32,
    small: f32,
}

impl Metrics {
    fn new(cx: &RowContext<'_>) -> Self {
        let small = (cx.font.size * 0.8).round();
        Self {
            icon: (cx.font.size * 1.5).round().max(line_height(cx.font)),
            glyph: glyph_at(cx.font, small),
            gap: cx.look.density.gap(),
            small,
        }
    }
}

/// The row: padding, the state fill, the stripe, and one measured line.
fn shell(key: &str, state: RowState, indent: f32, line: Line<'_>, cx: &RowContext<'_>) -> Div {
    let theme = cx.theme;
    let gap = cx.look.density.gap();
    let row = div()
        .debug_selector(|| format!("row-{key}"))
        .relative()
        .w_full()
        .flex_none()
        .flex()
        .items_center()
        .py(px(gap))
        .pl(px(cx.look.content_x() + indent))
        .cursor_pointer();
    let row = cx.mark.apply(row, key, &cx.look);
    parts::mark(
        row,
        state,
        (rgb(theme.active), wash(theme.foreground, 0x0d)),
        theme,
    )
    // Flat rows round off while carried, so the card reads as picked up.
    .when(state.lift == RowLift::Lifted, |row| row.rounded(px(4.)))
    .when(state.selected, |row| {
        row.child(
            div()
                .debug_selector(|| format!("highlight-{key}"))
                .absolute()
                .left_0()
                .top_0()
                .bottom_0()
                .w(px(STRIPE))
                .rounded_r(px(STRIPE))
                .bg(rgb(theme.foreground)),
        )
    })
    .child(line.into_div())
}

/// The icon slot, with the status as a dot pinned to its top right corner in
/// `dot`'s color, bold where symbols allow. `None` draws no dot. The dot stays
/// inside the slot: the slot sets the line's height and the line clips, so a
/// dot that overhangs the slot loses its top.
fn slot(
    key: &str,
    glyph: impl IntoElement,
    (status, dot): (AgentStatus, Option<(u32, bool)>),
    m: &Metrics,
    cx: &RowContext<'_>,
) -> Div {
    let theme = cx.theme;
    let dot = dot.map(|(color, bold)| {
        if cx.indicators.style == crate::herdr_settings::IndicatorStyle::Symbols {
            return status_mark(status, cx.font, cx.indicators, color, bold)
                .mt_0()
                .debug_selector(|| format!("dot-{key}"))
                .absolute()
                .top_0()
                .right_0()
                .bg(rgb(theme.sidebar_background()));
        }
        let (diameter, filled, _) = status_style(status, theme);
        div()
            .debug_selector(|| format!("dot-{key}"))
            .absolute()
            .top_0()
            .right_0()
            .size(px(diameter))
            .rounded_full()
            .border_1()
            .border_color(rgb(color))
            .bg(rgb(if filled {
                color
            } else {
                theme.sidebar_background()
            }))
    });
    div()
        .debug_selector(|| format!("icon-{key}"))
        .relative()
        .size(px(m.icon))
        .flex()
        .items_center()
        .justify_center()
        .child(glyph)
        .children(dot)
}

/// The slot's dot: none for Unknown, which has nothing to report, or for a
/// configured row that does not lead with the status, as Herdr's rows omit
/// it; styled as that leading `state_icon` asks.
fn dot(
    lines: &[Vec<ResolvedToken>],
    status: AgentStatus,
    cx: &RowContext<'_>,
) -> (AgentStatus, Option<(u32, bool)>) {
    let dot = if status == AgentStatus::Unknown {
        None
    } else if lines.is_empty() {
        Some((cx.indicators.color(status), false))
    } else {
        leading_status(lines).map(|token| configured_status_style(token, status, cx))
    };
    (status, dot)
}

fn text_color(state: RowState, theme: &Theme) -> u32 {
    if state.selected {
        theme.foreground
    } else {
        theme.subtext()
    }
}

impl RowLayout for Superset {
    fn workspace(&self, row: WorkspaceRow<'_>, state: RowState, cx: &RowContext<'_>) -> Div {
        let (status, upstream) = (row.status(), row.upstream());
        let WorkspaceRow {
            label,
            tree,
            icon,
            fold,
            badge,
            removing,
            lines,
            ..
        } = row;
        let theme = cx.theme;
        let m = Metrics::new(cx);
        let slot_dot = dot(&lines, status, cx);
        let indent = cx.nest
            + if tree == RowTree::None {
                0.
            } else {
                cx.look.density.card_indent()
            };
        let pr = badge.as_ref().and_then(|badge| badge.pr.as_ref());
        let dirty = badge.as_ref().is_some_and(|badge| badge.dirty);
        let teleported = badge.as_ref().is_some_and(|badge| badge.teleported);
        let dirty_size = (line_height(cx.font) * 0.75).round().min(15.);
        let size = m.icon * 0.7;
        let icon_color = if state.selected {
            theme.foreground
        } else {
            theme.muted
        };
        // A pull request outranks the owner: its color is its state.
        let glyph = match (pr, icon) {
            (Some(pr), _) => parts::icon("icons/git-branch.svg", size, pr.color).into_any_element(),
            (None, RowIcon::None) => {
                parts::icon("icons/git-branch.svg", size, icon_color).into_any_element()
            }
            (None, icon) => div()
                .size(px(size))
                .child(icon.element(icon_color))
                .into_any_element(),
        };
        let slot = if removing {
            slot(
                label,
                removing_dot("worktree-removing", theme),
                (status, None),
                &m,
                cx,
            )
        } else {
            slot(label, glyph, slot_dot, &m, cx)
        };
        let counts = if state.selected {
            (theme.ink(theme.palette[2]), theme.ink(theme.palette[1]))
        } else {
            (theme.muted, theme.muted)
        };
        let line = Line::new(cx.look.content_width(cx.width) - indent, m.gap).fixed(m.icon, slot);
        let line = if lines.is_empty() {
            line.fill(
                div()
                    .debug_selector(|| format!("name-{label}"))
                    .text_color(rgb(if teleported {
                        left_behind(text_color(state, theme), theme)
                    } else {
                        text_color(state, theme)
                    })),
                label,
            )
            // Configured rows show the counts only through `git_status`.
            .when_some(upstream, |line, upstream| {
                let glyph = glyph_at(cx.font, cx.font.size);
                line.fixed(upstream.width(glyph), upstream.element(label, glyph, theme))
            })
        } else {
            line.fill_with(|width| {
                token_column(
                    label,
                    &lines,
                    TokenLook {
                        kind: RowKind::Workspace,
                        status,
                        focused: state.selected,
                        teleported,
                    },
                    width,
                    cx,
                )
            })
        };
        let line = line
            .when(teleported, |line| {
                line.fixed(dirty_size, parts::teleported(label, dirty_size, theme))
            })
            .when(dirty, |line| {
                line.fixed(dirty_size, parts::dirty(label, dirty_size, theme))
            })
            .when_some(pr, |line, pr| {
                let (width, counts) = parts::pr_counts(label, pr, m.glyph, counts);
                line.shrink(width, counts.text_size(px(m.small)))
            })
            .when_some(fold, |line, fold| {
                let width = m.icon * 0.6;
                line.fixed(width, fold.element(theme).w(px(width)).text_size(px(14.)))
            });
        shell(label, state, indent, line, cx)
    }

    fn agent(&self, agent: AgentRow<'_>, state: RowState, cx: &RowContext<'_>) -> Div {
        let theme = cx.theme;
        let m = Metrics::new(cx);
        let key = agent.key.as_str();
        let color = text_color(state, theme);
        let glyph = parts::icon(agent.icon.path(), m.icon * 0.7, color);
        let slot_dot = dot(&agent.lines, agent.status, cx);
        let line = Line::new(cx.look.content_width(cx.width), m.gap)
            .fixed(m.icon, slot(key, glyph, slot_dot, &m, cx));
        if !agent.lines.is_empty() {
            let line = line.fill_with(|width| {
                token_column(
                    key,
                    &agent.lines,
                    TokenLook {
                        kind: RowKind::Agent(agent.icon),
                        status: agent.status,
                        focused: state.selected,
                        teleported: false,
                    },
                    width,
                    cx,
                )
            });
            return shell(key, state, 0., line, cx);
        }
        // Where the agent runs trails its name, never over half the row.
        let line = line
            .fill(
                div()
                    .debug_selector(|| format!("name-{key}"))
                    .text_color(rgb(color)),
                agent.name,
            )
            .when_some(parts::agent_place(agent.place, cx.host), |line, place| {
                line.label(
                    div()
                        .debug_selector(|| format!("detail-{key}"))
                        .text_size(px(m.small))
                        .text_color(rgb(theme.muted)),
                    place,
                    m.glyph,
                    0.5,
                )
            })
            .when_some(agent.status_text.as_deref(), |line, text| {
                line.label(
                    div()
                        .debug_selector(|| format!("status-{key}"))
                        .text_size(px(m.small))
                        .text_color(rgb(cx.indicators.color(agent.status))),
                    text,
                    m.glyph,
                    0.5,
                )
            });
        shell(key, state, 0., line, cx)
    }
}

#[cfg(test)]
mod tests {
    use super::{
        super::super::{
            agents::Indicators,
            cell::RowContext,
            layout,
            tokens::{ResolvedToken, TextRole, TokenKind},
        },
        dot,
    };
    use crate::config::{FontConfig, LayoutMode, Theme, TokenStyle};
    use herdr_client::protocol::AgentStatus;

    #[core::prelude::v1::test]
    fn the_slot_dot_follows_a_configured_leading_state_icon() {
        let font = FontConfig {
            family: "Menlo".into(),
            size: 12.,
            fallbacks: None,
            line_height_multiple: None,
        };
        let theme = Theme::default();
        let indicators = Indicators::new(None, false, &theme);
        let cx = RowContext {
            indicators,
            font: &font,
            theme: &theme,
            look: layout::for_mode(LayoutMode::Superset),
            width: 232.,
            nest: 0.,
            mark: Default::default(),
            host: None,
        };
        let working = AgentStatus::Working;
        let native = indicators.color(working);
        let icon = |style| ResolvedToken {
            kind: TokenKind::StateIcon,
            style,
        };
        let name = ResolvedToken {
            kind: TokenKind::Text("repo".into(), TextRole::Workspace),
            style: TokenStyle::default(),
        };
        let red = TokenStyle {
            fg: Some(0xff0000),
            bold: Some(true),
            dim: None,
        };
        assert_eq!(dot(&[], working, &cx), (working, Some((native, false))));
        assert_eq!(
            dot(
                &[vec![icon(TokenStyle::default()), name.clone()]],
                working,
                &cx
            ),
            (working, Some((native, false)))
        );
        assert_eq!(
            dot(&[vec![icon(red), name.clone()]], working, &cx),
            (working, Some((0xff0000, true)))
        );
        // No leading status, or nothing to report, draws no dot.
        assert_eq!(dot(&[vec![name.clone()]], working, &cx), (working, None));
        assert_eq!(
            dot(&[vec![icon(red), name]], AgentStatus::Unknown, &cx),
            (AgentStatus::Unknown, None)
        );
    }
}
