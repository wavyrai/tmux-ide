//! The open session's panes as sidebar rows (#746): one row per pane, under a
//! window subheading when the session has more than one window. Pane ids stay
//! the only routing identity; labels are display text.
use super::*;
use browser::home_agents::{Phase, Row as Agent};

/// The agent the daemon reports in pane `id` of the open session, and whether
/// it is unavailable. The open session's own roster wins; the fleet roster
/// covers a session opened from another machine's list.
pub(in crate::tmux_snapshot) fn pane_agent<'a>(
    state: &'a browser::State,
    id: &str,
) -> Option<(&'a Agent, bool)> {
    let session = state.selected_session.as_deref()?;
    let unique = |mut rows: Vec<&'a Agent>| (rows.len() == 1).then(|| rows.remove(0));
    if let Some(w) = state
        .workspace_agents
        .as_ref()
        .filter(|w| w.session_id == session)
        && let Some(agent) = unique(
            w.roster
                .rows
                .iter()
                .filter(|r| r.session_id == session && r.pane_id.as_deref() == Some(id))
                .collect(),
        )
    {
        let live = matches!(w.roster.phase, Phase::Live | Phase::Partial);
        return Some((agent, !agent.available || !live));
    }
    let p = state
        .workspace_fleet_agents
        .as_ref()
        .filter(|p| p.request == state.request && p.valid())?;
    let agent = unique(
        p.roster
            .rows
            .iter()
            .filter(|r| r.session_id == session && r.pane_id.as_deref() == Some(id))
            .collect(),
    )?;
    Some((agent, !p.roster.available(&agent.key)))
}

/// A pane row's label: an agent's task title, which it sets as the pane's
/// title, else the agent's own name; any other pane's daemon-given name.
fn label(pane: &browser::Choice, agent: Option<&Agent>) -> String {
    match agent {
        Some(agent) if pane.display_name_source != Some(browser::NameSource::Title) => {
            agent.name.clone()
        }
        _ => pane.label.clone(),
    }
}

fn pane_row(state: &browser::State, session: &str, pane: &browser::Choice, depth: u8) -> Row {
    let agent = pane_agent(state, &pane.id).map(|(agent, _)| agent);
    let kind = crate::tmux_snapshot::pane_chrome::pane_kind(
        agent.and_then(|a| a.harness.as_deref()),
        Some(pane),
    );
    Row {
        label: label(pane, agent),
        selected: state.selected_pane.as_ref() == Some(&pane.id),
        target: Some(Target::Pane {
            session: session.to_owned(),
            id: pane.id.clone(),
        }),
        depth,
        icon: Some(kind.icon()),
        pane: Some(pane.id.clone()),
        ..Row::default()
    }
}

pub(super) fn rows(state: &browser::State, depth: u8) -> Vec<Row> {
    let Some(session) = state.selected_session.clone() else {
        return Vec::new();
    };
    // The same windows, in the same order, the titlebar's tabs used to show.
    let windows =
        crate::tmux_snapshot::navigation::windows(&state.panes, state.selected_pane.as_deref());
    let mut out = Vec::new();
    for window in &windows {
        // A subheading only when there is more than one window. It is a
        // label: its pane rows are the targets, so keyboard focus never lands
        // on two rows for one pane.
        if windows.len() > 1 {
            out.push(Row {
                label: window.label.clone(),
                depth,
                kind: Kind::Window,
                ..Row::default()
            });
        }
        out.extend(
            state
                .panes
                .iter()
                .filter(|p| p.window_id.as_ref() == Some(&window.id))
                .map(|pane| pane_row(state, &session, pane, depth)),
        );
    }
    // Panes the topology has not placed in a window yet.
    out.extend(
        state
            .panes
            .iter()
            .filter(|p| p.window_id.is_none())
            .map(|pane| pane_row(state, &session, pane, depth)),
    );
    out
}

#[cfg(test)]
#[path = "panes_tests.rs"]
mod tests;
