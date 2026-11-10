//! How a harness's conversation is resumed from a new pane: the commands the
//! daemon's restore runs (`packages/daemon/src/restore.ts`,
//! `AGENT_RESUME_COMMANDS`: `claude --resume <id>`, `codex resume <id>`),
//! without the session id, which the app does not have. Claude and Codex only
//! (owner decision); any other harness gets no hint.

/// The command that picks a harness's conversation back up, if known.
pub(super) fn resume_command(harness: Option<&str>) -> Option<&'static str> {
    match harness? {
        "claude-code" | "claude" => Some("claude --resume"),
        "codex" => Some("codex resume"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use core::prelude::v1::test;

    #[test]
    fn claude_and_codex_resume_as_the_daemons_restore_does() {
        assert_eq!(resume_command(Some("claude-code")), Some("claude --resume"));
        assert_eq!(resume_command(Some("codex")), Some("codex resume"));
        for other in ["opencode", "cursor", "copilot", "aider"] {
            assert_eq!(resume_command(Some(other)), None, "{other}");
        }
        assert_eq!(resume_command(None), None);
    }
}
