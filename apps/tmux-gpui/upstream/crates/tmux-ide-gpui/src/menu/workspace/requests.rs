//! Carrying a workspace dialog's request to the daemon, and applying the
//! answer to the dialog, or to a removal whose dialog has already closed.

use super::chosen_label;
use crate::{
    HerdrWindow, NavigationTarget,
    dialog_input::DialogInput,
    menu::{Page, Removal, Submission, WorkspaceAction, endpoint_error},
};
use gpui::*;

impl HerdrWindow {
    /// The dialog closes as soon as a removal is queued, so its response is
    /// tracked on the window instead. Only a refusal is reported: success shows
    /// up as the workspace leaving the daemon's snapshot.
    fn update_pending_removal(&mut self, cx: &mut Context<Self>) {
        let Some(removal) = &self.removal else {
            return;
        };
        let current = removal.endpoint
            == (
                self.selection_epoch,
                self.endpoints[self.selected_endpoint].generation,
            )
            && self.live.status.is_connected()
            && self
                .live
                .snapshot
                .as_ref()
                .is_some_and(|snapshot| snapshot.boot_id == removal.boot_id);
        if !current {
            self.removal = None;
            return;
        }
        let Some((id, Some(result))) = &self.live.dialog_response else {
            return;
        };
        if removal.pending.as_deref() != Some(id.as_str()) {
            return;
        }
        let result = result.clone();
        let Some(removal) = self.removal.take() else {
            return;
        };
        let (force, error) = match result {
            Err(error) => (removal.force, error.to_string()),
            Ok(response) => {
                let Some(error) = response.get("error") else {
                    return;
                };
                let (code, message) = endpoint_error(error);
                (
                    removal.force || code == "dirty_worktree_requires_force",
                    format!("{code}: {message}"),
                )
            }
        };
        if force {
            // Keep the record so reopening the dialog asks for the force removal
            // rather than repeating the refused one.
            self.removal = Some(Removal {
                pending: None,
                force,
                ..removal
            });
        }
        self.local_error = Some(format!("Remove worktree: {error}"));
        cx.notify();
    }

    /// Apply the daemon's answer to whichever worktree dialog is waiting for it,
    /// and to a removal whose dialog has already closed.
    pub(crate) fn update_workspace_dialog(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.update_pending_removal(cx);
        if let Some(check) = &mut self.menu.close_check
            && check.poll()
        {
            if check
                .report
                .as_ref()
                .is_some_and(|report| report.needs_consent())
            {
                self.menu.input = Some(DialogInput::new(String::new()));
            }
            cx.notify();
        }
        if self.menu.worktree_open.is_some() && !self.worktree_open_current() {
            self.dismiss_menu(window, cx);
            return;
        }
        if self
            .menu
            .worktree_open
            .as_ref()
            .is_some_and(|picker| picker.pending.is_some())
        {
            if let Some((id, Some(result))) = &self.live.dialog_response {
                self.menu.apply_worktree_list_response(id, result.clone());
                cx.notify();
            }
            return;
        }
        self.apply_checkout_list(cx);
        if self.menu.deletion.is_none() && self.menu.creation.is_none() {
            return;
        }
        if !self.menu_target_current()
            || !self.live.status.is_connected()
            || self.menu.target.as_ref().is_some_and(|target| {
                self.live
                    .snapshot
                    .as_ref()
                    .is_none_or(|snapshot| snapshot.boot_id != target.boot_id)
            })
        {
            self.menu.reset();
            return;
        }
        let Some((id, Some(result))) = &self.live.dialog_response else {
            return;
        };
        if self.menu.deletion.is_some() {
            let (id, result) = (id.clone(), result.clone());
            self.menu.apply_deletion_response(&id, result);
            self.read_archive_script(cx);
            return;
        }
        if self.menu.creation.as_deref() != Some(id.as_str()) {
            return;
        }
        let result = result.clone();
        self.menu.creation = None;
        self.apply_creation_response(result, window, cx);
    }

    /// Follow the checkout the daemon created or opened. The daemon switches its own
    /// session, but this client shell keeps its own location, so the new
    /// workspace is only selected (and revealed in the sidebar) once this
    /// client focuses it.
    pub(in crate::menu) fn apply_creation_response(
        &mut self,
        result: crate::state::DialogResponse,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        // A refused creation leaves the dialog open, so the row it was for is
        // released and the listing can be used again.
        let release = |this: &mut Self, error: String, cx: &mut Context<Self>| {
            if let Some(source) = &mut this.menu.worktree {
                source.pending = None;
            }
            this.menu.error = Some(error);
            cx.notify();
        };
        let response = match result {
            Ok(response) => response,
            Err(error) => return release(self, error.to_string(), cx),
        };
        if let Some(error) = response.get("error") {
            let (code, message) = endpoint_error(error);
            return release(self, format!("{code}: {message}"), cx);
        }
        let result = &response["result"];
        let opening = self.menu.page == Some(Page::Dialog(WorkspaceAction::OpenWorktree))
            || self
                .menu
                .worktree
                .as_ref()
                .and_then(|source| source.pending.as_ref())
                .is_some_and(|pending| pending.opens());
        let expected = if opening {
            "worktree_opened"
        } else {
            "worktree_created"
        };
        let created = (result["type"] == expected)
            .then(|| result["workspace"]["workspace_id"].as_str())
            .flatten()
            .filter(|id| !id.is_empty())
            .map(str::to_owned);
        let Some(created) = created else {
            return release(
                self,
                "Unexpected daemon response. Review current workspace state before retrying."
                    .into(),
                cx,
            );
        };
        // The note names what the checkout is for, so it is taken from the
        // dialog's own pending row before dismissal drops it.
        if !opening {
            self.write_worktree_note(result, cx);
            // Staying put is a pick too, so the ranking learns it.
            if let Some(repo) = self.menu.dispatch_repo() {
                let endpoint = self.endpoints[self.selected_endpoint].id.clone();
                crate::dispatch::History::update(cx, |history| history.record(&repo, &endpoint));
            }
        }
        // Only a new checkout is set up; an opened one already exists as it is.
        let setup = (!opening)
            .then(|| self.setup_launch(result, &created))
            .flatten();
        let endpoint = self.endpoints[self.selected_endpoint].id.clone();
        // A folded group would hide the new checkout the sidebar is about to select.
        let group = self
            .menu
            .target
            .as_ref()
            .and_then(|target| target.worktree.as_ref())
            .map(|worktree| worktree.key.clone())
            .or_else(|| {
                self.menu
                    .worktree_open
                    .as_ref()?
                    .source
                    .as_ref()
                    .map(|source| source.repo_key.clone())
            });
        self.dismiss_menu(window, cx);
        if let Some(group) = group {
            self.collapsed_repos_mut().remove(&group);
        }
        self.navigate_endpoint(&endpoint, NavigationTarget::Workspace(&created), cx);
        if let Some(launch) = setup
            && let Err(error) = self.start_worktree_script(launch, cx)
        {
            self.local_error = Some(format!("The setup script did not start: {error}"));
            cx.notify();
        }
    }

    pub(in crate::menu) fn submit_workspace_dialog(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(Page::Dialog(action)) = self.menu.page else {
            return;
        };
        if action == WorkspaceAction::Note {
            self.save_worktree_note(window, cx);
            return;
        }
        if action == WorkspaceAction::OpenWorktree
            && self
                .menu
                .worktree_open
                .as_ref()
                .is_some_and(|picker| picker.search.read(cx).is_composing())
        {
            return;
        }
        if self
            .menu
            .input
            .as_ref()
            .is_some_and(|input| input.marked.is_some())
            || self
                .menu
                .worktree
                .as_ref()
                .is_some_and(|source| source.name.read(cx).is_composing())
        {
            return;
        }
        let name = self.worktree_name(cx);
        if let Some(endpoint) = self.dispatch_choice(action) {
            match self.submit_dispatch(action, &endpoint, name) {
                Ok(()) => self.local_error = None,
                Err(error) => self.menu.error = Some(error.to_string()),
            }
            cx.notify();
            return;
        }
        let result = (|| {
            if !self.menu_target_current() {
                return Err(crate::Error::StaleConnection);
            }
            if !self.live.status.is_connected() {
                return Err(crate::Error::NotConnected);
            }
            let target = self
                .menu
                .target
                .as_ref()
                .ok_or(crate::Error::StaleWorkspace)?;
            let snapshot = self
                .live
                .snapshot
                .as_ref()
                .ok_or(crate::Error::NoSnapshot)?;
            let text = if action == WorkspaceAction::OpenWorktree {
                self.menu
                    .worktree_open
                    .as_ref()
                    .filter(|picker| picker.pending.is_none())
                    .and_then(|picker| picker.entry(picker.selected))
                    .map(|entry| entry.path.as_str())
                    .ok_or(crate::Error::WorktreeSelection)?
            } else {
                self.menu
                    .input
                    .as_ref()
                    .map(|input| input.text.as_str())
                    .unwrap_or("")
            };
            let (method, mut params) = target.request(snapshot, action, text)?;
            // The daemon names the workspace as it creates it, so no rename follows.
            if action == WorkspaceAction::NewWorktree
                && let Some(name) = name
            {
                params["label"] = name.into();
            }
            if matches!(
                action,
                WorkspaceAction::NewTab | WorkspaceAction::NewWorkspace
            ) && let Some(label) = chosen_label(text, self.menu.suggested_name.as_deref())
            {
                params["label"] = label.into();
            }
            if action == WorkspaceAction::Close {
                let Some(check) = &self.menu.close_check else {
                    return Ok(Submission::Awaiting {
                        focus_changed: false,
                    });
                };
                if !check.current(snapshot, target) {
                    return Err(crate::Error::WorkspaceGroupChanged);
                }
                if !check.ready(text) {
                    return Ok(Submission::Awaiting {
                        focus_changed: false,
                    });
                }
            }
            if action == WorkspaceAction::DeleteWorktree {
                let deletion = self
                    .menu
                    .deletion
                    .as_ref()
                    .ok_or(crate::Error::MissingDeletion)?;
                if deletion.pending.is_some() {
                    return Ok(Submission::Awaiting {
                        focus_changed: false,
                    });
                }
                if !deletion.ready() {
                    return Err(crate::Error::DeletionLookup);
                }
                let force = deletion.force;
                let (boot, workspace) = (target.boot_id.clone(), target.id.clone());
                // With an archive script, the checkout is removed by that
                // script's tab once it succeeds, never before it runs.
                if let Some(config) = deletion.archive.script() {
                    let tree = target.worktree.as_ref();
                    let launch = crate::worktree_scripts::Launch {
                        kind: crate::worktree_scripts::ScriptKind::Archive,
                        endpoint: (
                            self.selection_epoch,
                            self.endpoints[self.selected_endpoint].generation,
                        ),
                        endpoint_id: self.endpoints[self.selected_endpoint].id.clone(),
                        boot,
                        workspace,
                        repo: tree.map_or_else(|| target.label.clone(), |tree| tree.label.clone()),
                        repo_key: tree.map(|tree| tree.key.clone()).unwrap_or_default(),
                        checkout: deletion.path.clone().map(|path| {
                            crate::worktree_scripts::Checkout {
                                path,
                                root: deletion.root.clone(),
                            }
                        }),
                        force,
                        requested: true,
                    };
                    let config = config.clone();
                    self.start_archive_script(launch, config, cx)?;
                    return Ok(Submission::Queued {
                        focus_changed: true,
                    });
                }
                self.queue_worktree_removal(&boot, &workspace, force)?;
                return Ok(Submission::Queued {
                    focus_changed: true,
                });
            }
            if matches!(
                action,
                WorkspaceAction::NewWorktree | WorkspaceAction::OpenWorktree
            ) {
                if self.menu.creation.is_some() {
                    return Ok(Submission::Awaiting {
                        focus_changed: false,
                    });
                }
                // Correlated, so the daemon's failure reaches the dialog and the
                // created checkout can be focused once it exists.
                let id = self.endpoints[self.selected_endpoint]
                    .connection
                    .request_dialog(&target.boot_id, method, params)?;
                self.menu.creation = Some(id);
                self.menu.error = None;
                if let Some(source) = &mut self.menu.worktree {
                    source.superseded();
                }
                return Ok(Submission::Awaiting {
                    focus_changed: true,
                });
            }
            let handle = self.endpoints[self.selected_endpoint]
                .connection
                .handle
                .as_ref()
                .ok_or(crate::Error::NotConnected)?;
            handle
                .request(&target.boot_id, method, params)
                .map(|_| Submission::Queued {
                    focus_changed: action != WorkspaceAction::Rename,
                })
                .map_err(|source| crate::Error::Request { method, source })
        })();
        match result {
            Ok(submission) => {
                self.local_error = None;
                if submission.focus_changed() {
                    self.fence_focus_change(None);
                }
                match submission {
                    // The daemon's snapshot drops the workspace when the removal
                    // lands, so there is nothing left to wait for here.
                    Submission::Queued { .. } => self.dismiss_menu(window, cx),
                    Submission::Awaiting { .. } => cx.notify(),
                }
            }
            Err(error) => {
                self.menu.error = Some(error.to_string());
                cx.notify();
            }
        }
    }
}
