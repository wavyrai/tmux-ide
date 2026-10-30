//! Agent roster count lines, kept apart from their views so each wording is pinned by one table.
use super::browser::home_agents::Roster;
use crate::plural::count;

pub(in crate::tmux_snapshot) fn palette(r: &Roster) -> String {
    format!(
        "{} observed · {} and {} omitted",
        count(r.observed_sessions, "session", "sessions"),
        count(r.truncated_sessions, "session", "sessions"),
        count(r.truncated_rows, "matching row", "matching rows")
    )
}
pub(in crate::tmux_snapshot) fn attention(r: &Roster) -> String {
    format!(
        "{} of {} observed · {} and {} omitted",
        r.observed_sessions,
        count(r.total_sessions, "session", "sessions"),
        count(r.truncated_sessions, "session", "sessions"),
        count(r.truncated_rows, "row", "rows")
    )
}
pub(in crate::tmux_snapshot) fn home(r: &Roster) -> String {
    format!(
        "{} of {} observed{}",
        r.observed_sessions,
        count(r.total_sessions, "session", "sessions"),
        if r.truncated_sessions > 0 || r.truncated_rows > 0 {
            format!(
                " · {} and {} omitted",
                count(r.truncated_sessions, "session", "sessions"),
                count(r.truncated_rows, "row", "rows")
            )
        } else {
            String::new()
        }
    )
}
pub(in crate::tmux_snapshot) fn fleet_agents(r: &Roster) -> String {
    format!(
        "{} · {} omitted",
        count(r.truncated_sessions, "session", "sessions"),
        count(r.truncated_rows, "agent", "agents")
    )
}
pub(in crate::tmux_snapshot) fn workspace_agents(r: &Roster) -> String {
    format!("{} omitted", count(r.truncated_rows, "agent", "agents"))
}

#[cfg(test)]
mod tests;
