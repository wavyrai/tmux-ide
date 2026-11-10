//! Closing a pane asks first, in a small card anchored to the pane's close
//! button, and says what ends (close-pane cards c1 and c2).
use super::browser::home_agents::{Row, Status};

/// A run of the card's body: plain words, or a command set in the mono face.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum Segment {
    Text(String),
    Code(&'static str),
}

/// What a pane runs, as far as the card can tell: an agent working (or
/// waiting on the user), an agent at rest, or anything else. A shell's
/// foreground command is not reported yet, so "anything else" is generic.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Agent {
    Working,
    AtRest,
}

/// The agent on `pane`, if the workspace roster has one, and its state.
pub(super) fn agent_on<'a>(rows: &'a [Row], pane: &str) -> Option<(&'a Row, Agent)> {
    let row = rows.iter().find(|r| r.pane_id.as_deref() == Some(pane))?;
    let state = if row.attention || matches!(row.status, Status::Working | Status::Blocked) {
        Agent::Working
    } else {
        Agent::AtRest
    };
    Some((row, state))
}

/// The card's body line (c2): what closing ends, and for an agent how to
/// pick its conversation back up.
pub(super) fn body(agent: Option<(&str, Option<&str>, Agent)>) -> Vec<Segment> {
    let text = |s: String| Segment::Text(s);
    let Some((name, harness, state)) = agent else {
        return vec![text("The shell and anything running in it end.".into())];
    };
    let resume = super::agent_resume::resume_command(harness);
    match (state, resume) {
        (Agent::Working, Some(command)) => vec![
            text(format!(
                "{name} is working on this. Closing stops it mid-turn. The conversation is saved; "
            )),
            Segment::Code(command),
            text(" in a new pane picks it up.".into()),
        ],
        (Agent::Working, None) => vec![text(format!(
            "{name} is working on this. The agent stops mid-turn."
        ))],
        (Agent::AtRest, Some(command)) => vec![
            text(format!(
                "{name} has finished. Closing ends the agent; the conversation is saved, and "
            )),
            Segment::Code(command),
            text(" in a new pane picks it up.".into()),
        ],
        (Agent::AtRest, None) => vec![text(format!(
            "{name} has finished. Closing ends the agent."
        ))],
    }
}

/// The card's title: the pane's own label, quoted.
pub(super) fn title(label: &str) -> String {
    format!("Close “{label}”?")
}

#[cfg(test)]
#[path = "pane_close_tests.rs"]
mod tests;
