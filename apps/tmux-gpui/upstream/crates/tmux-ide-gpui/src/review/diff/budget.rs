//! How much of a change is read, and when. The file list comes from
//! `git diff --numstat` and `--name-status`, small whatever the change. The
//! lines are then read a batch of files at a time, each batch one bounded
//! Git call, so no single read holds the whole change. A file too large on
//! its own waits until the user asks for it, and past `EAGER_LINES` files are
//! only read as they scroll into view.
use super::Status;

/// Changed lines a file may have and still be read unasked.
pub(crate) const AUTO_FILE_LINES: u64 = 20_000;
/// A working-tree file larger than this waits to be asked for, whatever
/// its line count: one minified line can be megabytes.
pub(super) const AUTO_FILE_BYTES: u64 = 4 * 1024 * 1024;
/// Changed lines read in the background before the rest wait to be seen.
pub(crate) const EAGER_LINES: u64 = 500_000;
/// Files and changed lines one batch reads at most.
const BATCH_FILES: usize = 64;
const BATCH_LINES: u64 = 20_000;
/// Output one batch's Git call may write, and one file read on request.
pub(super) const BATCH_OUTPUT: usize = 32 * 1024 * 1024;
pub(super) const ASKED_OUTPUT: usize = 128 * 1024 * 1024;
/// Files listed at most; a change past this lists its first files.
pub(super) const MAX_FILES: usize = 50_000;
/// Untracked files listed at most.
pub(super) const MAX_UNTRACKED: usize = 5_000;

/// One file's changed line counts; `None` for a binary file.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Counted {
    pub path: String,
    pub old_path: Option<String>,
    pub added: Option<u64>,
    pub deleted: Option<u64>,
}

impl Counted {
    pub fn lines(&self) -> u64 {
        self.added
            .unwrap_or(0)
            .saturating_add(self.deleted.unwrap_or(0))
    }

    pub fn binary(&self) -> bool {
        self.added.is_none() && self.deleted.is_none()
    }
}

/// Parses `git diff --numstat -z`: `added\tdeleted\tpath\0`, or for a
/// rename `added\tdeleted\t\0old\0new\0`, counted under the new path.
pub(super) fn parse_numstat(text: &str) -> Vec<Counted> {
    let mut counted = Vec::new();
    let mut fields = text.split('\0');
    while let Some(record) = fields.next() {
        let mut parts = record.splitn(3, '\t');
        let (Some(added), Some(deleted), Some(path)) = (parts.next(), parts.next(), parts.next())
        else {
            continue;
        };
        let (path, old_path) = if path.is_empty() {
            // A rename names both sides in the next two fields.
            let (Some(old), Some(new)) = (fields.next(), fields.next()) else {
                break;
            };
            (new.to_owned(), Some(old.to_owned()))
        } else {
            (path.to_owned(), None)
        };
        counted.push(Counted {
            path,
            old_path,
            added: added.parse().ok(),
            deleted: deleted.parse().ok(),
        });
        if counted.len() == MAX_FILES {
            break;
        }
    }
    counted
}

/// Parses `git diff --name-status -z`: `X\0path\0`, or for a rename or copy
/// `R100\0old\0new\0`. Each path after the change, and how it changed.
pub(super) fn parse_name_status(text: &str) -> Vec<(String, Status)> {
    let mut statuses = Vec::new();
    let mut fields = text.split('\0');
    while let Some(code) = fields.next() {
        let status = match code.chars().next() {
            Some('A') => Status::Added,
            Some('D') => Status::Deleted,
            Some('R') => Status::Renamed,
            Some('C') => Status::Added,
            Some(_) => Status::Modified,
            None => continue,
        };
        if matches!(code.chars().next(), Some('R' | 'C')) {
            fields.next();
        }
        let Some(path) = fields.next() else {
            break;
        };
        statuses.push((path.to_owned(), status));
        if statuses.len() == MAX_FILES {
            break;
        }
    }
    statuses
}

/// Whether a file is read only when asked: by its changed lines, or by
/// its size on disk (`bytes`).
pub(super) fn too_large(lines: u64, bytes: Option<u64>) -> bool {
    lines > AUTO_FILE_LINES || bytes.is_some_and(|bytes| bytes > AUTO_FILE_BYTES)
}

/// The next batch from `pending`, each file with its weight in changed
/// lines, in order: as many as fit, and always the first.
pub(crate) fn batch(pending: impl IntoIterator<Item = (usize, u64)>) -> Vec<usize> {
    let mut batch = Vec::new();
    let mut lines = 0_u64;
    for (file, weight) in pending {
        if !batch.is_empty() && (batch.len() == BATCH_FILES || lines + weight > BATCH_LINES) {
            break;
        }
        lines += weight;
        batch.push(file);
    }
    batch
}

/// The pathspec naming `path` alone, matched literally from the top of the
/// repository, so no name can act as a pattern or an option.
pub(super) fn literal(path: &str) -> String {
    format!(":(top,literal){path}")
}
