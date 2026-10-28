//! The processes below one pane, from one listing of every process on the
//! machine. Parent links come from the same listing as the numbers, so the
//! tree and its CPU and memory describe one moment. Pure, so the tree, its
//! bounds, and the checks that guard a kill are tested without processes.

use std::collections::HashMap;

/// A process exactly: its pid, and when it started. A pid is reused once its
/// process exits; the start time tells the new process from the old one.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub(crate) struct Identity {
    pub pid: u32,
    /// Seconds since the Unix epoch, as the OS reports it.
    pub started: u64,
}

/// One process as the OS listed it.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Entry {
    pub identity: Identity,
    pub parent: Option<u32>,
    pub name: String,
    /// Its arguments joined by spaces; empty when the OS would not say.
    pub command: String,
    /// Share of one core, so a busy multithreaded process exceeds 100. None
    /// until a second listing has measured it.
    pub cpu: Option<f32>,
    /// Resident bytes.
    pub memory: u64,
}

/// One line of the tree: a process and how deep below the pane's root it is.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Row {
    pub entry: Entry,
    /// 0 for the pane's root process.
    pub depth: usize,
    /// In the terminal's foreground job, as the daemon reported it.
    pub foreground: bool,
}

/// The pane's process tree, depth first, oldest sibling first.
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct Listing {
    pub rows: Vec<Row>,
    /// Processes in the tree beyond the row limit, still counted in the totals.
    pub hidden: usize,
    /// Every process in the tree, hidden ones included.
    pub cpu: f32,
    pub memory: u64,
}

impl Listing {
    pub fn root(&self) -> Option<Identity> {
        self.rows.first().map(|row| row.entry.identity)
    }

    pub fn contains(&self, identity: Identity) -> bool {
        self.rows.iter().any(|row| row.entry.identity == identity)
    }
}

/// Every process descended from `root`, and `root` itself, at most `limit`
/// rows of them. None when `root` is not listed: the pane's process exited.
pub(crate) fn listing(
    entries: impl IntoIterator<Item = Entry>,
    root: u32,
    foreground: &[u32],
    limit: usize,
) -> Option<Listing> {
    let mut by_pid: HashMap<u32, Entry> = entries
        .into_iter()
        .map(|entry| (entry.identity.pid, entry))
        .collect();
    let root_entry = by_pid.remove(&root)?;
    let mut children: HashMap<u32, Vec<Entry>> = HashMap::new();
    for entry in by_pid.into_values() {
        if let Some(parent) = entry.parent {
            children.entry(parent).or_default().push(entry);
        }
    }
    for siblings in children.values_mut() {
        // Reversed, so popping from the stack visits the oldest first.
        siblings
            .sort_by_key(|entry| std::cmp::Reverse((entry.identity.started, entry.identity.pid)));
    }
    let mut listing = Listing::default();
    // Each process sits in one parent's list and each list is taken once, so
    // a cycle of reused pids cannot loop, and the root (taken out above)
    // cannot come round again.
    let mut stack = vec![(root_entry, 0)];
    while let Some((entry, depth)) = stack.pop() {
        if let Some(below) = children.remove(&entry.identity.pid) {
            stack.extend(below.into_iter().map(|child| (child, depth + 1)));
        }
        listing.cpu += entry.cpu.unwrap_or(0.);
        listing.memory = listing.memory.saturating_add(entry.memory);
        if listing.rows.len() == limit {
            listing.hidden += 1;
            continue;
        }
        listing.rows.push(Row {
            foreground: foreground.contains(&entry.identity.pid),
            entry,
            depth,
        });
    }
    Some(listing)
}

/// Why a process the user chose is not signalled.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Refusal {
    /// Its pid is gone, or now names another process.
    Exited,
    /// It is the pane's own process, which closing the pane ends.
    Root,
    /// It no longer descends from the pane's process.
    Elsewhere,
    /// The pane's process itself is gone or replaced.
    RootExited,
}

/// Whether `victim` is still the process the user chose, below the pane's
/// `root`, given every process's parent and start time listed just now.
pub(crate) fn check(
    table: &HashMap<u32, (Option<u32>, u64)>,
    root: Identity,
    victim: Identity,
) -> Result<(), Refusal> {
    if victim.pid == root.pid {
        return Err(Refusal::Root);
    }
    if table.get(&root.pid).map(|(_, started)| *started) != Some(root.started) {
        return Err(Refusal::RootExited);
    }
    let Some((mut parent, started)) = table.get(&victim.pid).copied() else {
        return Err(Refusal::Exited);
    };
    if started != victim.started {
        return Err(Refusal::Exited);
    }
    // Every step moves to a distinct pid, so a cycle ends within the table.
    for _ in 0..table.len() {
        match parent {
            Some(pid) if pid == root.pid => return Ok(()),
            Some(pid) => parent = table.get(&pid).and_then(|(parent, _)| *parent),
            None => break,
        }
    }
    Err(Refusal::Elsewhere)
}
