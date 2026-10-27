//! Match TUI membership grouping without trusting display names as identities.
use super::*;
use herdr_client::tmux_daemon::ObservedTeamSource;
type Team = (String, String, u8, String);
type Membership = (String, Option<Team>);
impl Gate {
    pub(super) fn group_workspace_rows(&self, rows: &mut Vec<home_agents::Row>) {
        let retained: std::collections::BTreeSet<_> = rows.iter().map(|r| r.key.as_str()).collect();
        let mut membership = BTreeMap::new();
        for slot in &self.slots {
            let Observed::Ready(result) = &slot.observed else {
                continue;
            };
            for agent in &result.agents {
                let key = self.row_key(&slot.context, agent);
                if !retained.contains(key.as_str()) {
                    continue;
                }
                let team = agent.team.as_ref().map(|t| {
                    (
                        slot.context.scope.server_id.clone(),
                        slot.context.scope.generation.clone(),
                        match t.source {
                            ObservedTeamSource::Manual => 0,
                            ObservedTeamSource::ClaudeCode => 1,
                        },
                        t.id.clone(),
                    )
                });
                membership.insert(key, (slot.context.machine.clone(), team));
            }
        }
        *rows = grouped(std::mem::take(rows), &membership);
    }
}
fn grouped(
    rows: Vec<home_agents::Row>,
    membership: &BTreeMap<String, Membership>,
) -> Vec<home_agents::Row> {
    if rows.iter().any(|r| !membership.contains_key(&r.key)) {
        return rows;
    }
    let mut machines: Vec<(String, Vec<home_agents::Row>)> = Vec::new();
    for row in rows {
        let machine = &membership[&row.key].0;
        let index = machines
            .iter()
            .position(|(id, _)| id == machine)
            .unwrap_or_else(|| {
                machines.push((machine.clone(), Vec::new()));
                machines.len() - 1
            });
        machines[index].1.push(row);
    }
    machines
        .into_iter()
        .flat_map(|(_, rows)| {
            let mut teams: Vec<(Team, Vec<home_agents::Row>)> = Vec::new();
            let mut ungrouped = Vec::new();
            for row in rows {
                if let Some(team) = &membership[&row.key].1 {
                    let index = teams
                        .iter()
                        .position(|(id, _)| id == team)
                        .unwrap_or_else(|| {
                            teams.push((team.clone(), Vec::new()));
                            teams.len() - 1
                        });
                    teams[index].1.push(row);
                } else {
                    ungrouped.push(row);
                }
            }
            teams
                .into_iter()
                .flat_map(|(_, rows)| rows)
                .chain(ungrouped)
                .collect::<Vec<_>>()
        })
        .collect()
}
#[cfg(test)]
#[path = "browser_native_local_agent_groups_tests.rs"]
mod tests;
