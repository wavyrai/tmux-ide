//! Rows drawn from the daemon's configured sidebar tokens rather than the
//! built-in name and detail lines.

use super::{
    RowIcon, RowKind, agent_icon_size, agent_mark, label_text, left_behind, place_line, row_text,
    shared_label_text,
};
use crate::{
    config::Theme,
    sidebar::{
        ICON_RESERVE,
        agents::status_mark,
        cell::RowContext,
        glyph_width, line_height,
        tokens::{ResolvedToken, TextRole, TokenKind, budgets, separator},
    },
};
use gpui::{prelude::*, *};
use herdr_client::protocol::AgentStatus;
use unicode_width::UnicodeWidthStr;

/// What colors a configured row's tokens: the row they paint and its state.
#[derive(Clone, Copy)]
pub(in crate::sidebar) struct TokenLook {
    pub(in crate::sidebar) kind: RowKind,
    pub(in crate::sidebar) status: AgentStatus,
    pub(in crate::sidebar) focused: bool,
    /// A teleported checkout fades its name, as the native rows do.
    pub(in crate::sidebar) teleported: bool,
}

fn token_appearance(kind: &TokenKind, look: TokenLook, cx: &RowContext<'_>) -> (u32, FontWeight) {
    let theme = cx.theme;
    let (name, weight, secondary) = row_text(look.kind, look.focused, theme);
    match kind {
        TokenKind::StateIcon | TokenKind::Text(_, TextRole::Status) => {
            (cx.indicators.color(look.status), FontWeight::NORMAL)
        }
        TokenKind::Text(_, TextRole::Workspace) if look.teleported => {
            (left_behind(name, theme), weight)
        }
        TokenKind::Text(_, TextRole::Workspace) => (name, weight),
        TokenKind::Text(_, TextRole::Secondary | TextRole::Agent) => {
            (secondary, FontWeight::NORMAL)
        }
        _ => (theme.muted, FontWeight::NORMAL),
    }
}

fn styled(
    (color, weight): (u32, FontWeight),
    style: crate::config::TokenStyle,
    theme: &Theme,
) -> (u32, FontWeight) {
    let color = style.fg.unwrap_or(color);
    let color = if style.dim == Some(true) {
        theme.dimmed(color)
    } else {
        color
    };
    let weight = match style.bold {
        Some(true) => FontWeight::BOLD,
        Some(false) => FontWeight::NORMAL,
        None => weight,
    };
    (color, weight)
}

/// Status icons and git counters retain their full width when text truncates.
fn fixed_glyphs(kind: &TokenKind, glyph: f32, status_width: f32) -> usize {
    match kind {
        TokenKind::StateIcon => (status_width / glyph).ceil() as usize,
        TokenKind::GitStatus { ahead, behind } => {
            let count = |n: &usize| format!("{n}").chars().count() + 1;
            usize::from(*ahead > 0) * count(ahead)
                + usize::from(*behind > 0) * count(behind)
                + usize::from(*ahead > 0 && *behind > 0)
        }
        _ => 0,
    }
}

/// Fixed token widths preserve GPUI's text truncation during layout.
fn token_line(row: &[ResolvedToken], look: TokenLook, width: f32, cx: &RowContext<'_>) -> Div {
    let status = look.status;
    let (font, theme) = (cx.font, cx.theme);
    let glyph = glyph_width(font);
    let budgets = budgets(
        row,
        |kind| fixed_glyphs(kind, glyph, cx.indicators.width(font)),
        (width / glyph).floor() as usize,
    );
    let visible: Vec<_> = row
        .iter()
        .zip(budgets)
        .filter_map(|(token, width)| Some((token, width?)))
        .collect();
    let used = visible.iter().map(|(_, width)| width).sum::<usize>()
        + visible
            .windows(2)
            .map(|pair| separator(pair[0].0, pair[1].0).chars().count())
            .sum::<usize>();
    let slack = (width - used as f32 * glyph).max(0.);
    let last_text = visible
        .iter()
        .rposition(|(token, _)| token.kind.text().is_some());
    let parts = visible.iter().enumerate().map(|(index, (token, budget))| {
        let gap = if index == 0 {
            ""
        } else {
            separator(visible[index - 1].0, token)
        };
        let advance = *budget as f32 * glyph + if last_text == Some(index) { slack } else { 0. };
        let (color, weight) = styled(token_appearance(&token.kind, look, cx), token.style, theme);
        let cell = div();
        let cell = match &token.kind {
            TokenKind::StateIcon => cell
                .h(px(line_height(font)))
                .flex()
                .justify_center()
                .debug_selector(|| "inline-status-cell".into())
                .child(
                    status_mark(
                        status,
                        font,
                        cx.indicators,
                        color,
                        weight == FontWeight::BOLD,
                    )
                    .debug_selector(|| "inline-status-mark".into()),
                ),
            TokenKind::GitStatus { ahead, behind } => cell.flex().gap(px(glyph)).children(
                [("↑", *ahead, 2), ("↓", *behind, 1)]
                    .into_iter()
                    .filter(|(_, count, _)| *count > 0)
                    .map(|(arrow, count, palette)| {
                        let (color, weight) = styled(
                            (theme.ink(theme.palette[palette]), FontWeight::NORMAL),
                            token.style,
                            theme,
                        );
                        div()
                            .flex_none()
                            .text_color(rgb(color))
                            .font_weight(weight)
                            .child(label_text(&format!("{arrow}{count}")))
                    }),
            ),
            // Only text the budget cuts short truncates. An emoji's font is wider
            // than two estimated glyphs, so a label that fits by its display
            // width may overhang its cell slightly rather than collapse to "…".
            TokenKind::Text(text, _) if text.width() <= *budget => cell
                .whitespace_nowrap()
                .font_weight(weight)
                .text_color(rgb(color))
                .child(shared_label_text(text.clone())),
            TokenKind::Text(text, _) => cell
                .truncate()
                .font_weight(weight)
                .text_color(rgb(color))
                .child(shared_label_text(text.clone())),
        };
        (gap, advance, cell)
    });
    place_line(parts, width, font, theme.muted)
}

/// The `state_icon` leading a configured row's first line. It takes the row's
/// status slot; a configured row without one shows no status of its own.
pub(in crate::sidebar) fn leading_status(lines: &[Vec<ResolvedToken>]) -> Option<&ResolvedToken> {
    lines
        .first()
        .and_then(|line| line.first())
        .filter(|token| matches!(token.kind, TokenKind::StateIcon))
}

/// The color, and whether bold, a leading `state_icon` paints the status in.
pub(in crate::sidebar) fn configured_status_style(
    token: &ResolvedToken,
    status: AgentStatus,
    cx: &RowContext<'_>,
) -> (u32, bool) {
    let (color, weight) = styled(
        (cx.indicators.color(status), FontWeight::NORMAL),
        token.style,
        cx.theme,
    );
    (color, weight == FontWeight::BOLD)
}

/// The status mark a leading `state_icon` styles, offset onto the first line.
pub(in crate::sidebar) fn configured_status(
    token: &ResolvedToken,
    status: AgentStatus,
    cx: &RowContext<'_>,
) -> Div {
    let (color, bold) = configured_status_style(token, status, cx);
    status_mark(status, cx.font, cx.indicators, color, bold)
}

/// A line's tokens, less the leading `state_icon` the status slot draws.
fn line_tokens(index: usize, line: &[ResolvedToken]) -> &[ResolvedToken] {
    match line.split_first() {
        Some((first, rest)) if index == 0 && matches!(first.kind, TokenKind::StateIcon) => rest,
        _ => line,
    }
}

fn line_selector(key: &str, index: usize) -> String {
    match index {
        0 => format!("name-{key}"),
        1 => format!("detail-{key}"),
        index => format!("line-{key}-{index}"),
    }
}

/// Configured lines stacked at `width`, for layouts that draw their own
/// status and icons beside the text.
pub(in crate::sidebar) fn token_column(
    key: &str,
    lines: &[Vec<ResolvedToken>],
    look: TokenLook,
    width: f32,
    cx: &RowContext<'_>,
) -> Div {
    lines.iter().enumerate().fold(
        div().w(px(width)).flex_none().flex().flex_col(),
        |column, (index, line)| {
            column.child(
                token_line(line_tokens(index, line), look, width, cx)
                    .debug_selector(|| line_selector(key, index)),
            )
        },
    )
}

pub(super) fn configured_lines(
    mut column: Div,
    key: &str,
    lines: &[Vec<ResolvedToken>],
    look: TokenLook,
    label_width: f32,
    mut workspace_icon: RowIcon,
    cx: &RowContext<'_>,
) -> Div {
    let (font, theme) = (cx.font, cx.theme);
    let agent_icon = match look.kind {
        RowKind::Agent(icon) => Some(icon),
        RowKind::Workspace => None,
    };
    let agent_at = lines.iter().position(|line| {
        line.iter()
            .any(|token| matches!(token.kind, TokenKind::Text(_, TextRole::Agent)))
    });
    let (agent_size, agent_reserve) = agent_icon_size(font);
    let workspace_reserve = if matches!(workspace_icon, RowIcon::None) {
        0.
    } else {
        ICON_RESERVE
    };
    for (index, line) in lines.iter().enumerate() {
        let agent_here = agent_at == Some(index);
        let reserve = if index == 0 { workspace_reserve } else { 0. }
            + if agent_here { agent_reserve } else { 0. };
        let text_width = (label_width - reserve).max(0.);
        let selector = line_selector(key, index);
        let icon_color = line
            .iter()
            .find(|token| matches!(token.kind, TokenKind::Text(_, TextRole::Agent)))
            .map(|token| styled(token_appearance(&token.kind, look, cx), token.style, theme).0)
            .unwrap_or(theme.muted);
        let mut text = div().relative().w(px(label_width)).h(px(line_height(font)));
        if agent_here && let Some(icon) = agent_icon {
            text = text.child(agent_mark(key, icon, agent_size, icon_color, font));
        }
        if index == 0 && !matches!(workspace_icon, RowIcon::None) {
            text = text.child(std::mem::replace(&mut workspace_icon, RowIcon::None).slot(
                key,
                font,
                theme.muted,
            ));
        }
        text = text.child(
            token_line(line_tokens(index, line), look, text_width, cx)
                .debug_selector(|| selector.clone())
                .ml(px(reserve.min(label_width))),
        );
        column = column.child(text);
    }
    column
}

#[cfg(test)]
mod tests {
    use super::{RowContext, RowKind, TokenLook, left_behind, token_appearance};
    use crate::config::{FontConfig, LayoutMode, Theme};
    use crate::sidebar::tokens::{TextRole, TokenKind};
    use crate::sidebar::{agents::Indicators, layout};
    use herdr_client::protocol::AgentStatus;

    #[core::prelude::v1::test]
    fn teleported_rows_fade_only_their_workspace_tokens() {
        let font = FontConfig {
            family: "Menlo".into(),
            size: 12.,
            fallbacks: None,
            line_height_multiple: None,
        };
        let theme = Theme::default();
        let cx = RowContext {
            indicators: Indicators::new(None, false, &theme),
            font: &font,
            theme: &theme,
            look: layout::for_mode(LayoutMode::default()),
            width: 232.,
            nest: 0.,
            mark: Default::default(),
            host: None,
        };
        let here = TokenLook {
            kind: RowKind::Workspace,
            status: AgentStatus::Idle,
            focused: false,
            teleported: false,
        };
        let away = TokenLook {
            teleported: true,
            ..here
        };
        let workspace = TokenKind::Text("repo".into(), TextRole::Workspace);
        let (name, weight) = token_appearance(&workspace, here, &cx);
        assert_eq!(
            token_appearance(&workspace, away, &cx),
            (left_behind(name, &theme), weight)
        );
        assert_ne!(left_behind(name, &theme), name);
        for other in [
            TokenKind::Text("idle".into(), TextRole::Status),
            TokenKind::Text("main".into(), TextRole::Secondary),
            TokenKind::StateIcon,
        ] {
            assert_eq!(
                token_appearance(&other, away, &cx),
                token_appearance(&other, here, &cx)
            );
        }
    }
}
