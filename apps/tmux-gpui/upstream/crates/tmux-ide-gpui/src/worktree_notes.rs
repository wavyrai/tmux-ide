//! Notes the user keeps on checkouts, to remember what each of many worktrees
//! is for or waiting on. They belong to this client alone: never sent to the
//! daemon nor written into the repository. Like teleport marks they are keyed
//! by endpoint, repository, and branch, because workspace IDs do not survive
//! a daemon restart. Every window shows the same notes.
use crate::state_file;
use gpui::{App, Global};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Notes kept; the least recently edited go first beyond this.
const MAX_NOTES: usize = 512;
/// Characters in one note. A note is a reminder, not a document.
pub(crate) const MAX_CHARS: usize = 500;
/// Bytes in each part of a checkout's key. A longer key gets no note, so
/// every note the store accepts fits in the file it reads back.
const MAX_FIELD_BYTES: usize = 1024;
/// Room for the most notes the store keeps, each as large as it accepts:
/// JSON escapes at most double a string's bytes (quotes and backslashes are
/// one byte each), plus the field names and punctuation.
const MAX_FILE_BYTES: u64 =
    (MAX_NOTES * (2 * (MAX_CHARS * 4 + 3 * MAX_FIELD_BYTES) + 128) + 64) as u64;
const FILE: &str = "worktree-notes.json";

/// The checkout a note is about.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct Checkout {
    pub(crate) endpoint: String,
    pub(crate) repo_key: String,
    pub(crate) branch: String,
}

impl Checkout {
    fn valid(&self) -> bool {
        [&self.endpoint, &self.repo_key, &self.branch]
            .iter()
            .all(|field| !field.is_empty() && field.len() <= MAX_FIELD_BYTES)
    }

    fn is(&self, endpoint: &str, repo_key: &str, branch: &str) -> bool {
        self.endpoint == endpoint && self.repo_key == repo_key && self.branch == branch
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct Note {
    #[serde(flatten)]
    pub(crate) checkout: Checkout,
    pub(crate) text: String,
}

impl Note {
    fn valid(&self) -> bool {
        self.checkout.valid() && clean(&self.text) == self.text && !self.text.is_empty()
    }
}

#[derive(Serialize, Deserialize)]
struct Saved {
    notes: Vec<Note>,
}

/// One line of bounded text, free of control and bidirectional formatting
/// characters, with its runs of whitespace collapsed.
pub(crate) fn clean(text: &str) -> String {
    let spaced: String = text
        .chars()
        .take(MAX_CHARS * 4)
        .map(|c| if c.is_whitespace() { ' ' } else { c })
        .collect();
    crate::notifications::safe_text(&spaced, MAX_CHARS * 4)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(MAX_CHARS)
        .collect::<String>()
        .trim_end()
        .to_owned()
}

fn parse(bytes: &[u8]) -> crate::Result<Vec<Note>> {
    let saved: Saved = serde_json::from_slice(bytes)?;
    if saved.notes.len() > MAX_NOTES || !saved.notes.iter().all(Note::valid) {
        return Err(crate::Error::InvalidWorktreeNotes);
    }
    Ok(saved.notes)
}

/// The app's notes, oldest edit first.
#[derive(Default)]
pub(crate) struct Notes {
    notes: Vec<Note>,
    writer: Option<state_file::Writer<Saved>>,
    quitting: bool,
    /// Counts changes, so a prepared list can tell it is out of date.
    revision: u64,
}

impl Global for Notes {}

impl Notes {
    fn path() -> Option<PathBuf> {
        crate::preferences::state_dir().map(|dir| dir.join(FILE))
    }

    /// Called before starting GPUI, like the browser tabs. A missing or
    /// damaged file starts with no notes.
    pub(crate) fn load() -> Self {
        Self::at(Self::path())
    }

    fn at(path: Option<PathBuf>) -> Self {
        let notes = path
            .as_deref()
            .map(|path| {
                state_file::read(path, MAX_FILE_BYTES)
                    .and_then(|bytes| bytes.as_deref().map_or(Ok(Vec::new()), parse))
            })
            .transpose()
            .unwrap_or_else(|error| {
                tracing::warn!(%error, "Cannot restore worktree notes");
                None
            })
            .unwrap_or_default();
        let writer =
            path.and_then(
                |path| match state_file::Writer::start("worktree-notes", path) {
                    Ok(writer) => Some(writer),
                    Err(error) => {
                        tracing::warn!(%error, "Cannot start the worktree notes worker");
                        None
                    }
                },
            );
        Self {
            notes,
            writer,
            quitting: false,
            revision: 0,
        }
    }

    pub(crate) fn install(self, cx: &mut App) {
        cx.set_global(self);
        cx.on_app_quit(|cx| {
            let notes = cx.global_mut::<Self>();
            notes.quitting = true;
            let writer = notes.writer.take();
            cx.background_executor().spawn(async move {
                if let Some(writer) = writer {
                    writer.finish();
                }
            })
        })
        .detach();
    }

    /// Runs `f` against the app's notes, creating an unsaved set for
    /// fixtures that never installed them.
    pub(crate) fn update<R>(cx: &mut App, f: impl FnOnce(&mut Self) -> R) -> R {
        if !cx.has_global::<Self>() {
            cx.set_global(Self::default());
        }
        f(cx.global_mut::<Self>())
    }

    /// The app's notes, or none for fixtures that never installed them.
    pub(crate) fn of(cx: &App) -> Option<&Self> {
        cx.try_global::<Self>()
    }

    pub(crate) fn get(&self, endpoint: &str, repo_key: &str, branch: &str) -> Option<&str> {
        self.notes
            .iter()
            .find(|note| note.checkout.is(endpoint, repo_key, branch))
            .map(|note| note.text.as_str())
    }

    pub(crate) fn revision(&self) -> u64 {
        self.revision
    }

    /// Every note, most recently edited first.
    pub(crate) fn recent(&self) -> impl Iterator<Item = &Note> {
        self.notes.iter().rev()
    }

    /// Writes `text` as the checkout's note, or removes the note when the
    /// cleaned text is empty. Returns whether anything changed.
    pub(crate) fn set(&mut self, checkout: Checkout, text: &str) -> bool {
        if !checkout.valid() {
            return false;
        }
        let text = clean(text);
        let position = self.notes.iter().position(|note| note.checkout == checkout);
        if position.is_some_and(|index| self.notes[index].text == text) {
            return false;
        }
        if let Some(index) = position {
            self.notes.remove(index);
        } else if text.is_empty() {
            return false;
        }
        if !text.is_empty() {
            self.notes.push(Note { checkout, text });
            if self.notes.len() > MAX_NOTES {
                let excess = self.notes.len() - MAX_NOTES;
                self.notes.drain(..excess);
            }
        }
        self.revision += 1;
        self.save();
        true
    }

    fn save(&self) {
        if self.quitting {
            return;
        }
        if let Some(writer) = &self.writer {
            writer.save(Saved {
                notes: self.notes.clone(),
            });
        }
    }
}

#[cfg(test)]
mod tests;
