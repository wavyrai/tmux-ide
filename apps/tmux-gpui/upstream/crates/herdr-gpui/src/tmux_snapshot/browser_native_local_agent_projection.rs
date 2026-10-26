use super::*;
use herdr_client::tmux_daemon::{AgentActivity, ObservedHarness};
use std::{cmp::Ordering, collections::BinaryHeap};
const ROW_LIMIT: usize = 256;

pub(super) fn display(value: &str, max: usize) -> String {
    value
        .chars()
        .filter(|c| !c.is_control())
        .take(max)
        .collect()
}
// A max heap keeps the worst retained row at the root. Rejected candidates
// never allocate their display fields; final ordering matches the full sort.
struct RankedRow {
    rank: u8,
    row: home_agents::Row,
}
impl PartialEq for RankedRow {
    fn eq(&self, other: &Self) -> bool {
        self.cmp(other) == Ordering::Equal
    }
}
impl Eq for RankedRow {}
impl PartialOrd for RankedRow {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}
impl Ord for RankedRow {
    fn cmp(&self, other: &Self) -> Ordering {
        self.rank
            .cmp(&other.rank)
            .then_with(|| self.row.key.cmp(&other.row.key))
    }
}
#[derive(Default)]
struct BoundedRows {
    heap: BinaryHeap<RankedRow>,
    seen: usize,
}
impl BoundedRows {
    fn push(&mut self, rank: u8, key: String, build: impl FnOnce(String) -> home_agents::Row) {
        self.seen += 1;
        if self.heap.len() == ROW_LIMIT
            && self
                .heap
                .peek()
                .is_some_and(|worst| (rank, key.as_str()) >= (worst.rank, worst.row.key.as_str()))
        {
            return;
        }
        let candidate = RankedRow {
            rank,
            row: build(key),
        };
        if self.heap.len() < ROW_LIMIT {
            self.heap.push(candidate);
        } else if let Some(mut worst) = self.heap.peek_mut() {
            *worst = candidate;
        }
    }
    fn finish(self) -> (Vec<home_agents::Row>, usize) {
        let omitted = self.seen.saturating_sub(self.heap.len());
        (
            self.heap
                .into_sorted_vec()
                .into_iter()
                .map(|r| r.row)
                .collect(),
            omitted,
        )
    }
}
fn rank(agent: &ObservedAgent) -> u8 {
    if agent.attention
        || matches!(
            agent.activity,
            AgentActivity::Waiting | AgentActivity::Failed
        )
    {
        0
    } else if matches!(agent.activity, AgentActivity::Running) {
        1
    } else {
        2
    }
}
impl Gate {
    pub(super) fn publication(&mut self) -> home_agents::Roster {
        self.publication_matching(|_, _, _| true)
    }
    pub(super) fn publication_matching(
        &mut self,
        matches: impl Fn(&Context, &AgentObservation, &ObservedAgent) -> bool,
    ) -> home_agents::Roster {
        self.revision += 1;
        self.record_controls();
        let observed = self
            .slots
            .iter()
            .filter(|s| matches!(s.observed, Observed::Ready(_)))
            .count();
        let loading = self
            .slots
            .iter()
            .filter(|s| matches!(s.observed, Observed::Loading))
            .count();
        let failed = self
            .slots
            .iter()
            .filter(|s| matches!(s.observed, Observed::Failed))
            .count();
        let truncated = self.total.saturating_sub(self.contexts.len());
        let mut rows = BoundedRows::default();
        for slot in &self.slots {
            let Observed::Ready(result) = &slot.observed else {
                continue;
            };
            for agent in &result.agents {
                if !matches(&slot.context, result, agent) {
                    continue;
                }
                rows.push(rank(agent), self.row_key(&slot.context, agent), |key| {
                    home_agents::Row {
                        key,
                        session_id: slot.context.live.clone(),
                        pane_id: agent.pane_id.clone(),
                        name: display(&agent.name, 160),
                        session_label: display(&slot.context.session_label, 160),
                        machine_label: Some(display(&slot.context.machine_label, 160)),
                        server_label: slot.context.server_label.as_ref().map(|s| display(s, 160)),
                        project_name: Some(display(&result.project_name, 160)),
                        harness: Some(
                            match agent.harness {
                                ObservedHarness::Codex => "codex",
                                ObservedHarness::ClaudeCode => "claude-code",
                                ObservedHarness::Custom => "custom",
                            }
                            .into(),
                        ),
                        team_name: agent.team.as_ref().map(|t| display(&t.name, 160)),
                        status: match agent.activity {
                            AgentActivity::Idle => home_agents::Status::Idle,
                            AgentActivity::Running => home_agents::Status::Working,
                            AgentActivity::Waiting => home_agents::Status::Blocked,
                            AgentActivity::Complete => home_agents::Status::Done,
                            AgentActivity::Failed => home_agents::Status::Failed,
                            AgentActivity::Disconnected => home_agents::Status::Disconnected,
                        },
                        attention: agent.attention,
                        available: available(agent),
                    }
                });
            }
        }
        let (rows, truncated_rows) = rows.finish();
        let visible: std::collections::BTreeSet<_> = rows.iter().map(|r| r.key.as_str()).collect();
        self.published
            .retain(|key, _| visible.contains(key.as_str()));
        // Partial results may publish another session without changing this row.
        // Keep its first publication revision until the observation batch retires.
        for row in &rows {
            self.published
                .entry(row.key.clone())
                .or_insert(self.revision);
        }
        let phase = if failed > 0 && failed == self.slots.len() {
            home_agents::Phase::Unavailable
        } else if observed == 0 && loading > 0 {
            home_agents::Phase::Loading
        } else if failed > 0 || loading > 0 || truncated > 0 || self.incomplete_routes > 0 {
            home_agents::Phase::Partial
        } else {
            home_agents::Phase::Live
        };
        home_agents::Roster {
            revision: self.revision,
            phase,
            rows,
            observed_sessions: observed as u64,
            total_sessions: self.total as u64,
            truncated_sessions: truncated as u64,
            truncated_rows: truncated_rows as u64,
            note: if self.incomplete_routes > 0 {
                Some("Some machine observations are not ready.".into())
            } else if failed > 0 {
                Some("Some agent observations are unavailable. Refresh to retry.".into())
            } else if truncated > 0 {
                Some(format!(
                    "Agent observation covers the first {} sessions.",
                    self.session_limit()
                ))
            } else if loading > 0 {
                Some("Discovering agents…".into())
            } else {
                None
            },
        }
    }
}

#[cfg(test)]
#[path = "browser_native_local_agent_projection_tests.rs"]
mod tests;
