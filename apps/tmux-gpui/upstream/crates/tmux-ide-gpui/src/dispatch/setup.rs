//! The setup script of a worktree created on another host. Scripts run
//! through the connection the window shows, so the setup waits until the
//! window has switched to that host and lists the new workspace, then starts
//! as a local creation's does, asking for trust the same way.

use crate::{
    HerdrWindow,
    teleport::NewCheckout,
    window::Flash,
    worktree_scripts::{Checkout, Launch, ScriptKind},
};
use gpui::Context;
use std::time::{Duration, Instant};

/// How long a setup waits for the window to show its host and workspace.
/// Setups queue behind one another, so this is longer than a follow.
const WAIT: Duration = Duration::from_secs(120);
/// Setups kept waiting at once.
const MAX_WAITING: usize = 8;
const GAVE_UP: &str = "A new worktree's setup script did not start: its host was not shown";

/// A setup script waiting for the window to reach its checkout.
pub(crate) struct Setup {
    pub(crate) endpoint_id: String,
    pub(crate) workspace_id: String,
    pub(crate) repo: String,
    pub(crate) checkout: NewCheckout,
    pub(crate) until: Instant,
}

impl Setup {
    pub(crate) fn new(
        endpoint_id: String,
        workspace_id: String,
        repo: String,
        checkout: NewCheckout,
        now: Instant,
    ) -> Self {
        Self {
            endpoint_id,
            workspace_id,
            repo,
            checkout,
            until: now + WAIT,
        }
    }
}

impl HerdrWindow {
    /// Queue a new worktree's setup behind any still waiting. Setups are
    /// few; beyond [`MAX_WAITING`] the oldest is given up on, with a word.
    pub(crate) fn queue_dispatch_setup(&mut self, setup: Setup, cx: &mut Context<Self>) {
        self.dispatch_setups.push_back(setup);
        if self.dispatch_setups.len() > MAX_WAITING {
            self.dispatch_setups.pop_front();
            self.show_flash(Flash::warning(GAVE_UP), cx);
        }
    }

    /// Start a waiting setup once its host is shown and lists its workspace,
    /// and no other script is starting; the rest keep waiting their turn.
    /// One whose host is not shown within [`WAIT`] is given up on.
    pub(crate) fn poll_dispatch_setup(&mut self, now: Instant, cx: &mut Context<Self>) {
        if self.dispatch_setups.is_empty() {
            return;
        }
        let before = self.dispatch_setups.len();
        self.dispatch_setups.retain(|setup| now < setup.until);
        if self.dispatch_setups.len() < before {
            tracing::warn!("a dispatched worktree's host was never shown for its setup");
            self.show_flash(Flash::warning(GAVE_UP), cx);
        }
        if self.worktree_script.is_some() || !self.live.status.is_connected() {
            return;
        }
        let shown = &self.endpoints[self.selected_endpoint].id;
        let Some(snapshot) = self.live.snapshot.as_ref() else {
            return;
        };
        let ready = self.dispatch_setups.iter().position(|setup| {
            &setup.endpoint_id == shown
                && snapshot
                    .workspaces
                    .iter()
                    .any(|workspace| workspace.workspace_id == setup.workspace_id)
        });
        let boot = snapshot.boot_id.clone();
        let Some(setup) = ready.and_then(|index| self.dispatch_setups.remove(index)) else {
            return;
        };
        let launch = Launch {
            kind: ScriptKind::Setup,
            endpoint: (
                self.selection_epoch,
                self.endpoints[self.selected_endpoint].generation,
            ),
            endpoint_id: setup.endpoint_id,
            boot,
            workspace: setup.workspace_id,
            repo: setup.repo,
            repo_key: setup.checkout.repo_key,
            checkout: Some(Checkout {
                path: setup.checkout.path,
                root: setup.checkout.root,
            }),
            force: false,
            requested: false,
        };
        if let Err(error) = self.start_worktree_script(launch, cx) {
            self.local_error = Some(format!("The setup script did not start: {error}"));
            cx.notify();
        }
    }
}
