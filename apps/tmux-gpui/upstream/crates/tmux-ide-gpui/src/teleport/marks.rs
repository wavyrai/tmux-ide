//! Which checkouts were teleported away, remembered by this client.
//!
//! Herdr has no notion of a moved or disabled workspace, so the source stays
//! an ordinary workspace (with its programs stopped) and this client marks it.
//! Marks are keyed by the endpoint, repository, and branch, never by
//! workspace id, which does not survive a daemon restart. They load and save
//! on a worker thread; the UI only reads the in-memory list.

use serde::{Deserialize, Serialize};
use std::{
    fs, io,
    path::{Path, PathBuf},
    sync::mpsc::{self, Receiver, Sender, TryRecvError},
    thread,
};

/// Marks kept; the oldest go first beyond this.
const LIMIT: usize = 256;
const FILE: &str = "teleported.json";

/// A checkout on `endpoint` whose work moved to `destination`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct Mark {
    pub(crate) endpoint: String,
    pub(crate) repo_key: String,
    pub(crate) branch: String,
    pub(crate) destination: Destination,
}

/// Where the work went, enough to navigate there again.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct Destination {
    pub(crate) endpoint: String,
    pub(crate) label: String,
    pub(crate) repo_key: String,
    /// The workspace as created; a restarted daemon renumbers it, so lookups
    /// prefer the repository and branch.
    pub(crate) workspace_id: String,
}

#[derive(Default, Serialize, Deserialize)]
struct Stored {
    #[serde(default)]
    marks: Vec<Mark>,
}

pub(crate) struct Marks {
    marks: Vec<Mark>,
    loaded: Option<Receiver<Vec<Mark>>>,
    saves: Option<Sender<Vec<Mark>>>,
}

impl Marks {
    pub(crate) fn start() -> Self {
        Self::at(crate::preferences::state_dir().map(|dir| dir.join(FILE)))
    }

    /// No file behind it: for windows that must not touch the user's state.
    #[cfg(test)]
    pub(crate) fn detached() -> Self {
        Self::at(None)
    }

    fn at(path: Option<PathBuf>) -> Self {
        let (saves, requests) = mpsc::channel::<Vec<Mark>>();
        let (loaded_tx, loaded) = mpsc::channel();
        let spawned = thread::Builder::new()
            .name("gpui-teleport-marks".into())
            .spawn(move || {
                let Some(path) = path else {
                    let _ = loaded_tx.send(Vec::new());
                    return;
                };
                let marks = read(&path).unwrap_or_else(|error| {
                    tracing::warn!(%error, "Cannot read teleport marks");
                    Vec::new()
                });
                let _ = loaded_tx.send(marks);
                for marks in requests {
                    if let Err(error) = write(&path, &marks) {
                        tracing::warn!(%error, "Cannot save teleport marks");
                    }
                }
            });
        if let Err(error) = spawned {
            tracing::warn!(%error, "Cannot start the teleport marks worker");
        }
        Self {
            marks: Vec::new(),
            loaded: Some(loaded),
            saves: Some(saves),
        }
    }

    /// Apply the stored marks once they are read. Returns whether they changed
    /// what the sidebar shows. Marks added before loading finished are kept.
    pub(crate) fn poll(&mut self) -> bool {
        let Some(loaded) = &self.loaded else {
            return false;
        };
        let stored = match loaded.try_recv() {
            Ok(stored) => stored,
            Err(TryRecvError::Empty) => return false,
            Err(TryRecvError::Disconnected) => Vec::new(),
        };
        self.loaded = None;
        let recent = std::mem::replace(&mut self.marks, stored);
        let unsaved = !recent.is_empty();
        for mark in recent {
            self.insert(mark);
        }
        if unsaved {
            self.save();
        }
        true
    }

    pub(crate) fn find(&self, endpoint: &str, repo_key: &str, branch: &str) -> Option<&Mark> {
        self.marks
            .iter()
            .find(|m| m.endpoint == endpoint && m.repo_key == repo_key && m.branch == branch)
    }

    /// The mark whose work arrived at this copy: on `endpoint`, same branch,
    /// and the same repository or, failing a key match, the workspace that
    /// was created for it.
    pub(crate) fn arrived_at(
        &self,
        endpoint: &str,
        repo_key: &str,
        branch: &str,
        workspace_id: &str,
    ) -> Option<&Mark> {
        self.marks.iter().rev().find(|m| {
            m.destination.endpoint == endpoint
                && m.branch == branch
                && (m.destination.repo_key == repo_key
                    || m.destination.workspace_id == workspace_id)
        })
    }

    /// Marks on `endpoint`, for noticing a teleport coming back to them.
    pub(crate) fn on(&self, endpoint: &str) -> impl Iterator<Item = &Mark> {
        self.marks.iter().filter(move |m| m.endpoint == endpoint)
    }

    /// Record a move, replacing any mark for the same checkout.
    pub(crate) fn add(&mut self, mark: Mark) {
        self.insert(mark);
        self.save();
    }

    /// Forget the mark on a checkout, when the work is back or the user asks.
    pub(crate) fn remove(&mut self, endpoint: &str, repo_key: &str, branch: &str) -> bool {
        let before = self.marks.len();
        self.marks
            .retain(|m| !(m.endpoint == endpoint && m.repo_key == repo_key && m.branch == branch));
        let removed = self.marks.len() != before;
        if removed {
            self.save();
        }
        removed
    }

    fn insert(&mut self, mark: Mark) {
        self.marks.retain(|m| {
            !(m.endpoint == mark.endpoint && m.repo_key == mark.repo_key && m.branch == mark.branch)
        });
        self.marks.push(mark);
        if self.marks.len() > LIMIT {
            let excess = self.marks.len() - LIMIT;
            self.marks.drain(..excess);
        }
    }

    fn save(&self) {
        // Saving before the stored marks load would overwrite them.
        if self.loaded.is_some() {
            return;
        }
        if let Some(saves) = &self.saves {
            let _ = saves.send(self.marks.clone());
        }
    }
}

fn read(path: &Path) -> Result<Vec<Mark>, crate::Error> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.into()),
    };
    let mut marks = serde_json::from_slice::<Stored>(&bytes)?.marks;
    if marks.len() > LIMIT {
        marks.drain(..marks.len() - LIMIT);
    }
    Ok(marks)
}

fn write(path: &Path, marks: &[Mark]) -> Result<(), crate::Error> {
    let parent = path.parent().ok_or(crate::Error::PreferencesPath)?;
    fs::create_dir_all(parent)?;
    let json = serde_json::to_vec_pretty(&Stored {
        marks: marks.to_vec(),
    })?;
    // Write beside and rename, so a crash never leaves half a file.
    let temporary = parent.join(format!(".{FILE}-{}.tmp", std::process::id()));
    fs::write(&temporary, json)?;
    fs::rename(&temporary, path)?;
    Ok(())
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    fn mark(endpoint: &str, branch: &str) -> Mark {
        Mark {
            endpoint: endpoint.into(),
            repo_key: "/r/.git".into(),
            branch: branch.into(),
            destination: Destination {
                endpoint: "ssh:box".into(),
                label: "box".into(),
                repo_key: "/home/me/r/.git".into(),
                workspace_id: "w9".into(),
            },
        }
    }

    fn loaded(marks: &mut Marks) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while marks.loaded.is_some() {
            assert!(Instant::now() < deadline, "marks never loaded");
            marks.poll();
            thread::sleep(Duration::from_millis(5));
        }
    }

    #[test]
    fn marks_persist_replace_and_forget() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("gpui").join(FILE);
        let mut marks = Marks::at(Some(path.clone()));
        loaded(&mut marks);
        marks.add(mark("local", "feat"));
        marks.add(mark("local", "other"));
        let mut moved_again = mark("local", "feat");
        moved_again.destination.label = "elsewhere".into();
        marks.add(moved_again);
        assert_eq!(
            marks
                .find("local", "/r/.git", "feat")
                .unwrap()
                .destination
                .label,
            "elsewhere"
        );
        assert!(marks.find("ssh:box", "/r/.git", "feat").is_none());
        assert_eq!(marks.on("local").count(), 2);
        assert!(marks.remove("local", "/r/.git", "other"));
        assert!(!marks.remove("local", "/r/.git", "other"));
        drop(marks);

        // The worker drains its saves before the file is read back.
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let stored = read(&path).unwrap_or_default();
            if stored.len() == 1 {
                assert_eq!(stored[0].branch, "feat");
                break;
            }
            assert!(Instant::now() < deadline, "marks never saved: {stored:?}");
            thread::sleep(Duration::from_millis(5));
        }
        let mut reopened = Marks::at(Some(path));
        loaded(&mut reopened);
        assert!(reopened.find("local", "/r/.git", "feat").is_some());
    }

    #[test]
    fn a_copy_finds_where_its_work_came_from() {
        let mut marks = Marks::at(None);
        loaded(&mut marks);
        marks.add(mark("local", "feat"));
        let found = marks
            .arrived_at("ssh:box", "/home/me/r/.git", "feat", "w1")
            .unwrap();
        assert_eq!(found.endpoint, "local");
        // A key spelled differently still matches the workspace created for it.
        assert!(
            marks
                .arrived_at("ssh:box", "/other/.git", "feat", "w9")
                .is_some()
        );
        assert!(
            marks
                .arrived_at("ssh:box", "/other/.git", "feat", "w1")
                .is_none()
        );
        assert!(
            marks
                .arrived_at("ssh:box", "/home/me/r/.git", "other", "w9")
                .is_none()
        );
        assert!(
            marks
                .arrived_at("local", "/home/me/r/.git", "feat", "w9")
                .is_none()
        );
    }

    #[test]
    fn marks_added_before_loading_are_kept_and_the_list_is_bounded() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE);
        write(&path, &[mark("local", "stored")]).unwrap();
        let mut marks = Marks::at(Some(path));
        marks.add(mark("local", "early"));
        loaded(&mut marks);
        assert!(marks.find("local", "/r/.git", "stored").is_some());
        assert!(marks.find("local", "/r/.git", "early").is_some());
        for index in 0..LIMIT + 5 {
            marks.insert(mark("local", &format!("b{index}")));
        }
        assert_eq!(marks.marks.len(), LIMIT);
        assert!(
            marks.find("local", "/r/.git", "stored").is_none(),
            "oldest go first"
        );
    }
}
