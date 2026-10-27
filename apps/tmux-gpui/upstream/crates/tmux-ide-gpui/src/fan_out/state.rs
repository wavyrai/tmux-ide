//! A fan-out's lanes and the host work behind them: what was picked, how far
//! each lane got, and what each changed.
//!
//! Host work runs on named threads, never the UI thread, and reports through
//! a channel drained on the window's tick. A launch or removal is cancelled
//! only when the fan-out is dropped with its window; the agent lookup and
//! change reads stop when the dialog closes.

use super::{
    error::Error,
    job::{self, Checkout, HostStats, Progress, Report, Request},
    plan::{self, DiffStat, Lane, Picks},
};
use crate::{
    dispatch::{Candidate, Picker},
    teleport::{AgentKind, FreshOrigin, Host, HostRepositories, Place},
};
use herdr_client::protocol::{AgentStatus, ClientShellSnapshot};
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    time::{Duration, Instant},
};

/// How often an open comparison rereads every lane's changes.
const REFRESH_EVERY: Duration = Duration::from_secs(10);

/// Where a fan-out runs, captured when the dialog opens.
#[derive(Debug, Clone)]
pub(crate) struct Origin {
    pub(crate) endpoint_id: String,
    pub(crate) endpoint_label: String,
    pub(crate) host: Host,
    /// The main checkout's workspace, which new worktrees are created through.
    pub(crate) workspace_id: String,
    /// The repository's Git common directory, for shipping its commit.
    pub(crate) repo_key: String,
    pub(crate) repo_label: String,
    /// The ref lanes branch from: the linked checkout's branch, or `HEAD`.
    pub(crate) base: String,
}

impl Origin {
    fn fresh(&self) -> FreshOrigin {
        FreshOrigin {
            place: Place {
                endpoint_id: self.endpoint_id.clone(),
                label: self.endpoint_label.clone(),
                host: self.host.clone(),
            },
            workspace_id: self.workspace_id.clone(),
            repo_key: self.repo_key.clone(),
            repo_label: self.repo_label.clone(),
        }
    }
}

enum Event {
    Installed(Result<Vec<AgentKind>, Error>),
    Report(Report),
    Launched,
    Stats(Vec<HostStats>),
    Removed(Vec<(usize, Result<(), Error>)>),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum LaneState {
    Waiting,
    SettingUp,
    CreatingWorktree,
    StartingAgent,
    Prompting,
    Running,
    /// Display text of the failure; the typed error was logged.
    Failed(String),
}

impl LaneState {
    pub(super) fn label(&self) -> &str {
        match self {
            Self::Waiting => "Waiting",
            Self::SettingUp => "Setting up the host",
            Self::CreatingWorktree => "Creating worktree",
            Self::StartingAgent => "Starting agent",
            Self::Prompting => "Sending prompt",
            Self::Running => "Prompted",
            Self::Failed(error) => error,
        }
    }

    pub(super) fn settled(&self) -> bool {
        matches!(self, Self::Running | Self::Failed(_))
    }
}

pub(super) struct LaneView {
    pub(super) lane: Lane,
    pub(super) state: LaneState,
    pub(super) checkout: Option<Checkout>,
    pub(super) stats: Option<DiffStat>,
    /// Why the last comparison could not read this lane's host, as display
    /// text; its previous changes stay shown.
    pub(super) unread: Option<String>,
}

pub(super) enum Stage {
    /// Agents found on the host, still being looked up, or the lookup's
    /// failure.
    Compose(Option<Result<Vec<AgentKind>, String>>),
    Launching,
    Compare,
    /// Asking before the other lanes are removed.
    Confirm(usize),
    Removing(usize),
}

pub(crate) struct FanOut {
    pub(super) origin: Origin,
    pub(super) stage: Stage,
    pub(super) picks: Picks,
    /// Every host lanes could run on, ranked.
    pub(super) hosts: Picker,
    /// Whether lanes are spread over the best hosts instead of the origin.
    pub(super) spread: bool,
    /// Hosts the user chose for single lanes, by lane, over the spread.
    pub(super) overrides: Vec<Option<String>>,
    pub(super) prompt: String,
    pub(super) lanes: Vec<LaneView>,
    /// The commit every lane branched from, once the first one resolved it.
    base: Option<String>,
    pub(super) error: Option<String>,
    sender: mpsc::Sender<Event>,
    events: mpsc::Receiver<Event>,
    /// Cancels the launch or removal only when the window goes away.
    work: Arc<AtomicBool>,
    /// Cancels the agent lookup or a change read when the dialog closes.
    probe: Arc<AtomicBool>,
    probing: bool,
    next_refresh: Option<Instant>,
}

impl Drop for FanOut {
    fn drop(&mut self) {
        self.work.store(true, Ordering::Release);
        self.probe.store(true, Ordering::Release);
    }
}

/// Run `work` on a named background thread.
fn spawn(work: impl FnOnce() + Send + 'static) {
    let spawned = std::thread::Builder::new()
        .name("herdr-fan-out".into())
        .spawn(work);
    if let Err(error) = spawned {
        tracing::warn!(%error, "could not start the fan-out worker");
    }
}

impl FanOut {
    /// Opens on the prompt at once, looking up the host's agents meanwhile.
    pub(crate) fn start(origin: Origin) -> Self {
        let (sender, events) = mpsc::channel();
        let hosts = Picker::new(&origin.endpoint_id, Instant::now());
        let mut fan_out = Self {
            origin,
            stage: Stage::Compose(None),
            picks: Picks::default(),
            hosts,
            spread: false,
            overrides: Vec::new(),
            prompt: String::new(),
            lanes: Vec::new(),
            base: None,
            error: None,
            sender,
            events,
            work: Arc::new(AtomicBool::new(false)),
            probe: Arc::new(AtomicBool::new(false)),
            probing: false,
            next_refresh: None,
        };
        let host = fan_out.origin.host.clone();
        fan_out.probe(move |cancelled| Event::Installed(job::installed(&host, cancelled)));
        fan_out
    }

    /// Whether the user is still composing, so nothing has been created.
    pub(crate) fn composing(&self) -> bool {
        matches!(self.stage, Stage::Compose(_))
    }

    /// Whether host work that must not be abandoned is running.
    pub(crate) fn busy(&self) -> bool {
        matches!(self.stage, Stage::Launching | Stage::Removing(_))
    }

    #[cfg(all(test, any(target_os = "linux", target_os = "macos")))]
    pub(crate) fn base_for_test(&self) -> &str {
        &self.origin.base
    }

    /// Replace the host lookup with `kinds`.
    #[cfg(all(test, any(target_os = "linux", target_os = "macos")))]
    pub(crate) fn agents_for_test(&mut self, kinds: Vec<AgentKind>) {
        self.stop_probe();
        self.stage = Stage::Compose(Some(Ok(kinds)));
    }

    #[cfg(all(test, any(target_os = "linux", target_os = "macos")))]
    pub(crate) fn picked_for_test(&self) -> usize {
        self.picks.total()
    }

    #[cfg(all(test, any(target_os = "linux", target_os = "macos")))]
    pub(crate) fn lane_hosts_for_test(&self) -> Vec<String> {
        self.lane_hosts()
    }

    pub(crate) fn repo_label(&self) -> &str {
        &self.origin.repo_label
    }

    /// Take freshly gathered hosts while composing.
    pub(crate) fn update_hosts(&mut self, candidates: Vec<Candidate>, now: Instant) -> bool {
        self.composing() && self.hosts.update(candidates, now)
    }

    pub(crate) fn hosts_mut(&mut self) -> &mut Picker {
        &mut self.hosts
    }

    /// Whether lanes may go to other hosts at all.
    pub(super) fn can_spread(&self) -> bool {
        self.composing() && self.hosts.offers_choice()
    }

    pub(super) fn toggle_spread(&mut self) -> bool {
        if !self.can_spread() {
            return false;
        }
        self.spread = !self.spread;
        self.overrides.clear();
        self.hosts.close();
        true
    }

    /// Send lane `lane` to `endpoint_id`, over the spread.
    pub(crate) fn assign(&mut self, lane: usize, endpoint_id: &str) -> bool {
        self.hosts.close();
        if !self.spread || self.hosts.online(endpoint_id).is_none() || lane >= self.picks.total() {
            return false;
        }
        self.overrides.resize(self.picks.total(), None);
        self.overrides[lane] = Some(endpoint_id.to_owned());
        true
    }

    /// Each lane's host by endpoint ID, in lane order: the origin unless
    /// spreading, else the spread over the best hosts with the user's
    /// choices on top.
    pub(super) fn lane_hosts(&self) -> Vec<String> {
        let lanes = self.picks.total();
        if !self.spread || !self.hosts.offers_choice() {
            return vec![self.origin.endpoint_id.clone(); lanes];
        }
        let mut hosts = self.hosts.spread(lanes);
        hosts.resize(lanes, self.origin.endpoint_id.clone());
        for (host, chosen) in hosts.iter_mut().zip(&self.overrides) {
            if let Some(chosen) = chosen.as_ref().filter(|id| self.hosts.online(id).is_some()) {
                host.clone_from(chosen);
            }
        }
        hosts
    }

    /// How many hosts the lanes run on.
    pub(super) fn host_count(&self) -> usize {
        let mut hosts = self.lane_hosts();
        hosts.sort();
        hosts.dedup();
        hosts.len()
    }

    fn probe(&mut self, work: impl FnOnce(&AtomicBool) -> Event + Send + 'static) {
        self.probe.store(true, Ordering::Release);
        let cancelled = Arc::new(AtomicBool::new(false));
        self.probe = cancelled.clone();
        self.probing = true;
        let sender = self.sender.clone();
        spawn(move || {
            let _ = sender.send(work(&cancelled));
        });
    }

    /// Stop the agent lookup or change read, as when the dialog closes.
    pub(super) fn stop_probe(&mut self) {
        self.probe.store(true, Ordering::Release);
        self.probing = false;
        self.next_refresh = None;
    }

    pub(super) fn toggle(&mut self, kind: AgentKind, add: bool) -> bool {
        if !self.composing() {
            return false;
        }
        // Lanes shift with every pick, so a lane's chosen host would land
        // on another agent.
        self.overrides.clear();
        if add {
            self.picks.add(kind)
        } else {
            self.picks.remove(kind)
        }
    }

    /// Why the launch cannot start yet, if it cannot.
    pub(super) fn not_ready(&self, prompt: &str) -> Option<&'static str> {
        match &self.stage {
            Stage::Compose(Some(Ok(_))) => {}
            _ => return Some("Waiting for the agent list"),
        }
        if prompt.trim().is_empty() {
            return Some("Write a prompt");
        }
        if self.picks.total() == 0 {
            return Some("Pick at least one agent");
        }
        None
    }

    /// Start every lane. `seed` names the branches; see [`plan::lanes`].
    /// `destination` describes another host lanes go to.
    pub(super) fn launch(
        &mut self,
        prompt: &str,
        seed: u64,
        destination: impl Fn(&str) -> Option<HostRepositories>,
    ) -> bool {
        if self.not_ready(prompt).is_some() {
            return false;
        }
        let mut hosts = Vec::new();
        for endpoint in self.lane_hosts() {
            if endpoint == self.origin.endpoint_id {
                hosts.push(None);
                continue;
            }
            let Some(found) = destination(&endpoint) else {
                self.error = Some(format!("{endpoint} cannot be reached by script"));
                return false;
            };
            hosts.push(Some(found));
        }
        self.stop_probe();
        self.hosts.close();
        let lanes = plan::lanes(&self.picks, seed);
        self.prompt = prompt.trim().to_owned();
        self.lanes = lanes
            .iter()
            .map(|lane| LaneView {
                lane: lane.clone(),
                state: LaneState::Waiting,
                checkout: None,
                stats: None,
                unread: None,
            })
            .collect();
        let request = Request {
            origin: self.origin.fresh(),
            base: self.origin.base.clone(),
            prompt: self.prompt.clone(),
            lanes,
            hosts,
        };
        let (sender, cancelled) = (self.sender.clone(), self.work.clone());
        spawn(move || {
            let report = |report| {
                let _ = sender.send(Event::Report(report));
            };
            job::launch(&request, &report, &cancelled);
            let _ = sender.send(Event::Launched);
        });
        self.stage = Stage::Launching;
        true
    }

    fn checkouts(&self) -> Vec<Option<(Host, String)>> {
        self.lanes
            .iter()
            .map(|lane| {
                lane.checkout
                    .as_ref()
                    .map(|c| (c.host.clone(), c.path.clone()))
            })
            .collect()
    }

    /// Reread every lane's changes when due and nothing else is reading.
    pub(super) fn refresh(&mut self, now: Instant) -> bool {
        let Some(base) = self.base.clone() else {
            return false;
        };
        if self.probing
            || !matches!(self.stage, Stage::Compare | Stage::Confirm(_))
            || self.next_refresh.is_some_and(|next| now < next)
        {
            return false;
        }
        self.next_refresh = Some(now + REFRESH_EVERY);
        let checkouts = self.checkouts();
        self.probe(move |cancelled| Event::Stats(job::stats(&checkouts, &base, cancelled)));
        true
    }

    /// Remove every lane but `winner` that has a checkout.
    pub(super) fn keep(&mut self, winner: usize) -> bool {
        let Stage::Confirm(confirmed) = self.stage else {
            return false;
        };
        if confirmed != winner {
            return false;
        }
        self.stop_probe();
        let doomed: Vec<(usize, Host, String)> = self
            .doomed(winner)
            .into_iter()
            .filter_map(|(index, workspace)| {
                let host = self.lanes[index].checkout.as_ref()?.host.clone();
                Some((index, host, workspace))
            })
            .collect();
        let (sender, cancelled) = (self.sender.clone(), self.work.clone());
        spawn(move || {
            let removed = doomed
                .into_iter()
                .map(|(index, host, workspace)| (index, job::remove(&host, &workspace, &cancelled)))
                .collect();
            let _ = sender.send(Event::Removed(removed));
        });
        self.error = None;
        self.stage = Stage::Removing(winner);
        true
    }

    /// The lanes besides `winner` that have a checkout to remove, with
    /// their workspaces.
    pub(super) fn doomed(&self, winner: usize) -> Vec<(usize, String)> {
        self.lanes
            .iter()
            .enumerate()
            .filter(|(index, _)| *index != winner)
            .filter_map(|(index, lane)| Some((index, lane.checkout.as_ref()?.workspace_id.clone())))
            .collect()
    }

    /// Apply finished work. Returns the kept lane's endpoint and workspace
    /// once every other lane is gone.
    pub(super) fn poll(&mut self) -> (bool, Option<(String, String)>) {
        let mut changed = false;
        while let Ok(event) = self.events.try_recv() {
            changed = true;
            match event {
                Event::Installed(result) => {
                    self.probing = false;
                    if let Stage::Compose(installed) = &mut self.stage {
                        *installed = Some(result.map_err(|error| {
                            tracing::warn!(%error, "fan-out agent lookup");
                            error.to_string()
                        }));
                    }
                }
                Event::Report(Report::Base(commit)) => self.base = Some(commit),
                Event::Report(Report::Lane(index, progress)) => {
                    let Some(lane) = self.lanes.get_mut(index) else {
                        continue;
                    };
                    lane.state = match progress {
                        Progress::SettingUp => LaneState::SettingUp,
                        Progress::CreatingWorktree => LaneState::CreatingWorktree,
                        Progress::Created(checkout) => {
                            lane.checkout = Some(checkout);
                            continue;
                        }
                        Progress::StartingAgent => LaneState::StartingAgent,
                        Progress::Prompting => LaneState::Prompting,
                        Progress::Running => LaneState::Running,
                        Progress::Failed(error) => {
                            tracing::warn!(%error, branch = %lane.lane.branch, "fan-out lane");
                            LaneState::Failed(error.to_string())
                        }
                    };
                }
                Event::Launched => {
                    for lane in &mut self.lanes {
                        if !lane.state.settled() {
                            lane.state = LaneState::Failed("Stopped".to_owned());
                        }
                    }
                    self.stage = Stage::Compare;
                    self.next_refresh = None;
                }
                Event::Stats(hosts) => {
                    self.probing = false;
                    for HostStats { lanes, result } in hosts {
                        match result {
                            Ok(stats) => {
                                for (index, stats) in lanes.into_iter().zip(stats) {
                                    if let Some(lane) = self.lanes.get_mut(index) {
                                        lane.stats = stats;
                                        lane.unread = None;
                                    }
                                }
                            }
                            Err(Error::Cancelled) => {}
                            Err(error) => {
                                tracing::warn!(%error, "fan-out change read");
                                let text = error.to_string();
                                for index in lanes {
                                    if let Some(lane) = self.lanes.get_mut(index) {
                                        lane.unread = Some(text.clone());
                                    }
                                }
                            }
                        }
                    }
                }
                Event::Removed(results) => {
                    let Stage::Removing(winner) = self.stage else {
                        continue;
                    };
                    let mut failures = Vec::new();
                    let mut removed = Vec::new();
                    for (index, result) in results {
                        match result {
                            Ok(()) => removed.push(index),
                            Err(error) => {
                                tracing::warn!(%error, "fan-out removal");
                                failures.push(error.to_string());
                            }
                        }
                    }
                    if failures.is_empty() {
                        let workspace = self.lanes.get(winner).and_then(|lane| {
                            lane.checkout
                                .as_ref()
                                .map(|c| (c.endpoint_id.clone(), c.workspace_id.clone()))
                        });
                        return (true, workspace);
                    }
                    let mut index = 0;
                    let mut kept = winner;
                    self.lanes.retain(|_| {
                        let keep = !removed.contains(&index);
                        if !keep && index < winner {
                            kept -= 1;
                        }
                        index += 1;
                        keep
                    });
                    self.error = Some(format!(
                        "{} worktree(s) could not be removed: {}",
                        failures.len(),
                        failures[0]
                    ));
                    self.stage = Stage::Confirm(kept);
                    self.next_refresh = None;
                }
            }
        }
        (changed, None)
    }
}

fn status_text(status: AgentStatus) -> &'static str {
    match status {
        AgentStatus::Idle => "Idle",
        AgentStatus::Working => "Working",
        AgentStatus::Blocked => "Needs input",
        AgentStatus::Done => "Done",
        AgentStatus::Unknown => "Unknown",
    }
}

/// What a compared lane's agent is doing, from the daemon's own snapshot.
pub(super) fn agent_status(
    snapshot: Option<&ClientShellSnapshot>,
    workspace_id: &str,
) -> &'static str {
    let Some(snapshot) = snapshot else {
        return "Host offline";
    };
    snapshot
        .workspaces
        .iter()
        .find(|workspace| workspace.workspace_id == workspace_id)
        .map_or("Closed", |workspace| status_text(workspace.agent_status))
}

/// Branch names are seeded from the clock, as new worktree names are.
pub(super) fn seed() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_micros().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests;
