//! The window's side of smart dispatch: gathering every host a repository
//! could go to from the endpoints, describing the chosen one to Teleport's
//! scripts, and following a dispatched job to its new workspace.

use super::{Candidate, History, Load, Picker, Repository, Setup};
use crate::{
    HerdrWindow,
    menu::Page,
    teleport::{FreshOrigin, HostRepositories, Place, host_for, open_repositories},
    window::Flash,
};
use gpui::{App, Context, Window};
use herdr_client::protocol::{AgentStatus, ClientShellSnapshot};
use std::time::Instant;

/// Host scripts need a POSIX client; see `herdr_client::run_script`.
const SCRIPTABLE_CLIENT: bool = cfg!(any(target_os = "linux", target_os = "macos"));

fn working(snapshot: &ClientShellSnapshot) -> u32 {
    snapshot
        .agents
        .iter()
        .filter(|agent| agent.agent_status == AgentStatus::Working)
        .count() as u32
}

fn repository(snapshot: Option<&ClientShellSnapshot>, repo: &str) -> Repository {
    let Some(snapshot) = snapshot else {
        return Repository::Unknown;
    };
    let present = snapshot.workspaces.iter().any(|workspace| {
        workspace
            .worktree
            .as_ref()
            .is_some_and(|tree| tree.label == repo)
    });
    if present {
        Repository::Present
    } else {
        Repository::Missing
    }
}

impl HerdrWindow {
    /// The connected snapshot of endpoint `index`, reading the selected one
    /// from the window's own copy.
    fn endpoint_snapshot(&self, index: usize) -> Option<&ClientShellSnapshot> {
        let live = if index == self.selected_endpoint {
            &self.live
        } else {
            &self.endpoints[index].live
        };
        live.snapshot
            .as_deref()
            .filter(|_| live.status.is_connected())
    }

    /// Every host a new checkout of `repo` could go to: the one shown, and
    /// every other enabled host this client can script. Empty when the
    /// shown host cannot be scripted, since its commit could not be shipped.
    pub(crate) fn dispatch_candidates(&self, repo: &str, cx: &App) -> Vec<Candidate> {
        let current = &self.endpoints[self.selected_endpoint];
        if !SCRIPTABLE_CLIENT || host_for(&current.connection.target).is_err() {
            return Vec::new();
        }
        let history = cx.try_global::<History>();
        self.endpoints
            .iter()
            .enumerate()
            .filter(|(index, endpoint)| {
                *index == self.selected_endpoint
                    || (endpoint.enabled && host_for(&endpoint.connection.target).is_ok())
            })
            .map(|(index, endpoint)| {
                let snapshot = self.endpoint_snapshot(index);
                // A cloud machine has no probed load to rank it by.
                let load = crate::usage::Host::of(&endpoint.connection.target)
                    .and_then(|host| self.system_load.get(&host))
                    .and_then(|reading| reading.latest())
                    .map(|sample| Load {
                        cpu: sample.cpu,
                        cores: sample.cores,
                        load5: sample.load.map(|load| load[1]),
                        memory: sample.memory.map(|memory| memory.percent()),
                    });
                Candidate {
                    endpoint_id: endpoint.id.clone(),
                    label: endpoint.label.clone(),
                    online: snapshot.is_some(),
                    current: index == self.selected_endpoint,
                    load,
                    working: snapshot.map_or(0, working),
                    repository: repository(snapshot, repo),
                    picks: history.map_or(0, |history| history.picks(repo, &endpoint.id)),
                }
            })
            .collect()
    }

    /// The repository a dispatch branches from, on the shown host.
    pub(crate) fn dispatch_origin(
        &self,
        workspace_id: &str,
        repo_key: &str,
        repo_label: &str,
    ) -> Option<FreshOrigin> {
        let selected = &self.endpoints[self.selected_endpoint];
        Some(FreshOrigin {
            place: Place {
                endpoint_id: selected.id.clone(),
                label: selected.label.clone(),
                host: host_for(&selected.connection.target).ok()?,
            },
            workspace_id: workspace_id.to_owned(),
            repo_key: repo_key.to_owned(),
            repo_label: repo_label.to_owned(),
        })
    }

    /// The host `endpoint_id` as Teleport's scripts address it, with the
    /// repositories its snapshot shows when it is connected.
    pub(crate) fn dispatch_destination(&self, endpoint_id: &str) -> Option<HostRepositories> {
        let index = self.endpoints.iter().position(|e| e.id == endpoint_id)?;
        let endpoint = &self.endpoints[index];
        Some(HostRepositories {
            place: Place {
                endpoint_id: endpoint.id.clone(),
                label: endpoint.label.clone(),
                host: host_for(&endpoint.connection.target).ok()?,
            },
            repositories: self.endpoint_snapshot(index).map(open_repositories),
            retired: Vec::new(),
        })
    }

    /// Whether a host picker is open, so every host's load must be sampled
    /// even with the CPU display off.
    pub(crate) fn dispatch_sampling(&self) -> bool {
        self.menu.dispatch.is_some()
            || self
                .fan_out
                .as_ref()
                .is_some_and(|fan_out| fan_out.composing())
    }

    /// Keep open pickers current, and follow a finished job.
    pub(crate) fn poll_dispatch(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let now = Instant::now();
        let dialog = matches!(
            self.menu.page,
            Some(Page::Dialog(
                crate::menu::WorkspaceAction::NewWorktree
                    | crate::menu::WorkspaceAction::NewWorkspace
            ))
        );
        if !dialog {
            self.menu.dispatch = None;
        }
        let repo = self.menu.dispatch_repo();
        if let (Some(repo), true) = (repo, self.menu.dispatch.is_some()) {
            let candidates = self.dispatch_candidates(&repo, cx);
            if let Some(picker) = &mut self.menu.dispatch
                && picker.update(candidates, now)
            {
                cx.notify();
            }
        }
        let composing = self.fan_out.as_ref().filter(|fan_out| fan_out.composing());
        if let Some(repo) = composing.map(|fan_out| fan_out.repo_label().to_owned()) {
            let candidates = self.dispatch_candidates(&repo, cx);
            if let Some(fan_out) = &mut self.fan_out
                && fan_out.update_hosts(candidates, now)
            {
                cx.notify();
            }
        }
        self.poll_dispatch_setup(now, cx);
        let Some(job) = &mut self.dispatch_job else {
            return;
        };
        let (changed, finished) = job.poll();
        let Some(result) = finished else {
            if changed && dialog {
                cx.notify();
            }
            return;
        };
        let (host, repo) = (job.host.clone(), job.repo.clone());
        self.dispatch_job = None;
        match result {
            Ok(created) => {
                History::update(cx, |history| history.record(&repo, &created.endpoint_id));
                if dialog {
                    self.dismiss_menu(window, cx);
                }
                self.show_flash(Flash::success(format!("Created on {host}")), cx);
                // Like a local creation, a new worktree runs its setup script,
                // once the window has followed it there.
                if let Some(checkout) = created.checkout {
                    let setup = Setup::new(
                        created.endpoint_id.clone(),
                        created.workspace_id.clone(),
                        repo,
                        checkout,
                        now,
                    );
                    self.queue_dispatch_setup(setup, cx);
                }
                self.teleport_follow = Some(crate::teleport::Follow::new(
                    created.endpoint_id,
                    created.workspace_id,
                ));
            }
            Err(error) if dialog => {
                self.menu.error = Some(error);
                cx.notify();
            }
            Err(error) => {
                self.show_flash(
                    Flash::warning(format!("Not created on {host}: {error}")),
                    cx,
                );
            }
        }
    }
}

impl Picker {
    /// A picker for a dialog opened on `current`, filled at once.
    pub(crate) fn opened(current: &str, candidates: Vec<Candidate>) -> Option<Self> {
        let now = Instant::now();
        let mut picker = Self::new(current, now);
        picker.update(candidates, now);
        picker.offers_choice().then_some(picker)
    }
}
