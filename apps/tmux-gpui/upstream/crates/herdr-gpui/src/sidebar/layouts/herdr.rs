//! Herdr's own rows, after its terminal client: a status dot, the name over
//! its branch or agent, tree guides for worktrees, and the pull request on
//! the right edge. Density and style decide spacing and which lines show.

use super::super::{
    ARROW_RESERVE,
    agents::agent_labels,
    cell::{AgentRow, RowContext, RowLayout, RowState, WorkspaceRow},
    line_height,
    row::{RowIcon, RowKind, RowTree},
};
use gpui::{prelude::*, *};

pub(in super::super) struct Herdr;

impl RowLayout for Herdr {
    fn workspace(&self, row: WorkspaceRow<'_>, state: RowState, cx: &RowContext<'_>) -> Div {
        let density = cx.look.density;
        let badge_lines = row.badge.as_ref().map_or(0, |badge| badge.lines(&density));
        let text_lines = if row.lines.is_empty() {
            if density.workspace_details() { 2 } else { 1 }
        } else {
            row.lines.len().max(badge_lines).max(1)
        };
        let (branch, status, upstream) = (row.branch().unwrap_or(""), row.status(), row.upstream());
        let WorkspaceRow {
            label,
            tree,
            icon,
            fold,
            grouped,
            badge,
            removing,
            lines,
            ..
        } = row;
        let arrow = fold.map(|fold| {
            fold.element(cx.theme)
                .w(px(ARROW_RESERVE - density.gap()))
                .h(px(line_height(cx.font) * text_lines as f32))
                .text_size(px(16.))
        });
        super::super::row::row(
            label,
            &[(label, true)],
            branch,
            RowKind::Workspace,
            status,
            cx.indicators,
            removing,
            state,
            tree,
            grouped,
            icon,
            arrow,
            badge,
            upstream,
            None,
            &lines,
            cx,
        )
    }

    fn agent(&self, agent: AgentRow<'_>, state: RowState, cx: &RowContext<'_>) -> Div {
        let (name, detail) = agent_labels(agent.name, agent.place, cx.host);
        super::super::row::row(
            &agent.key,
            &name,
            detail,
            RowKind::Agent(agent.icon),
            agent.status,
            cx.indicators,
            false,
            state,
            RowTree::None,
            false,
            RowIcon::None,
            None,
            None,
            None,
            agent.status_text.as_deref(),
            &agent.lines,
            cx,
        )
    }
}
