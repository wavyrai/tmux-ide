//! What "Send to agent" hands back: the user's picks and notes as Markdown,
//! written whole so a waiting agent never reads half a file.
use std::{io::Write, path::Path};

/// One variant as the user left it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Choice<'a> {
    pub letter: char,
    pub name: &'a str,
    pub picked: bool,
    pub note: &'a str,
}

/// The whole window as the user left it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Report<'a> {
    pub title: &'a str,
    pub theme: &'a str,
    pub width: &'a str,
    pub choices: Vec<Choice<'a>>,
    pub overall: &'a str,
}

impl Report<'_> {
    /// Every variant is listed, commented or not, so the agent sees what the
    /// user passed over as well as what they chose. Notes are the user's own
    /// single-line text.
    pub(super) fn text(&self) -> String {
        use std::fmt::Write as _;
        let mut text = format!("# Mockup feedback: {}\n\n", self.title);
        let picked: Vec<_> = self
            .choices
            .iter()
            .filter(|choice| choice.picked)
            .map(|choice| choice.letter.to_string())
            .collect();
        let _ = writeln!(
            text,
            "Picked: {}",
            if picked.is_empty() {
                "none".into()
            } else {
                picked.join(", ")
            }
        );
        let _ = writeln!(
            text,
            "Viewed with theme {} at {} width.\n",
            self.theme, self.width
        );
        for choice in &self.choices {
            let _ = write!(text, "- {} ({})", choice.letter, choice.name);
            if choice.picked {
                text.push_str(" [picked]");
            }
            match choice.note.trim() {
                "" => text.push('\n'),
                note => {
                    let _ = writeln!(text, ": {note}");
                }
            }
        }
        let overall = self.overall.trim();
        if !overall.is_empty() {
            let _ = writeln!(text, "\nOverall: {overall}");
        }
        text
    }
}

/// Replaces `path` with `contents` in one rename, next to it on the same
/// volume, so a reader polling for the file never sees part of it.
pub(super) fn write(path: &Path, contents: &[u8]) -> crate::Result<()> {
    let at = |error: std::io::Error| crate::Error::from(error).at_path(path);
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let mut file = tempfile::NamedTempFile::new_in(parent).map_err(at)?;
    file.write_all(contents).map_err(at)?;
    file.as_file().sync_all().map_err(at)?;
    file.persist(path).map_err(|error| at(error.error))?;
    Ok(())
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    fn report<'a>(choices: Vec<Choice<'a>>, overall: &'a str) -> Report<'a> {
        Report {
            title: "Status chip",
            theme: "Nord",
            width: "Design (300 px)",
            choices,
            overall,
        }
    }

    #[test]
    fn lists_every_variant_with_picks_and_notes() {
        let text = report(
            vec![
                Choice {
                    letter: 'A',
                    name: "Pill",
                    picked: false,
                    note: "",
                },
                Choice {
                    letter: 'B',
                    name: "Two-line",
                    picked: true,
                    note: "  branch in accent  ",
                },
                Choice {
                    letter: 'C',
                    name: "Accent bar",
                    picked: true,
                    note: "",
                },
            ],
            " B's text with C's bar ",
        )
        .text();
        assert_eq!(
            text,
            "# Mockup feedback: Status chip\n\n\
             Picked: B, C\n\
             Viewed with theme Nord at Design (300 px) width.\n\n\
             - A (Pill)\n\
             - B (Two-line) [picked]: branch in accent\n\
             - C (Accent bar) [picked]\n\n\
             Overall: B's text with C's bar\n"
        );
    }

    #[test]
    fn says_when_nothing_was_picked_or_said() {
        let text = report(
            vec![Choice {
                letter: 'A',
                name: "Pill",
                picked: false,
                note: " ",
            }],
            "   ",
        )
        .text();
        assert!(text.contains("Picked: none\n"));
        assert!(text.ends_with("- A (Pill)\n"));
        assert!(!text.contains("Overall"));
    }

    #[test]
    fn write_replaces_the_file_whole() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("feedback.md");
        write(&path, b"first").unwrap();
        write(&path, b"second").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "second");
        // Only the file itself remains: no temporary left behind.
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
    }

    #[test]
    fn write_failure_names_the_path_and_keeps_the_cause() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("missing").join("feedback.md");
        let error = write(&path, b"text").unwrap_err();
        let crate::Error::Path {
            path: named,
            source,
        } = &error
        else {
            panic!("expected a path error, got {error:?}");
        };
        assert_eq!(named, &path);
        assert!(matches!(
            source.as_ref(),
            crate::Error::Io(io) if io.kind() == std::io::ErrorKind::NotFound
        ));
    }
}
