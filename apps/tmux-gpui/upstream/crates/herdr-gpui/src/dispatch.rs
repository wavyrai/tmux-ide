//! Smart dispatch: which host a new worktree, workspace, or fan-out lane
//! should go to. Hosts are ranked by spare cores from the system-load
//! samples, less what the agents already working there will take and what a
//! clone costs, nudged towards where this repository went before. Ranking is
//! pure; the window gathers the candidates from its endpoints, and the work
//! on another host runs through Teleport's scripts.

mod history;
mod hosts;
mod job;
mod picker;
mod render;
mod setup;

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests;

pub(crate) use {
    history::History,
    job::Job,
    picker::{Picker, Slot},
    setup::Setup,
};

/// A host's load, from its latest system-load sample.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub(crate) struct Load {
    /// Share of all cores busy, 0..=100.
    pub cpu: Option<f32>,
    pub cores: Option<u32>,
    /// The 5 minute load average, where the OS keeps one.
    pub load5: Option<f32>,
    /// Share of memory in use, 0..=100.
    pub memory: Option<f32>,
}

impl Load {
    /// Cores with nothing to run. The 5 minute load average smooths a
    /// momentary spike, so it is preferred over the latest CPU share.
    pub fn spare_cores(self) -> Option<f32> {
        let cores = self.cores? as f32;
        let busy = match (self.load5, self.cpu) {
            (Some(load), _) => load,
            (None, Some(cpu)) => cores * cpu / 100.,
            (None, None) => return None,
        };
        Some((cores - busy).max(0.))
    }
}

/// Whether a host has the repository already, as far as its snapshot shows.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) enum Repository {
    Present,
    /// Connected without it: it would be cloned there first.
    Missing,
    /// Not known until the host is asked.
    #[default]
    Unknown,
}

/// One host a dispatch could go to.
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct Candidate {
    pub endpoint_id: String,
    pub label: String,
    pub online: bool,
    /// The host the window shows, where the dialog would create by default.
    pub current: bool,
    pub load: Option<Load>,
    /// Agents working there now.
    pub working: u32,
    pub repository: Repository,
    /// Recent dispatches of this repository to this host.
    pub picks: u32,
}

/// Cores an agent at work is expected to take on top of today's load: its
/// builds and tests come in bursts the load average has not seen yet.
const AGENT_CORES: f32 = 0.5;
/// What copying the repository first is worth, in cores.
const CLONE_CORES: f32 = 1.;
/// A recent pick of this host for this repository, in cores, up to a cap.
const PICK_CORES: f32 = 0.5;
const MAX_PICKS: u32 = 3;
/// Staying put needs no transfer, so it wins a tie.
const CURRENT_CORES: f32 = 0.25;
/// Memory use beyond which a host's spare cores count half: a new checkout's
/// build would push it into swap.
const MEMORY_TIGHT: f32 = 90.;

impl Candidate {
    /// How much room the host has for one more worktree, in cores. `None`
    /// for an offline host, which cannot take one.
    pub fn score(&self) -> Option<f32> {
        if !self.online {
            return None;
        }
        let load = self.load.unwrap_or_default();
        let mut spare = load.spare_cores().unwrap_or(0.);
        if load.memory.is_some_and(|memory| memory >= MEMORY_TIGHT) {
            spare /= 2.;
        }
        let mut score = spare - AGENT_CORES * self.working as f32
            + PICK_CORES * self.picks.min(MAX_PICKS) as f32;
        if self.repository == Repository::Missing {
            score -= CLONE_CORES;
        }
        if self.current {
            score += CURRENT_CORES;
        }
        Some(score)
    }

    /// Whether the ranking can trust this host's numbers yet.
    pub fn sampled(&self) -> bool {
        !self.online || self.load.and_then(Load::spare_cores).is_some()
    }
}

/// Candidate indices, best first: online hosts by score, ties to the current
/// host and then by label, offline hosts last.
pub(crate) fn rank(candidates: &[Candidate]) -> Vec<usize> {
    let mut order: Vec<usize> = (0..candidates.len()).collect();
    order.sort_by(|&a, &b| {
        let (a, b) = (&candidates[a], &candidates[b]);
        let score = |c: &Candidate| c.score().unwrap_or(f32::NEG_INFINITY);
        score(b)
            .total_cmp(&score(a))
            .then(b.current.cmp(&a.current))
            .then_with(|| a.label.cmp(&b.label))
    });
    order
}

/// Lanes per host when `lanes` agents are spread over `ranked` (best
/// first): each lane goes to the host with the most room left, an agent
/// taking [`AGENT_CORES`] from it. Returns one host index per lane.
pub(crate) fn spread(candidates: &[Candidate], ranked: &[usize], lanes: usize) -> Vec<usize> {
    let mut room: Vec<(usize, f32)> = ranked
        .iter()
        .filter_map(|&index| Some((index, candidates[index].score()?)))
        .collect();
    let mut assigned = Vec::with_capacity(lanes);
    for _ in 0..lanes {
        // The first best wins a tie, so ranking order breaks it.
        let Some(best) = room
            .iter_mut()
            .reduce(|best, next| if next.1 > best.1 { next } else { best })
        else {
            break;
        };
        assigned.push(best.0);
        // A lane costs more than an idle agent: it starts by building.
        best.1 -= 2. * AGENT_CORES;
    }
    assigned
}
