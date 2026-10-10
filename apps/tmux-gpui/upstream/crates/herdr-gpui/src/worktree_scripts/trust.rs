//! Which worktree script files the user trusts, remembered by this client.
//!
//! Trust is granted to one file's exact bytes in one repository on one
//! endpoint: a commit that changes `.herdr/worktree.toml` asks again, and a
//! repository with the same path on another host is a different repository.
//! The ledger is app-wide, so every window agrees, and it loads and saves on a
//! worker thread; the UI only reads the in-memory list.

use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    sync::mpsc::{self, Receiver, Sender, TryRecvError},
    thread,
};

/// Grants kept; the oldest go first beyond this.
const LIMIT: usize = 256;
const FILE: &str = "trusted-worktree-scripts.json";
const MAX_FILE_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct Grant {
    pub(crate) endpoint: String,
    pub(crate) repo_key: String,
    pub(crate) digest: String,
}

#[derive(Default, Serialize, Deserialize)]
struct Stored {
    #[serde(default)]
    grants: Vec<Grant>,
}

pub(crate) struct Trust {
    grants: Vec<Grant>,
    loaded: Option<Receiver<Vec<Grant>>>,
    saves: Option<Sender<Vec<Grant>>>,
}

impl gpui::Global for Trust {}

impl Default for Trust {
    /// Tests never read or write the user's state directory.
    fn default() -> Self {
        #[cfg(test)]
        let path = None;
        #[cfg(not(test))]
        let path = crate::preferences::state_dir().map(|dir| dir.join(FILE));
        Self::at(path)
    }
}

impl Trust {
    fn at(path: Option<PathBuf>) -> Self {
        let (saves, requests) = mpsc::channel::<Vec<Grant>>();
        let (loaded_tx, loaded) = mpsc::channel();
        let spawned = thread::Builder::new()
            .name("gpui-worktree-trust".into())
            .spawn(move || {
                let Some(path) = path else {
                    let _ = loaded_tx.send(Vec::new());
                    return;
                };
                let grants = read(&path).unwrap_or_else(|error| {
                    tracing::warn!(%error, "Cannot read trusted worktree scripts");
                    Vec::new()
                });
                let _ = loaded_tx.send(grants);
                for grants in requests {
                    if let Err(error) = crate::state_file::write(&path, &Stored { grants }) {
                        tracing::warn!(%error, "Cannot save trusted worktree scripts");
                    }
                }
            });
        if let Err(error) = spawned {
            tracing::warn!(%error, "Cannot start the worktree trust worker");
        }
        Self {
            grants: Vec::new(),
            loaded: Some(loaded),
            saves: Some(saves),
        }
    }

    /// Apply the stored grants once they are read. Grants added before
    /// loading finished are kept.
    fn poll(&mut self) {
        let Some(loaded) = &self.loaded else {
            return;
        };
        let stored = match loaded.try_recv() {
            Ok(stored) => stored,
            Err(TryRecvError::Empty) => return,
            Err(TryRecvError::Disconnected) => Vec::new(),
        };
        self.loaded = None;
        let recent = std::mem::replace(&mut self.grants, stored);
        let unsaved = !recent.is_empty();
        for grant in recent {
            self.insert(grant);
        }
        if unsaved {
            self.save();
        }
    }

    /// Whether `grant` was given. A ledger still loading trusts nothing yet,
    /// so the worst case is one extra question.
    pub(crate) fn trusts(&mut self, grant: &Grant) -> bool {
        self.poll();
        self.grants.contains(grant)
    }

    pub(crate) fn grant(&mut self, grant: Grant) {
        self.poll();
        self.insert(grant);
        self.save();
    }

    fn insert(&mut self, grant: Grant) {
        self.grants.retain(|g| *g != grant);
        self.grants.push(grant);
        if self.grants.len() > LIMIT {
            let excess = self.grants.len() - LIMIT;
            self.grants.drain(..excess);
        }
    }

    fn save(&self) {
        // Saving before the stored grants load would overwrite them.
        if self.loaded.is_some() {
            return;
        }
        if let Some(saves) = &self.saves {
            let _ = saves.send(self.grants.clone());
        }
    }
}

fn read(path: &Path) -> crate::Result<Vec<Grant>> {
    let Some(bytes) = crate::state_file::read(path, MAX_FILE_BYTES)? else {
        return Ok(Vec::new());
    };
    let mut grants = serde_json::from_slice::<Stored>(&bytes)?.grants;
    if grants.len() > LIMIT {
        grants.drain(..grants.len() - LIMIT);
    }
    Ok(grants)
}

#[cfg(test)]
mod tests;
