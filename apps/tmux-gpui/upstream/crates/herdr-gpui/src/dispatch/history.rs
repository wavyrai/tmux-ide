//! Where each repository's new worktrees went, so the ranking leans towards
//! the host the user keeps choosing. Kept by this client alone, keyed by the
//! repository's name and the endpoint, since repository keys are paths that
//! differ from host to host. Every window shares it.

use crate::state_file;
use gpui::{App, Global};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Picks kept across every repository; the oldest go first beyond this.
const MAX_PICKS: usize = 512;
/// The picks of one repository that count towards its ranking.
const RECENT: usize = 8;
/// Bytes in a repository name or endpoint ID. Longer ones are not recorded.
const MAX_FIELD_BYTES: usize = 512;
/// JSON at most doubles each field's bytes, plus names and punctuation.
const MAX_FILE_BYTES: u64 = (MAX_PICKS * (4 * MAX_FIELD_BYTES + 64) + 64) as u64;
const FILE: &str = "dispatch-history.json";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct Pick {
    pub(crate) repo: String,
    pub(crate) endpoint: String,
}

impl Pick {
    fn valid(&self) -> bool {
        [&self.repo, &self.endpoint]
            .iter()
            .all(|field| !field.is_empty() && field.len() <= MAX_FIELD_BYTES)
    }
}

#[derive(Serialize, Deserialize)]
struct Saved {
    picks: Vec<Pick>,
}

fn parse(bytes: &[u8]) -> crate::Result<Vec<Pick>> {
    let saved: Saved = serde_json::from_slice(bytes)?;
    if saved.picks.len() > MAX_PICKS || !saved.picks.iter().all(Pick::valid) {
        return Err(crate::Error::InvalidDispatchHistory);
    }
    Ok(saved.picks)
}

/// The app's picks, oldest first.
#[derive(Default)]
pub(crate) struct History {
    picks: Vec<Pick>,
    writer: Option<state_file::Writer<Saved>>,
    quitting: bool,
}

impl Global for History {}

impl History {
    fn path() -> Option<PathBuf> {
        crate::preferences::state_dir().map(|dir| dir.join(FILE))
    }

    /// Called before starting GPUI. A missing or damaged file starts empty.
    pub(crate) fn load() -> Self {
        Self::at(Self::path())
    }

    pub(super) fn at(path: Option<PathBuf>) -> Self {
        let picks = path
            .as_deref()
            .map(|path| {
                state_file::read(path, MAX_FILE_BYTES)
                    .and_then(|bytes| bytes.as_deref().map_or(Ok(Vec::new()), parse))
            })
            .transpose()
            .unwrap_or_else(|error| {
                tracing::warn!(%error, "Cannot restore the dispatch history");
                None
            })
            .unwrap_or_default();
        let writer =
            path.and_then(
                |path| match state_file::Writer::start("dispatch-history", path) {
                    Ok(writer) => Some(writer),
                    Err(error) => {
                        tracing::warn!(%error, "Cannot start the dispatch history worker");
                        None
                    }
                },
            );
        Self {
            picks,
            writer,
            quitting: false,
        }
    }

    pub(crate) fn install(self, cx: &mut App) {
        cx.set_global(self);
        cx.on_app_quit(|cx| {
            let history = cx.global_mut::<Self>();
            history.quitting = true;
            let writer = history.writer.take();
            cx.background_executor().spawn(async move {
                if let Some(writer) = writer {
                    writer.finish();
                }
            })
        })
        .detach();
    }

    /// Runs `f` against the app's history, creating an unsaved one for
    /// fixtures that never installed it.
    pub(crate) fn update<R>(cx: &mut App, f: impl FnOnce(&mut Self) -> R) -> R {
        if !cx.has_global::<Self>() {
            cx.set_global(Self::default());
        }
        f(cx.global_mut::<Self>())
    }

    /// Write what was recorded and stop the writer, as quitting does.
    #[cfg(test)]
    pub(super) fn finish(&mut self) {
        if let Some(writer) = self.writer.take() {
            writer.finish();
        }
    }

    /// How many of `repo`'s recent picks went to `endpoint`.
    pub(crate) fn picks(&self, repo: &str, endpoint: &str) -> u32 {
        self.picks
            .iter()
            .rev()
            .filter(|pick| pick.repo == repo)
            .take(RECENT)
            .filter(|pick| pick.endpoint == endpoint)
            .count() as u32
    }

    /// Remember that a new worktree of `repo` went to `endpoint`.
    pub(crate) fn record(&mut self, repo: &str, endpoint: &str) {
        let pick = Pick {
            repo: repo.to_owned(),
            endpoint: endpoint.to_owned(),
        };
        if !pick.valid() {
            return;
        }
        self.picks.push(pick);
        if self.picks.len() > MAX_PICKS {
            let excess = self.picks.len() - MAX_PICKS;
            self.picks.drain(..excess);
        }
        if self.quitting {
            return;
        }
        if let Some(writer) = &self.writer {
            writer.save(Saved {
                picks: self.picks.clone(),
            });
        }
    }
}
