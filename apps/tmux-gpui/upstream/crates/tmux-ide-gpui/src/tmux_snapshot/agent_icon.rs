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

/// What runs in a pane, for its icon (#746). An agent is known from the
/// daemon's roster; otherwise the pane's own name says it: the daemon names a
/// pane after its process when nothing better is known, and leaves a bare
/// shell a generated name.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(in crate::tmux_snapshot) enum Kind {
    Agent(&'static str),
    Neovim,
    Shell,
    Other,
}
pub(in crate::tmux_snapshot) fn kind(
    harness: Option<&str>,
    pane: Option<&crate::tmux_snapshot::browser::Choice>,
) -> Kind {
    use crate::tmux_snapshot::browser::NameSource;
    if harness.is_some() {
        return Kind::Agent(path(harness));
    }
    let Some(pane) = pane else {
        return Kind::Shell;
    };
    let name = pane.label.trim().to_lowercase();
    let editor = |name: &str| matches!(name, "nvim" | "vim" | "vi" | "neovim");
    match pane.display_name_source {
        Some(NameSource::Process) if editor(&name) => Kind::Neovim,
        Some(NameSource::Process) => Kind::Other,
        // Neovim's own title ends in "NVIM" ("file - NVIM"), Vim's in "VIM".
        Some(NameSource::Title)
            if name
                .rsplit([' ', '-'])
                .next()
                .is_some_and(|last| matches!(last, "nvim" | "vim")) =>
        {
            Kind::Neovim
        }
        _ => Kind::Shell,
    }
}
impl Kind {
    pub(in crate::tmux_snapshot) fn icon(self) -> &'static str {
        match self {
            Self::Agent(path) => path,
            Self::Neovim => "icons/neovim.svg",
            Self::Shell => "icons/terminal.svg",
            Self::Other => "icons/agent-generic.svg",
        }
    }
}

#[cfg(test)]
#[path = "agent_icon_tests.rs"]
mod tests;
