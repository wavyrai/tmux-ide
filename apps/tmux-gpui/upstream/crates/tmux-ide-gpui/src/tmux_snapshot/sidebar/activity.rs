//! Session enrichment uses native observation provenance, never display labels.
use super::*;
use crate::tmux_snapshot::workspace_fleet_agents;
use std::collections::{BTreeMap, BTreeSet};

pub(super) fn integrate(state: &browser::State, rows: Vec<Row>) -> Vec<Row> {
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
        let depth = row.depth + 1;
        out.push(row);
        for agent in agents {
            out.push(Row {
                label: agent.name.clone(),
                pane_count: Some(agent.status.label().to_lowercase()),
                summary: None,
                attention: 0,
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
                machine: None,
                agent: Some(agent.key.clone()),
                icon: None,
                favorite: None,
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
