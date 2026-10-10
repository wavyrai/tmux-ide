//! Submitting a new worktree or workspace dialog whose host picker chose
//! another host: the work runs as a dispatch job instead of a daemon request.

use super::chosen_label;
use crate::{HerdrWindow, dispatch::Job, menu::WorkspaceAction, teleport::Naming};

impl HerdrWindow {
    /// The other host the dialog's picker chose, when the open form creates
    /// through it. A GitHub listing creates its own checkouts on this host.
    pub(in crate::menu) fn dispatch_choice(&self, action: WorkspaceAction) -> Option<String> {
        let creates = match action {
            WorkspaceAction::NewWorktree => !self.worktree_listing(),
            WorkspaceAction::NewWorkspace => true,
            _ => false,
        };
        creates
            .then(|| self.menu.dispatch.as_ref()?.dispatched())
            .flatten()
            .map(|host| host.endpoint_id.clone())
    }

    /// Start creating on `endpoint_id`. The dialog stays open on the job's
    /// progress, and the window follows the result once it lands.
    pub(in crate::menu) fn submit_dispatch(
        &mut self,
        action: WorkspaceAction,
        endpoint_id: &str,
        name: Option<String>,
    ) -> crate::Result<()> {
        if self.dispatch_job.is_some() {
            return Err(crate::Error::DispatchBusy);
        }
        let target = self
            .menu
            .target
            .as_ref()
            .ok_or(crate::Error::StaleWorkspace)?;
        let tree = target
            .worktree
            .as_ref()
            .ok_or(crate::Error::WorkspaceRepositoryChanged)?;
        let destination = self.dispatch_destination(endpoint_id);
        let origin = self.dispatch_origin(&target.id, &tree.key, &tree.label);
        let (Some(origin), Some(destination)) = (origin, destination) else {
            let label = self
                .endpoints
                .iter()
                .find(|endpoint| endpoint.id == endpoint_id)
                .map_or_else(|| endpoint_id.to_owned(), |e| e.label.clone());
            return Err(crate::Error::DispatchHostUnavailable(label));
        };
        let text = self
            .menu
            .input
            .as_ref()
            .map_or("", |input| input.text.as_str())
            .trim();
        let job = if action == WorkspaceAction::NewWorktree {
            if !text.is_empty() {
                crate::worktree::validate_branch(text)?;
            }
            let naming = Naming {
                branch: (!text.is_empty()).then(|| text.to_owned()),
                label: name,
            };
            Job::worktree(origin, destination, target.base_ref()?, naming)
        } else {
            let label = chosen_label(text, self.menu.suggested_name.as_deref()).map(str::to_owned);
            Job::workspace(origin, destination, label)
        };
        self.dispatch_job = Some(job);
        self.menu.error = None;
        Ok(())
    }
}
