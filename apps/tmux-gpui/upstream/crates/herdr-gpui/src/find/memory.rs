//! What the find bar was doing over each pane, so leaving a pane's tab and
//! coming back finds the bar as it was, and opening it again offers the last
//! query. Pane IDs mean something only within one daemon boot, so a new boot
//! forgets everything, and the oldest panes are forgotten past a fixed count.

use std::collections::VecDeque;

/// Panes remembered at once. Each entry is a pane ID and a query, so the
/// bound only keeps a long session's closed panes from accumulating.
const CAPACITY: usize = 64;

/// How the bar was left over a pane.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Left {
    /// The user closed it; only the query is kept, to be offered again.
    Closed,
    /// It was open when its pane left the screen.
    Open,
    /// It was open and its field held the keyboard.
    Typing,
}

#[derive(Debug)]
struct Entry {
    pane_id: String,
    query: String,
    left: Left,
}

/// The bar to bring back over a pane.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Resume {
    pub(crate) query: String,
    /// Whether the field takes the keyboard back.
    pub(crate) focus: bool,
}

#[derive(Debug, Default)]
pub(crate) struct Memory {
    boot_id: String,
    /// Oldest first.
    entries: VecDeque<Entry>,
}

impl Memory {
    pub(crate) fn remember(&mut self, boot_id: &str, pane_id: &str, query: &str, left: Left) {
        if self.boot_id != boot_id {
            boot_id.clone_into(&mut self.boot_id);
            self.entries.clear();
        }
        self.entries.retain(|entry| entry.pane_id != pane_id);
        if query.is_empty() && left == Left::Closed {
            return;
        }
        if self.entries.len() == CAPACITY {
            self.entries.pop_front();
        }
        self.entries.push_back(Entry {
            pane_id: pane_id.to_owned(),
            query: query.to_owned(),
            left,
        });
    }

    /// The last query searched over `pane_id`, to open the bar with.
    pub(crate) fn query(&self, boot_id: &str, pane_id: &str) -> Option<&str> {
        self.entry(boot_id, pane_id)
            .map(|entry| entry.query.as_str())
    }

    /// The bar to reopen now that `pane_id` is back, if it was left open.
    /// Taking it marks the bar closed, so it comes back once.
    pub(crate) fn resume(&mut self, boot_id: &str, pane_id: &str) -> Option<Resume> {
        if self.boot_id != boot_id {
            return None;
        }
        let entry = self
            .entries
            .iter_mut()
            .find(|entry| entry.pane_id == pane_id)?;
        let focus = match std::mem::replace(&mut entry.left, Left::Closed) {
            Left::Closed => return None,
            Left::Open => false,
            Left::Typing => true,
        };
        Some(Resume {
            query: entry.query.clone(),
            focus,
        })
    }

    fn entry(&self, boot_id: &str, pane_id: &str) -> Option<&Entry> {
        if self.boot_id != boot_id {
            return None;
        }
        self.entries.iter().find(|entry| entry.pane_id == pane_id)
    }
}
