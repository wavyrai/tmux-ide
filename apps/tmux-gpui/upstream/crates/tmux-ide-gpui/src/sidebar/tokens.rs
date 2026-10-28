//! Resolve sidebar tokens, omitting missing values and empty rows.

use super::{
    agents::{agent_names, agent_place, state_label, status_text},
    segment_budgets,
};
use crate::config::{AgentLayout, AgentToken, Rows, SpaceLayout, SpaceToken, TokenStyle};
use gpui::SharedString;
use herdr_client::protocol::{AgentStatus, ClientShellAgent, ClientShellSnapshot};
use std::collections::HashMap;
use unicode_width::UnicodeWidthStr;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct ResolvedToken {
    pub(super) kind: TokenKind,
    pub(super) style: TokenStyle,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum TokenKind {
    StateIcon,
    Text(SharedString, TextRole),
    GitStatus { ahead: usize, behind: usize },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum TextRole {
    Status,
    Workspace,
    Agent,
    Secondary,
    Muted,
}

impl TokenKind {
    pub(super) fn text(&self) -> Option<&SharedString> {
        match self {
            Self::Text(text, _) => Some(text),
            _ => None,
        }
    }
}

impl ResolvedToken {
    #[cfg(test)]
    pub(super) fn unstyled(kind: TokenKind) -> Self {
        Self {
            kind,
            style: TokenStyle::default(),
        }
    }
}

fn token_values(tokens: &[(String, String)]) -> HashMap<&str, &str> {
    tokens
        .iter()
        .map(|(name, value)| (name.as_str(), value.as_str()))
        .collect()
}

fn shared_text<'a>(strings: &mut HashMap<&'a str, SharedString>, text: &'a str) -> SharedString {
    strings
        .entry(text)
        .or_insert_with(|| SharedString::from(text))
        .clone()
}

fn resolve_rows<T>(
    rows: &Rows<T>,
    mut value: impl FnMut(&T) -> Option<TokenKind>,
) -> Vec<Vec<ResolvedToken>> {
    rows.iter()
        .filter_map(|row| {
            let resolved: Vec<_> = row
                .iter()
                .filter_map(|configured| {
                    let kind = value(&configured.token)?;
                    let style = match kind.text() {
                        Some(text) => configured.style_for(text)?,
                        None => configured.style,
                    };
                    Some(ResolvedToken { kind, style })
                })
                .collect();
            (!resolved.is_empty()).then_some(resolved)
        })
        .collect()
}

/// The rows for one agent. `machine` is the host label when more than one
/// endpoint is shown. An agent whose workspace has gone has no rows.
pub(super) fn agent_rows(
    layout: &AgentLayout,
    agent: &ClientShellAgent,
    snapshot: &ClientShellSnapshot,
    machine: Option<&str>,
) -> Option<Vec<Vec<ResolvedToken>>> {
    let (workspace, tab) = agent_place(agent, snapshot)?;
    let pane = agent.title.as_deref().or_else(|| {
        snapshot
            .panes
            .iter()
            .find(|pane| pane.pane_id == agent.pane_id)
            .and_then(|pane| pane.label.as_deref())
    });
    let state_text = state_label(
        agent,
        match agent.agent_status {
            AgentStatus::Unknown => "idle",
            status => status_text(status),
        },
    );
    let tokens = token_values(&agent.tokens);
    let mut strings = HashMap::new();
    let mut text = |value, role| TokenKind::Text(shared_text(&mut strings, value), role);
    let mut rows = resolve_rows(layout.rows_for(agent.agent.as_deref()), |token| {
        Some(match token {
            AgentToken::StateIcon => TokenKind::StateIcon,
            AgentToken::StateText => text(&state_text, TextRole::Status),
            AgentToken::Machine => text(machine?, TextRole::Secondary),
            AgentToken::Workspace => text(workspace, TextRole::Workspace),
            AgentToken::Tab => text(tab?, TextRole::Secondary),
            AgentToken::Pane => text(pane?, TextRole::Secondary),
            AgentToken::Agent => text(
                agent_names(agent).into_iter().flatten().next()?,
                TextRole::Agent,
            ),
            AgentToken::TerminalTitle => text(agent.terminal_title.as_deref()?, TextRole::Muted),
            AgentToken::TerminalTitleStripped => {
                text(agent.terminal_title_stripped.as_deref()?, TextRole::Muted)
            }
            AgentToken::Custom(name) => text(tokens.get(name.as_str())?, TextRole::Muted),
        })
    });
    if rows.is_empty() {
        rows.push(vec![ResolvedToken {
            kind: TokenKind::StateIcon,
            style: TokenStyle::default(),
        }]);
    }
    Some(rows)
}

pub(super) struct SpaceContext<'a> {
    pub(super) label: &'a str,
    pub(super) branch: Option<&'a str>,
    pub(super) status: AgentStatus,
    pub(super) ahead_behind: Option<(usize, usize)>,
    pub(super) tokens: &'a [(String, String)],
    pub(super) indented: bool,
}

pub(super) fn space_rows(
    layout: &SpaceLayout,
    context: SpaceContext<'_>,
) -> Vec<Vec<ResolvedToken>> {
    let mut strings = HashMap::new();
    let mut text = |value, role| TokenKind::Text(shared_text(&mut strings, value), role);
    let tokens = token_values(context.tokens);
    let mut rows = resolve_rows(&layout.rows, |token| {
        Some(match token {
            SpaceToken::StateIcon => TokenKind::StateIcon,
            SpaceToken::StateText => text(status_text(context.status), TextRole::Status),
            SpaceToken::Workspace => text(context.label, TextRole::Workspace),
            SpaceToken::Branch | SpaceToken::GitStatus if context.indented => return None,
            SpaceToken::Branch => text(context.branch?, TextRole::Secondary),
            SpaceToken::GitStatus => {
                let (ahead, behind) = context.ahead_behind.filter(|(a, b)| *a > 0 || *b > 0)?;
                TokenKind::GitStatus { ahead, behind }
            }
            SpaceToken::Custom(name) => text(tokens.get(name.as_str())?, TextRole::Muted),
        })
    });
    if rows.is_empty() {
        rows.push(Vec::new());
    }
    rows
}

/// Upstream joins tokens with a middle dot, except after the state icon and
/// before the git counters, which sit a single space apart.
pub(super) fn separator(previous: &ResolvedToken, current: &ResolvedToken) -> &'static str {
    if matches!(previous.kind, TokenKind::StateIcon)
        || matches!(current.kind, TokenKind::GitStatus { .. })
    {
        " "
    } else {
        " \u{b7} "
    }
}

/// Glyph budget for each token of a row that must fit `available` glyphs,
/// or `None` for a token dropped entirely. Fixed-width tokens (the icon and
/// the git counters) always stay. When even one glyph per text token does not
/// fit, text tokens are dropped from the left until the rest fit, then the
/// survivors grow a glyph at a time in turn, as upstream shares a line.
pub(super) fn budgets(
    row: &[ResolvedToken],
    fixed_width: impl Fn(&TokenKind) -> usize,
    available: usize,
) -> Vec<Option<usize>> {
    let fixed: Vec<usize> = row.iter().map(|token| fixed_width(&token.kind)).collect();
    let flexible: Vec<usize> = row
        .iter()
        .map(|token| token.kind.text().map_or(0, |text| text.width()))
        .collect();
    let minimum = |active: &[bool]| -> usize {
        (0..row.len())
            .filter(|index| active[*index])
            .fold((0, None), |(total, previous), index| {
                let gap =
                    previous.map_or(0, |prev| separator(&row[prev], &row[index]).chars().count());
                (
                    total + fixed[index] + usize::from(flexible[index] > 0) + gap,
                    Some(index),
                )
            })
            .0
    };
    let mut active = vec![true; row.len()];
    if minimum(&active) > available {
        for (index, width) in flexible.iter().enumerate() {
            if *width > 0 {
                active[index] = false;
            }
        }
        for index in (0..row.len()).rev() {
            if flexible[index] == 0 {
                continue;
            }
            active[index] = true;
            if minimum(&active) > available {
                active[index] = false;
            }
        }
    }
    let lengths: Vec<_> = flexible
        .iter()
        .zip(&active)
        .map(|(width, active)| if *active { *width } else { 0 })
        .collect();
    let minimum_text: usize = lengths.iter().map(|width| usize::from(*width > 0)).sum();
    let reserved = minimum(&active).saturating_sub(minimum_text);
    let budgets = segment_budgets(&lengths, available.saturating_sub(reserved));
    (0..row.len())
        .map(|index| active[index].then_some(budgets[index].max(fixed[index])))
        .collect()
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests;
