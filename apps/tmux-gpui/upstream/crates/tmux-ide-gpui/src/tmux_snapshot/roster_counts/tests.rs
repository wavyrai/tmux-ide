use super::*;
use crate::tmux_snapshot::browser::home_agents::Phase;

fn roster(observed: u64, total: u64, sessions: u64, rows: u64) -> Roster {
    Roster {
        revision: 1,
        phase: Phase::Live,
        rows: Vec::new(),
        observed_sessions: observed,
        total_sessions: total,
        truncated_sessions: sessions,
        truncated_rows: rows,
        note: None,
    }
}

#[test]
fn roster_lines_use_singular_only_for_one() {
    type Line = fn(&Roster) -> String;
    let cases: [(Line, Roster, &str); 12] = [
        (
            palette,
            roster(1, 1, 1, 2),
            "1 session observed · 1 session and 2 matching rows omitted",
        ),
        (
            palette,
            roster(2, 2, 2, 1),
            "2 sessions observed · 2 sessions and 1 matching row omitted",
        ),
        (
            attention,
            roster(1, 1, 1, 2),
            "1 of 1 session observed · 1 session and 2 rows omitted",
        ),
        (
            attention,
            roster(1, 2, 2, 1),
            "1 of 2 sessions observed · 2 sessions and 1 row omitted",
        ),
        (home, roster(1, 1, 0, 0), "1 of 1 session observed"),
        (
            home,
            roster(1, 1, 1, 2),
            "1 of 1 session observed · 1 session and 2 rows omitted",
        ),
        (
            home,
            roster(2, 2, 2, 1),
            "2 of 2 sessions observed · 2 sessions and 1 row omitted",
        ),
        (
            fleet_agents,
            roster(1, 1, 1, 2),
            "1 session · 2 agents omitted",
        ),
        (
            fleet_agents,
            roster(2, 2, 2, 1),
            "2 sessions · 1 agent omitted",
        ),
        (workspace_agents, roster(0, 0, 0, 1), "1 agent omitted"),
        (workspace_agents, roster(0, 0, 0, 2), "2 agents omitted"),
        (home, roster(0, 0, 0, 0), "0 of 0 sessions observed"),
    ];
    for (line, r, want) in cases {
        assert_eq!(line(&r), want);
    }
}
