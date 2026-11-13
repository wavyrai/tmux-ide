//! Session enrichment uses native observation provenance, never display labels.
use super::*;
use crate::tmux_snapshot::workspace_fleet_agents;
use std::collections::{BTreeMap, BTreeSet};

/// The agent a sidebar row stands for, by its roster key, and whether it is
/// unavailable: the workspace's fleet roster, or on Home, Home's roster.
pub(in crate::tmux_snapshot) fn row_agent<'a>(
    state: &'a browser::State,
    key: &str,
) -> Option<(&'a browser::home_agents::Row, bool)> {
    if let Some(p) = state.workspace_fleet_agents.as_ref() {
        let agent = p.roster.rows.iter().find(|r| r.key == key)?;
        return Some((agent, !p.roster.available(key)));
    }
    let roster = state.home_agents.as_ref()?;
    let agent = roster.rows.iter().find(|r| r.key == key)?;
    Some((agent, !roster.available(key)))
}

/// On Home (#746): each project's agents from Home's roster, under its
/// heading, matched by the session's live id as Home's table matches them.
fn integrate_home(state: &browser::State, rows: Vec<Row>) -> Vec<Row> {
    let Some(roster) = state.home_agents.as_ref() else {
        return rows;
    };
    let sessions: Vec<_> = state
        .fleet
        .iter()
        .flat_map(|f| &f.groups)
        .flat_map(|g| g.sessions.iter().map(move |s| (g.id.clone(), s)))
        .collect();
    let mut out = Vec::new();
    for mut row in rows {
        let live = match &row.target {
            Some(Target::FleetSession { machine, id, .. }) => sessions
                .iter()
                .find(|(m, s)| m == machine && &s.id == id)
                .and_then(|(m, s)| Some((m, s.session_id.clone()?))),
            _ => None,
        };
        let Some((machine, live)) = live else {
            out.push(row);
            continue;
        };
        // As Home's table: a namesake session on another machine gets none.
        let mut agents: Vec<_> = roster
            .rows
            .iter()
            .filter(|a| a.session_id == live && a.observed_on(machine))
            .collect();
        // Activity changes must not move a project's rows under the pointer.
        agents.sort_by(|a, b| a.key.cmp(&b.key));
        row.attention = agents.iter().filter(|a| a.attention).count();
        let depth = row.depth;
        out.push(row);
        out.extend(agents.into_iter().map(|agent| Row {
            label: agent.name.clone(),
            target: roster.available(&agent.key).then(|| Target::HomeAgent {
                revision: roster.revision,
                key: agent.key.clone(),
            }),
            depth,
            agent: Some(agent.key.clone()),
            icon: Some(crate::tmux_snapshot::pane_chrome::agent_icon_path(
                agent.harness.as_deref(),
            )),
            ..Row::default()
        }));
    }
    out
}

pub(super) fn integrate(state: &browser::State, rows: Vec<Row>) -> Vec<Row> {
    if state.surface == browser::Surface::Home {
        return integrate_home(state, rows);
    }
    let Some(publication) = state.workspace_fleet_agents.as_ref().filter(|p| {
        p.request == state.request && p.valid() && state.surface == browser::Surface::Workspace
    }) else {
        return rows;
    };
    let mut grouped: BTreeMap<(String, String), Vec<&browser::home_agents::Row>> = BTreeMap::new();
    let mut matched = BTreeSet::new();
    for agent in &publication.roster.rows {
        let Some(scope) = publication.sessions.get(&agent.key) else {
            continue;
        };
        let candidates: Vec<_> = state
            .fleet
            .iter()
            .flat_map(|f| &f.groups)
            .filter(|g| {
                g.id == scope.machine && !g.conflict && g.state == browser::fleet::Phase::Ready
            })
            .flat_map(|g| {
                g.sessions
                    .iter()
                    .filter(move |s| {
                        s.selection.is_some()
                            && s.session_id.as_ref() == Some(&scope.session)
                            && s.server_id.as_ref() == Some(&scope.server)
                            && g.servers.iter().any(|server| {
                                server.id == scope.server
                                    && server.generation.as_ref() == Some(&scope.generation)
                            })
                    })
                    .map(move |s| (g.id.clone(), s.id.clone()))
            })
            .collect();
        if candidates.len() == 1 {
            grouped
                .entry(candidates[0].clone())
                .or_default()
                .push(agent);
            matched.insert(agent.key.as_str());
        }
    }
    let mut out = Vec::new();
    for mut row in rows {
        let agents = match &row.target {
            Some(Target::FleetSession { machine, id, .. }) => {
                grouped.remove(&(machine.clone(), id.clone()))
            }
            _ => None,
        };
        let Some(mut agents) = agents else {
            out.push(row);
            continue;
        };
        // The open session lists every pane, agents included (#746).
        if row.selected && state.surface == browser::Surface::Workspace && !state.panes.is_empty() {
            out.push(row);
            continue;
        }
        // Activity changes must not move a session or its pane targets under the pointer.
        agents.sort_by(|a, b| a.key.cmp(&b.key));
        row.attention = agents.iter().filter(|a| a.attention).count();
        let projects: BTreeSet<_> = agents
            .iter()
            .filter_map(|a| a.project_name.as_deref())
            .filter(|name| !name.is_empty() && *name != row.label)
            .collect();
        if !projects.is_empty() {
            row.summary = Some(projects.into_iter().collect::<Vec<_>>().join(" · "));
        }
        let depth = row.depth;
        out.push(row);
        for agent in agents {
            out.push(Row {
                label: agent.name.clone(),
                selected: publication.selected_key.as_ref() == Some(&agent.key),
                target: publication
                    .roster
                    .available(&agent.key)
                    .then(|| Target::FleetAgent {
                        scope: publication.scope,
                        revision: publication.roster.revision,
                        key: agent.key.clone(),
                    }),
                depth,
                agent: Some(agent.key.clone()),
                icon: Some(crate::tmux_snapshot::pane_chrome::agent_icon_path(
                    agent.harness.as_deref(),
                )),
                ..Row::default()
            });
        }
    }
    let fallback = workspace_fleet_agents::rows(state);
    let has_unmatched = publication
        .roster
        .rows
        .iter()
        .any(|a| !matched.contains(a.key.as_str()));
    out.extend(fallback.into_iter().filter(|r| {
        if let Some(key) = &r.agent {
            !matched.contains(key.as_str())
        } else {
            r.label != "Agent activity" || has_unmatched
        }
    }));
    out
}
