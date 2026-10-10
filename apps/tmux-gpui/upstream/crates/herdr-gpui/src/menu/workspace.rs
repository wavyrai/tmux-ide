//! The workspace a menu row targets: what may be created or deleted on it,
//! which sibling workspaces close with it, and the dialogs that carry those
//! requests to the daemon and report what came back.

mod dispatch;
pub(super) mod popover;
mod render;
mod requests;
mod scripts;

use super::{Page, WorkspaceAction, WorkspaceMenuAction, state::Deletion};
use crate::{HerdrWindow, dialog_input::DialogInput};
use gpui::{prelude::*, *};
use herdr_client::{
    Method,
    protocol::{ClientShellSnapshot, ClientShellWorkspace, ClientShellWorktree},
};

pub(crate) struct WorkspaceTarget {
    pub(super) boot_id: String,
    pub(super) id: String,
    pub(super) label: String,
    pub(super) worktree: Option<ClientShellWorktree>,
    pub(super) close_members: Vec<String>,
    /// Whether linked worktrees of this parent's repository are open, so its
    /// row folds a group even when another parent closes on its own.
    pub(super) heads_group: bool,
    pub(super) branch: Option<String>,
    /// The branch a new worktree starts from, when it is not this checkout's
    /// `HEAD`: a linked checkout asks its main checkout, the only source the
    /// daemon accepts, to branch from the linked checkout's branch instead.
    pub(super) base: Option<String>,
}

impl WorkspaceTarget {
    pub(super) fn new(snapshot: &ClientShellSnapshot, workspace: &ClientShellWorkspace) -> Self {
        Self {
            boot_id: snapshot.boot_id.clone(),
            id: workspace.workspace_id.clone(),
            label: workspace.label.clone(),
            worktree: workspace.worktree.clone(),
            close_members: close_members(snapshot, workspace),
            heads_group: heads_group(snapshot, workspace),
            branch: workspace.branch.clone(),
            base: None,
        }
    }

    /// The target a new worktree for `workspace` is created through. A linked
    /// checkout resolves to its repository's open main checkout, based on the
    /// linked checkout's branch so the new branch starts where it stands.
    pub(super) fn for_new_worktree(
        snapshot: &ClientShellSnapshot,
        workspace: &ClientShellWorkspace,
    ) -> Result<Self, NewWorktreeUnavailable> {
        let Some(tree) = workspace
            .worktree
            .as_ref()
            .filter(|tree| tree.is_linked_worktree)
        else {
            let target = Self::new(snapshot, workspace);
            return if target.can_create() {
                Ok(target)
            } else {
                Err(NewWorktreeUnavailable::NotGit)
            };
        };
        let branch = workspace
            .branch
            .clone()
            .ok_or(NewWorktreeUnavailable::Detached)?;
        let main = snapshot
            .workspaces
            .iter()
            .find(|w| {
                w.worktree
                    .as_ref()
                    .is_some_and(|other| other.key == tree.key && !other.is_linked_worktree)
            })
            .ok_or(NewWorktreeUnavailable::MainCheckoutClosed)?;
        Ok(Self {
            base: Some(branch),
            ..Self::new(snapshot, main)
        })
    }

    /// The ref a new worktree starts from: a full ref, so a tag of the same
    /// name cannot shadow the branch.
    pub(super) fn base_ref(&self) -> crate::Result<String> {
        match &self.base {
            Some(branch) => {
                crate::worktree::validate_branch(branch)?;
                Ok(format!("refs/heads/{branch}"))
            }
            None => Ok("HEAD".to_owned()),
        }
    }

    /// What the new worktree dialog says it branches from.
    pub(super) fn base_label(&self) -> &str {
        self.base.as_deref().unwrap_or("HEAD")
    }

    pub(super) fn can_create(&self) -> bool {
        // Like the TUI, accept Git branches before worktree metadata is available.
        (self.worktree.is_some() || self.branch.is_some()) && !self.can_delete()
    }

    pub(super) fn can_delete(&self) -> bool {
        self.worktree
            .as_ref()
            .is_some_and(|tree| tree.is_linked_worktree)
    }

    pub(super) fn validate_repository(&self, snapshot: &ClientShellSnapshot) -> crate::Result<()> {
        let workspace = snapshot
            .workspaces
            .iter()
            .find(|workspace| workspace.workspace_id == self.id)
            .filter(|_| snapshot.boot_id == self.boot_id)
            .ok_or(crate::Error::StaleWorkspace)?;
        if !self.can_create()
            || self.worktree != workspace.worktree
            || (workspace.worktree.is_none() && workspace.branch.is_none())
        {
            return Err(crate::Error::WorkspaceRepositoryChanged);
        }
        Ok(())
    }

    /// The worktree key this workspace heads, when linked checkouts hang off it.
    pub(super) fn group_key(&self) -> Option<&str> {
        self.worktree
            .as_ref()
            .filter(|_| self.heads_group)
            .map(|tree| tree.key.as_str())
    }

    pub(super) fn close_label(&self) -> &'static str {
        if self.close_members.len() > 1 {
            "Close group"
        } else {
            "Close"
        }
    }

    pub(super) fn request(
        &self,
        snapshot: &ClientShellSnapshot,
        action: WorkspaceAction,
        text: &str,
    ) -> crate::Result<(Method, serde_json::Value)> {
        let workspace = snapshot
            .workspaces
            .iter()
            .find(|w| w.workspace_id == self.id)
            .filter(|_| snapshot.boot_id == self.boot_id)
            .ok_or(crate::Error::StaleWorkspace)?;
        let params = match action {
            WorkspaceAction::Rename => {
                let label = text.trim();
                if label.is_empty() {
                    return Err(crate::Error::EmptyWorkspaceLabel);
                }
                (
                    Method::WorkspaceRename,
                    serde_json::json!({"workspace_id": self.id, "label": label}),
                )
            }
            WorkspaceAction::Close => {
                if self.worktree != workspace.worktree
                    || self.close_members != close_members(snapshot, workspace)
                {
                    return Err(crate::Error::WorkspaceGroupChanged);
                }
                // The daemon closes every checkout of the repository for a
                // group close, so a parent beside another parent asks for
                // itself alone.
                (
                    Method::WorkspaceClose,
                    serde_json::json!({"workspace_id": self.id, "close_group": self.close_members.len() > 1}),
                )
            }
            WorkspaceAction::NewWorktree => {
                self.validate_repository(snapshot)?;
                let base = self.base_ref()?;
                let mut params = serde_json::json!({"workspace_id": self.id, "base": base, "focus": true, "trust_repository": false});
                if !text.trim().is_empty() {
                    crate::worktree::validate_branch(text.trim())?;
                    params["branch"] = text.trim().into();
                }
                (Method::WorktreeCreate, params)
            }
            WorkspaceAction::OpenWorktree => {
                self.validate_repository(snapshot)?;
                if text.is_empty() {
                    return Err(crate::Error::WorktreeSelection);
                }
                (
                    Method::WorktreeOpen,
                    serde_json::json!({"workspace_id": self.id,
                    "path": text, "focus": true, "trust_repository": false}),
                )
            }
            // The label, when there is one, is added by the dialog that knows
            // which name it proposed.
            WorkspaceAction::NewTab => (
                Method::TabCreate,
                serde_json::json!({"workspace_id": self.id, "focus": true}),
            ),
            WorkspaceAction::NewWorkspace => (
                Method::WorkspaceCreate,
                serde_json::json!({"focus": true, "source_workspace_id": self.id}),
            ),
            WorkspaceAction::Note => return Err(crate::Error::LocalWorktreeNote),
            WorkspaceAction::DeleteWorktree => {
                if !self.can_delete() || self.worktree != workspace.worktree {
                    return Err(crate::Error::WorkspaceCheckoutChanged);
                }
                (
                    Method::WorktreeRemove,
                    serde_json::json!({"workspace_id": self.id, "force": false, "trust_repository": false}),
                )
            }
        };
        Ok(params)
    }
}

/// Why the new worktree shortcut found no workspace to branch from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum NewWorktreeUnavailable {
    Disconnected,
    NoWorkspace,
    NotGit,
    MainCheckoutClosed,
    Detached,
}

impl NewWorktreeUnavailable {
    pub(super) fn message(self) -> &'static str {
        match self {
            Self::Disconnected => "Not connected, so no worktree can be created",
            Self::NoWorkspace => "No workspace is focused to create a worktree from",
            Self::NotGit => "This workspace is not a Git repository",
            Self::MainCheckoutClosed => "Open this repository's main checkout to create a worktree",
            Self::Detached => "This checkout has no branch to start a worktree from",
        }
    }
}

/// The workspace focused when the new worktree shortcut is pressed, once it
/// is known to have a source for one.
fn new_worktree_source(snapshot: &ClientShellSnapshot) -> Result<String, NewWorktreeUnavailable> {
    let focused = snapshot
        .workspaces
        .iter()
        .find(|w| Some(&w.workspace_id) == snapshot.focused_workspace_id.as_ref())
        .ok_or(NewWorktreeUnavailable::NoWorkspace)?;
    WorkspaceTarget::for_new_worktree(snapshot, focused)?;
    Ok(focused.workspace_id.clone())
}

/// The name a new tab dialog proposes: the next number in its workspace, as
/// Herdr numbers an unnamed tab.
pub(super) fn suggested_tab_name(snapshot: &ClientShellSnapshot, workspace: &str) -> String {
    let count = snapshot
        .tabs
        .iter()
        .filter(|tab| tab.workspace_id == workspace)
        .count();
    (count + 1).to_string()
}

/// The name a new workspace dialog proposes: the folder it opens in. Herdr
/// also consults Git there, which only the daemon's host can do, so leaving
/// this proposal unchanged still lets the daemon choose the real name.
pub(super) fn suggested_workspace_name(cwd: &str) -> String {
    let trimmed = cwd.trim_end_matches('/');
    match trimmed.rsplit('/').next() {
        Some(name) if !name.is_empty() => name.to_owned(),
        _ if cwd.is_empty() => "workspace".to_owned(),
        _ => "/".to_owned(),
    }
}

/// The label a creation sends. An empty name or the unchanged proposal sends
/// none, so the daemon names the tab or workspace as Herdr's own prompt does.
pub(super) fn chosen_label<'a>(text: &'a str, suggested: Option<&str>) -> Option<&'a str> {
    let text = text.trim();
    (!text.is_empty() && Some(text) != suggested).then_some(text)
}

/// The workspaces closing `workspace` closes: its whole group when it is its
/// repository's only parent and linked worktrees hang off it, else itself.
/// Like the TUI, a parent beside another parent closes alone.
fn close_members(snapshot: &ClientShellSnapshot, workspace: &ClientShellWorkspace) -> Vec<String> {
    let alone = || vec![workspace.workspace_id.clone()];
    let Some(tree) = workspace
        .worktree
        .as_ref()
        .filter(|tree| !tree.is_linked_worktree)
    else {
        return alone();
    };
    let mut members = Vec::new();
    for w in &snapshot.workspaces {
        match &w.worktree {
            Some(other) if other.key == tree.key => {
                if w.workspace_id != workspace.workspace_id && !other.is_linked_worktree {
                    return alone();
                }
                members.push(w.workspace_id.clone());
            }
            _ => {}
        }
    }
    members.sort();
    members
}

/// Whether `workspace` is a parent with linked worktrees of its repository open.
fn heads_group(snapshot: &ClientShellSnapshot, workspace: &ClientShellWorkspace) -> bool {
    workspace
        .worktree
        .as_ref()
        .filter(|tree| !tree.is_linked_worktree)
        .is_some_and(|tree| {
            snapshot.workspaces.iter().any(|w| {
                w.worktree
                    .as_ref()
                    .is_some_and(|other| other.key == tree.key && other.is_linked_worktree)
            })
        })
}

impl HerdrWindow {
    /// The selected endpoint's workspace a workspace menu is open for. A
    /// hover menu can target a row that is not focused, so the row marks
    /// itself while the pointer is over the menu instead.
    pub(crate) fn workspace_menu_target(&self) -> Option<&str> {
        if self.menu.page != Some(Page::Workspace) {
            return None;
        }
        self.menu.target.as_ref().map(|target| target.id.as_str())
    }

    pub(crate) fn open_workspace_menu(
        &mut self,
        id: &str,
        anchor: Point<Pixels>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.menu.page.is_some() || !self.live.status.is_connected() {
            return;
        }
        let Some(snapshot) = &self.live.snapshot else {
            return;
        };
        let Some(workspace) = snapshot.workspaces.iter().find(|w| w.workspace_id == id) else {
            return;
        };
        self.hover = None;
        self.hover_menu = None;
        self.menu.reset();
        self.menu.endpoint_target = (
            self.selection_epoch,
            self.endpoints[self.selected_endpoint].generation,
        );
        self.menu.target = Some(WorkspaceTarget::new(snapshot, workspace));
        self.menu.anchor = anchor;
        self.menu.page = Some(Page::Workspace);
        self.refresh_workspace_pr();
        self.discard_composition(cx);
        window.focus(&self.menu.focus, cx);
        cx.notify();
    }

    /// Opens the new worktree dialog for the focused workspace, as its menu's
    /// "New worktree" row would. When there is no source for one, a flash says
    /// why rather than the shortcut doing nothing visible.
    pub(crate) fn open_new_worktree(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let source = match &self.live.snapshot {
            Some(snapshot) if self.live.status.is_connected() => new_worktree_source(snapshot),
            _ => Err(NewWorktreeUnavailable::Disconnected),
        };
        let id = match source {
            Ok(id) => id,
            Err(reason) => {
                self.show_flash(crate::window::Flash::warning(reason.message()), cx);
                return;
            }
        };
        self.open_workspace_menu(&id, Point::default(), window, cx);
        if self.menu.page == Some(Page::Workspace) {
            self.open_workspace_dialog(WorkspaceAction::NewWorktree, window, cx);
        }
    }

    /// Opens the focused workspace's rename or close dialog, as its menu's
    /// row would. Closing confirms here as it does from the menu.
    pub(crate) fn open_focused_workspace_dialog(
        &mut self,
        action: WorkspaceAction,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(id) = self
            .live
            .snapshot
            .as_ref()
            .and_then(|snapshot| snapshot.focused_workspace_id.clone())
        else {
            return;
        };
        self.open_workspace_menu(&id, Point::default(), window, cx);
        if self.menu.page == Some(Page::Workspace) {
            self.open_workspace_dialog(action, window, cx);
        }
    }

    /// Asks for a name before `command` creates a tab or workspace, when the
    /// local Herdr config's `ui.prompt_new_tab_name` or
    /// `ui.prompt_new_workspace_name` says to. Returns whether the dialog
    /// opened; otherwise the caller creates at once.
    pub(crate) fn open_name_prompt(
        &mut self,
        command: crate::controls::Command,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        use crate::controls::Command;
        let prompts = self
            .settings
            .shared
            .as_ref()
            .map(|shared| shared.name_prompts)
            .unwrap_or_default();
        let action = match command {
            Command::Tab if prompts.tab => WorkspaceAction::NewTab,
            Command::Workspace if prompts.workspace => WorkspaceAction::NewWorkspace,
            _ => return false,
        };
        // Only where creating at once would be allowed, so the prompt never
        // offers what the command itself would refuse.
        if self.activation_deadline.is_some()
            || !self.endpoints[self.selected_endpoint].surface_requested()
        {
            return false;
        }
        let Some(id) = self
            .live
            .snapshot
            .as_ref()
            .and_then(|snapshot| snapshot.focused_workspace_id.clone())
        else {
            return false;
        };
        self.open_workspace_menu(&id, Point::default(), window, cx);
        if self.menu.page != Some(Page::Workspace) {
            return false;
        }
        self.open_workspace_dialog(action, window, cx);
        true
    }

    /// The actions this workspace offers, in the order the popover shows them
    /// and arrow keys walk them: the tile grid row by row (work, then moving
    /// or leaving), the plain rows, and the destructive action last.
    pub(super) fn workspace_items(&self) -> Vec<(WorkspaceMenuAction, &'static str)> {
        use WorkspaceMenuAction::Dialog;
        let Some(target) = &self.menu.target else {
            return vec![];
        };
        let mut items = Vec::new();
        if target.can_create() || self.linked_new_worktree_target().is_some() {
            items.push((Dialog(WorkspaceAction::NewWorktree), "New worktree"));
        }
        if let Some(label) = self.fan_out_item() {
            items.push((WorkspaceMenuAction::FanOut, label));
        }
        items.push((Dialog(WorkspaceAction::Rename), "Rename"));
        if self.teleport_mark().is_some() {
            items.push((WorkspaceMenuAction::GoToTeleported, "Go to teleported copy"));
            items.push((
                WorkspaceMenuAction::ClearTeleported,
                "Clear teleported mark",
            ));
        } else if self.can_teleport() {
            items.push((WorkspaceMenuAction::Teleport, "Teleport..."));
            if self.teleport_origin().is_some() {
                items.push((WorkspaceMenuAction::TeleportBack, "Teleport back"));
            }
        }
        items.push((Dialog(WorkspaceAction::Close), target.close_label()));
        if self.checkpoint_checkout().is_some() {
            items.push((WorkspaceMenuAction::Checkpoints, "Checkpoints..."));
        }
        if self.note_checkout().is_some() {
            items.push((Dialog(WorkspaceAction::Note), "Note..."));
        }
        if target.can_create() {
            items.push((Dialog(WorkspaceAction::OpenWorktree), "Open worktree..."));
        }
        // Whether the checkout defines scripts is only known once its file is
        // read, so every Git checkout offers them and an absent one says so.
        if target.worktree.is_some() {
            use crate::worktree_scripts::ScriptKind;
            items.push((WorkspaceMenuAction::Script(ScriptKind::Run), "Run script"));
            if target.can_delete() {
                items.push((
                    WorkspaceMenuAction::Script(ScriptKind::Setup),
                    "Run setup script",
                ));
            }
        }
        // Only a workspace that heads a group of checkouts can fold anything.
        if let Some(key) = target.group_key() {
            items.push(if self.collapsed_repos_for_selection().contains(key) {
                (WorkspaceMenuAction::Expand, "Expand group")
            } else {
                (WorkspaceMenuAction::Collapse, "Collapse group")
            });
        }
        if target.can_delete() {
            items.push((
                Dialog(WorkspaceAction::DeleteWorktree),
                "Delete worktree checkout",
            ));
        }
        items
    }

    /// The collapsed set the sidebar paints for the selected endpoint.
    pub(super) fn collapsed_repos_for_selection(&self) -> &std::collections::HashSet<String> {
        if self.selected_endpoint == 0 {
            &self.collapsed_repos
        } else {
            &self.endpoints[self.selected_endpoint].collapsed_repos
        }
    }

    /// The collapsed set the sidebar paints for the selected endpoint.
    pub(super) fn collapsed_repos_mut(&mut self) -> &mut std::collections::HashSet<String> {
        if self.selected_endpoint == 0 {
            &mut self.collapsed_repos
        } else {
            &mut self.endpoints[self.selected_endpoint].collapsed_repos
        }
    }

    pub(super) fn toggle_selected_group(&mut self, cx: &mut Context<Self>) {
        let Some(key) = self
            .menu
            .target
            .as_ref()
            .and_then(|target| target.group_key())
            .map(str::to_owned)
        else {
            return;
        };
        let collapsed = self.collapsed_repos_mut();
        if !collapsed.remove(&key) {
            collapsed.insert(key);
        }
        self.menu.reset();
        cx.notify();
    }

    /// The main-checkout target a linked checkout's menu creates through.
    pub(super) fn linked_new_worktree_target(&self) -> Option<WorkspaceTarget> {
        let target = self
            .menu
            .target
            .as_ref()
            .filter(|target| target.can_delete())?;
        let snapshot = self.live.snapshot.as_ref()?;
        let workspace = snapshot
            .workspaces
            .iter()
            .find(|w| w.workspace_id == target.id && snapshot.boot_id == target.boot_id)?;
        WorkspaceTarget::for_new_worktree(snapshot, workspace).ok()
    }

    pub(super) fn open_workspace_dialog(
        &mut self,
        action: WorkspaceAction,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        // Every listing and request of the dialog goes through the main
        // checkout; only the base remembers the linked checkout.
        if action == WorkspaceAction::NewWorktree
            && let Some(target) = self.linked_new_worktree_target()
        {
            self.menu.target = Some(target);
        }
        let note = (action == WorkspaceAction::Note).then(|| self.note_draft(cx));
        let Some(target) = &self.menu.target else {
            return;
        };
        let workspace = self.live.snapshot.as_ref().and_then(|snapshot| {
            let workspace = snapshot
                .workspaces
                .iter()
                .find(|w| w.workspace_id == target.id && snapshot.boot_id == target.boot_id)?;
            Some((snapshot, workspace))
        });
        // Proposed selected, as Herdr does, so typing replaces it.
        self.menu.suggested_name = match (action, workspace) {
            (WorkspaceAction::NewTab, Some((snapshot, _))) => {
                Some(suggested_tab_name(snapshot, &target.id))
            }
            (WorkspaceAction::NewWorkspace, Some((_, workspace))) => {
                Some(suggested_workspace_name(&workspace.new_workspace_cwd))
            }
            _ => None,
        };
        self.menu.input = match action {
            WorkspaceAction::Rename => Some(DialogInput::new(target.label.clone())),
            WorkspaceAction::NewTab | WorkspaceAction::NewWorkspace => Some(DialogInput::new(
                self.menu.suggested_name.clone().unwrap_or_default(),
            )),
            // Propose the daemon's own branch shape, selected so typing replaces it.
            WorkspaceAction::NewWorktree => {
                Some(DialogInput::new(crate::worktree::proposed_branch()))
            }
            WorkspaceAction::Note => note.map(DialogInput::new),
            WorkspaceAction::Close
            | WorkspaceAction::DeleteWorktree
            | WorkspaceAction::OpenWorktree => None,
        };
        self.menu.page = Some(Page::Dialog(action));
        self.menu.dispatch = matches!(
            action,
            WorkspaceAction::NewWorktree | WorkspaceAction::NewWorkspace
        )
        .then(|| self.menu.dispatch_repo())
        .flatten()
        .and_then(|repo| {
            crate::dispatch::Picker::opened(
                &self.endpoints[self.selected_endpoint].id,
                self.dispatch_candidates(&repo, cx),
            )
        });
        self.menu.pr.clear();
        self.menu.pr_connection = None;
        self.menu.error = None;
        if action == WorkspaceAction::OpenWorktree {
            self.open_existing_worktrees(window, cx);
            return;
        }
        if action == WorkspaceAction::NewWorktree {
            self.open_worktree_source(window, cx);
            cx.notify();
            return;
        }
        if action == WorkspaceAction::Close
            && let Some(snapshot) = &self.live.snapshot
        {
            self.menu.close_check = Some(super::workspace_close::CloseCheck::start(
                snapshot,
                target,
                self.selected_endpoint == 0 && self.live.local_daemon_peer,
                cx,
            ));
        }
        if action == WorkspaceAction::DeleteWorktree {
            let result = self.endpoints[self.selected_endpoint]
                .connection
                .request_dialog(
                    &target.boot_id,
                    Method::WorktreeList,
                    serde_json::json!({"workspace_id": target.id, "trust_repository": false}),
                );
            self.menu.deletion = Some(Deletion::new(
                result.as_ref().ok().cloned(),
                self.removal.as_ref().is_some_and(|removal| {
                    removal.force
                        && removal.workspace == target.id
                        && removal.boot_id == target.boot_id
                }),
            ));
            self.menu.error = result.err().map(|error| error.to_string());
        }
        cx.notify();
    }

    pub(super) fn workspace_menu_actions(&self) -> Vec<WorkspaceMenuAction> {
        let mut actions: Vec<_> = self
            .workspace_items()
            .into_iter()
            .map(|(action, _)| action)
            .collect();
        if self.pr_profile().is_some() && self.menu.pr.value.is_some() {
            actions.push(WorkspaceMenuAction::PullRequest);
        }
        actions
    }

    pub(super) fn activate_workspace_menu(
        &mut self,
        action: WorkspaceMenuAction,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match action {
            WorkspaceMenuAction::Dialog(action) => self.open_workspace_dialog(action, window, cx),
            WorkspaceMenuAction::Collapse | WorkspaceMenuAction::Expand => {
                self.toggle_selected_group(cx)
            }
            WorkspaceMenuAction::PullRequest => self.open_workspace_pr(cx),
            WorkspaceMenuAction::Teleport => self.open_teleport(window, cx),
            WorkspaceMenuAction::GoToTeleported => self.go_to_teleported(window, cx),
            WorkspaceMenuAction::TeleportBack => self.teleport_back(window, cx),
            WorkspaceMenuAction::ClearTeleported => self.clear_teleport_mark(window, cx),
            WorkspaceMenuAction::Checkpoints => self.open_checkpoints(window, cx),
            WorkspaceMenuAction::FanOut => self.open_fan_out(window, cx),
            WorkspaceMenuAction::Script(kind) => self.run_workspace_script(kind, window, cx),
        }
    }
}
