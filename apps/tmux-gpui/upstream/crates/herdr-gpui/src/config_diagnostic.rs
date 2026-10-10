//! A config diagnostic prepared for display: each endpoint's daemon
//! `config.toml` diagnostic, and this app's own GUI config warnings.
//!
//! Herdr shows `snapshot.config_diagnostic` for as long as the snapshot carries
//! it and clears it with the first snapshot that does not. This mirrors that,
//! adding only a dismissal that holds for the exact text the user dismissed.
use std::sync::Arc;

/// Bounds the scan as well as the output: daemon text is untrusted.
const MAX_CHARS: usize = 1024;
/// Herdr clips the diagnostic to the rows it has; a banner keeps a few.
const MAX_LINES: usize = 4;
const MAX_LINE_CHARS: usize = 240;

#[derive(Debug, Default)]
pub(crate) struct ConfigDiagnostic {
    /// The raw text last seen, so unchanged text is not reprocessed.
    source: Option<String>,
    /// Display lines prepared from `source`, sanitized and bounded.
    lines: Option<Arc<[String]>>,
    dismissed: bool,
}

impl ConfigDiagnostic {
    /// Follows the current diagnostic text, `None` once it is gone.
    pub(crate) fn sync(&mut self, text: Option<&str>) {
        if self.source.as_deref() == text {
            return;
        }
        // Gone or changed: a dismissal covered only the text it was made on.
        self.dismissed = false;
        self.source = text.map(str::to_owned);
        self.lines = text.and_then(display_lines);
    }

    /// The lines to show, unless dismissed.
    pub(crate) fn visible(&self) -> Option<&Arc<[String]>> {
        self.lines.as_ref().filter(|_| !self.dismissed)
    }

    /// Dismisses `lines` only if they are still what is shown, so a click on a
    /// banner that changed underneath it cannot hide the new text.
    pub(crate) fn dismiss(&mut self, lines: &Arc<[String]>) -> bool {
        let current = self.lines.as_ref().is_some_and(|own| own == lines);
        self.dismissed |= current;
        current
    }
}

fn display_lines(text: &str) -> Option<Arc<[String]>> {
    let bounded: String = text.chars().take(MAX_CHARS).collect();
    let lines: Arc<[String]> = bounded
        .lines()
        .map(|line| crate::notifications::safe_text(line, MAX_LINE_CHARS))
        .filter(|line| !line.trim().is_empty())
        .map(|line| line.trim().to_owned())
        .take(MAX_LINES)
        .collect();
    (!lines.is_empty()).then_some(lines)
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    fn shown(state: &ConfigDiagnostic) -> Option<Vec<String>> {
        state.visible().map(|lines| lines.to_vec())
    }

    #[test]
    fn follows_the_snapshot_and_clears_when_it_disappears() {
        let mut state = ConfigDiagnostic::default();
        state.sync(None);
        assert_eq!(shown(&state), None);
        state.sync(Some("config.toml invalid; using defaults"));
        assert_eq!(
            shown(&state),
            Some(vec!["config.toml invalid; using defaults".into()])
        );
        state.sync(None);
        assert_eq!(shown(&state), None);
        state.sync(Some("again"));
        state.sync(None);
        assert_eq!(shown(&state), None);
    }

    #[test]
    fn dismissal_holds_for_the_same_text_only() {
        let mut state = ConfigDiagnostic::default();
        state.sync(Some("first"));
        let lines = state.visible().unwrap().clone();
        assert!(state.dismiss(&lines));
        assert_eq!(shown(&state), None);
        // Later snapshots repeating the text stay dismissed.
        state.sync(Some("first"));
        assert_eq!(shown(&state), None);
        // New text reappears, and a stale dismissal cannot hide it.
        state.sync(Some("second"));
        assert_eq!(shown(&state), Some(vec!["second".into()]));
        assert!(!state.dismiss(&lines));
        assert_eq!(shown(&state), Some(vec!["second".into()]));
        // Returning to the dismissed text is a change too: it shows again.
        state.sync(Some("first"));
        assert_eq!(shown(&state), Some(vec!["first".into()]));
    }

    #[test]
    fn reappears_after_clearing_even_with_the_dismissed_text() {
        let mut state = ConfigDiagnostic::default();
        state.sync(Some("broken"));
        let lines = state.visible().unwrap().clone();
        state.dismiss(&lines);
        state.sync(None);
        state.sync(Some("broken"));
        assert_eq!(shown(&state), Some(vec!["broken".into()]));
    }

    #[test]
    fn text_is_sanitized_and_bounded() {
        let mut state = ConfigDiagnostic::default();
        let text = format!(
            "  client: bad\u{1b}[31m key \u{202e}x\n\n   \nendpoint: {}\n3\n4\n5\n6",
            "y".repeat(10_000)
        );
        state.sync(Some(&text));
        let lines = shown(&state).unwrap();
        assert_eq!(lines[0], "client: bad[31m key x");
        assert!(lines.iter().all(|line| !line.chars().any(char::is_control)));
        assert!(lines.len() <= MAX_LINES);
        assert_eq!(lines[1].chars().count(), MAX_LINE_CHARS);
        // The oversized line consumed the scan budget, so nothing follows it.
        assert_eq!(lines.len(), 2);

        state.sync(Some("\u{7}\n \t \n"));
        assert_eq!(shown(&state), None);
    }
}
