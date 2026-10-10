//! Opening Teleport from a workspace row: what moves, and the repositories
//! every other connected host has open, both read from the GUI snapshots.

use super::Page;
use crate::{
    HerdrWindow,
    teleport::{
        Follow, HostRepositories, Mark, Place, Retired, Source, Teleport, host_for,
        open_repositories,
    },
};
use gpui::{Context, Window};
use std::collections::HashMap;

impl HerdrWindow {
    /// Whether the menu's workspace can be teleported: a linked worktree on
    /// a host Teleport can script. It is offered even with no other host
    /// connected, so the dialog can say why there is nowhere to go.
    pub(super) fn can_teleport(&self) -> bool {
        let Some(target) = &self.menu.target else {
            return false;
        };
        // Host scripts need a POSIX client; see `herdr_client::run_script`.
        cfg!(any(target_os = "linux", target_os = "macos"))
            && target.can_delete()
            && self
                .teleport
                .as_ref()
                .is_none_or(|teleport| !teleport.moving())
            && host_for(&self.endpoints[self.selected_endpoint].connection.target).is_ok()
    }

    /// The teleported mark on the menu's workspace, if its work moved away.
    pub(super) fn teleport_mark(&self) -> Option<&Mark> {
        let target = self.menu.target.as_ref()?;
        self.teleport_marks.find(
            &self.endpoints[self.selected_endpoint].id,
            &target.worktree.as_ref()?.key,
            target.branch.as_deref()?,
        )
    }

    /// Where this copy's work was teleported from, when that host is still
    /// one this window can send it back to.
    pub(super) fn teleport_origin(&self) -> Option<&Mark> {
        let target = self.menu.target.as_ref()?;
        let mark = self.teleport_marks.arrived_at(
            &self.endpoints[self.selected_endpoint].id,
            &target.worktree.as_ref()?.key,
            target.branch.as_deref()?,
            &target.id,
        )?;
        self.endpoints
            .iter()
            .any(|endpoint| endpoint.id == mark.endpoint && endpoint.enabled)
            .then_some(mark)
    }

    /// Teleport, already aimed at the host the work came from.
    pub(super) fn teleport_back(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(origin) = self.teleport_origin().map(|mark| mark.endpoint.clone()) else {
            return;
        };
        self.open_teleport(window, cx);
        if let Some(teleport) = &mut self.teleport {
            teleport.review_host(&origin);
        }
        cx.notify();
    }

    pub(super) fn go_to_teleported(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(mark) = self.teleport_mark().cloned() else {
            return;
        };
        let destination = &mark.destination;
        // A restarted daemon renumbers workspaces; find it by repository and
        // branch when that host's snapshot is at hand.
        let workspace = self
            .endpoints
            .iter()
            .find(|endpoint| endpoint.id == destination.endpoint)
            .and_then(|endpoint| endpoint.live.snapshot.as_ref())
            .and_then(|snapshot| {
                snapshot.workspaces.iter().find(|w| {
                    w.branch.as_deref() == Some(mark.branch.as_str())
                        && w.worktree
                            .as_ref()
                            .is_some_and(|t| t.key == destination.repo_key)
                })
            })
            .map_or_else(
                || destination.workspace_id.clone(),
                |w| w.workspace_id.clone(),
            );
        self.dismiss_menu(window, cx);
        self.teleport_follow = Some(Follow::new(destination.endpoint.clone(), workspace));
        cx.notify();
    }

    pub(super) fn clear_teleport_mark(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(mark) = self.teleport_mark().cloned() {
            self.teleport_marks
                .remove(&mark.endpoint, &mark.repo_key, &mark.branch);
        }
        self.dismiss_menu(window, cx);
    }

    pub(super) fn open_teleport(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(target) = &self.menu.target else {
            return;
        };
        let Some(snapshot) = self.live.snapshot.clone() else {
            return;
        };
        let Some(worktree) = target.worktree.clone() else {
            return;
        };
        let selected = &self.endpoints[self.selected_endpoint];
        let Ok(host) = host_for(&selected.connection.target) else {
            return;
        };
        let workspace = snapshot
            .workspaces
            .iter()
            .find(|workspace| workspace.workspace_id == target.id);
        let tab_labels: HashMap<String, String> = snapshot
            .tabs
            .iter()
            .filter(|tab| tab.workspace_id == target.id && tab.custom_label)
            .map(|tab| (tab.tab_id.clone(), tab.label.clone()))
            .collect();
        let source = Source {
            place: Place {
                endpoint_id: selected.id.clone(),
                label: selected.label.clone(),
                host,
            },
            workspace_id: target.id.clone(),
            custom_label: workspace
                .filter(|workspace| workspace.custom_label)
                .map(|workspace| workspace.label.clone()),
            repo_key: worktree.key.clone(),
            repo_label: worktree.label.clone(),
            branch: target.branch.clone(),
            tab_labels,
        };
        // Every enabled host, connected or not: Teleport reaches each over its
        // own SSH. A connected host's snapshot saves a round trip; the others
        // are read through their CLI. The same machine listed twice is one host.
        let mut hosts: Vec<HostRepositories> = Vec::new();
        for (index, endpoint) in self.endpoints.iter().enumerate() {
            if index == self.selected_endpoint || !endpoint.enabled {
                continue;
            }
            let Ok(host) = host_for(&endpoint.connection.target) else {
                continue;
            };
            if host == source.place.host || hosts.iter().any(|known| known.place.host == host) {
                continue;
            }
            let snapshot = endpoint
                .live
                .snapshot
                .as_ref()
                .filter(|_| endpoint.live.status.is_connected());
            let repositories = snapshot.map(|snapshot| open_repositories(snapshot));
            // Checkouts this client teleported away from, still open there.
            let retired = snapshot
                .map(|snapshot| {
                    self.teleport_marks
                        .on(&endpoint.id)
                        .filter_map(|mark| {
                            let workspace = snapshot.workspaces.iter().find(|w| {
                                w.branch.as_deref() == Some(mark.branch.as_str())
                                    && w.worktree.as_ref().is_some_and(|t| t.key == mark.repo_key)
                            })?;
                            Some(Retired {
                                repo_key: mark.repo_key.clone(),
                                branch: mark.branch.clone(),
                                workspace_id: workspace.workspace_id.clone(),
                            })
                        })
                        .collect()
                })
                .unwrap_or_default();
            hosts.push(HostRepositories {
                place: Place {
                    endpoint_id: endpoint.id.clone(),
                    label: endpoint.label.clone(),
                    host,
                },
                repositories,
                retired,
            });
        }
        let label = target.label.clone();
        self.menu.page = Some(Page::Teleport);
        self.menu.error = None;
        self.teleport = Some(Teleport::start(source, label, hosts));
        window.focus(&self.menu.focus, cx);
        cx.notify();
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests;
