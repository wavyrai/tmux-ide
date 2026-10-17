//! Reuse embedded Herdr marks for daemon-provided harness identities only.
use crate::icons::AgentIcon;

pub(in crate::tmux_snapshot) fn path(harness: Option<&str>) -> &'static str {
    // tmux-ide's fleet contract uses `claude-code`; Herdr's asset identity is `claude`.
    let identity = match harness {
        Some("claude-code") => Some("claude"),
        other => other,
    };
    match AgentIcon::from_identity(identity) {
        AgentIcon::Generic => "icons/terminal.svg",
        agent => agent.path(),
    }
}

#[cfg(test)]
#[path = "agent_icon_tests.rs"]
mod tests;
