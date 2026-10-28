//! Opening a fan-out from a workspace row: the repository's main checkout
//! creates every lane's worktree, branched from the row's own branch when the
//! row is a linked checkout.

use super::{Page, WorkspaceTarget};
use crate::{
    HerdrWindow,
    dialog_input::DialogInput,
    fan_out::{FanOut, Origin},
    teleport::host_for,
};
use gpui::{Context, Window};

/// What a fan-out branches from.
struct Source {
    workspace_id: String,
    repo_key: String,
    repo_label: String,
    base: String,
}

impl HerdrWindow {
    /// The repository checkout new lanes are created through, when the menu's
    /// workspace has one: its workspace, repository key and label, and base
    /// ref.
    fn fan_out_source(&self) -> Option<Source> {
        let target = self.menu.target.as_ref()?;
        let describe = |source: &WorkspaceTarget| {
            let tree = source.worktree.as_ref();
            Source {
                workspace_id: source.id.clone(),
                repo_key: tree.map(|tree| tree.key.clone()).unwrap_or_default(),
                repo_label: tree.map_or_else(|| source.label.clone(), |tree| tree.label.clone()),
                base: source.base_ref().unwrap_or_else(|_| "HEAD".to_owned()),
            }
        };
        if target.can_create() {
            return Some(describe(target));
        }
        self.linked_new_worktree_target().as_ref().map(describe)
    }

    /// The workspace menu's fan-out row: the comparison of a launched fan-out
    /// while there is one, otherwise a new fan-out from a Git workspace on a
    /// host that can be scripted.
    pub(super) fn fan_out_item(&self) -> Option<&'static str> {
        if self
            .fan_out
            .as_ref()
            .is_some_and(|fan_out| !fan_out.composing())
        {
            return Some("Fan-out comparison...");
        }
        // Host scripts need a POSIX client; see `herdr_client::run_script`.
        let scriptable = cfg!(any(target_os = "linux", target_os = "macos"))
            && host_for(&self.endpoints[self.selected_endpoint].connection.target).is_ok();
        (scriptable && self.fan_out_source().is_some()).then_some("Fan out prompt...")
    }

    pub(super) fn open_fan_out(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self
            .fan_out
            .as_ref()
            .is_some_and(|fan_out| !fan_out.composing())
        {
            self.menu.page = Some(Page::FanOut);
            self.menu.error = None;
            self.menu.input = None;
            window.focus(&self.menu.focus, cx);
            cx.notify();
            return;
        }
        let Some(Source {
            workspace_id,
            repo_key,
            repo_label,
            base,
        }) = self.fan_out_source()
        else {
            return;
        };
        let selected = &self.endpoints[self.selected_endpoint];
        let Ok(host) = host_for(&selected.connection.target) else {
            return;
        };
        let origin = Origin {
            endpoint_id: selected.id.clone(),
            endpoint_label: selected.label.clone(),
            host,
            workspace_id,
            repo_key,
            repo_label,
            base,
        };
        self.menu.page = Some(Page::FanOut);
        self.menu.error = None;
        self.menu.input = Some(DialogInput::default());
        self.fan_out = Some(FanOut::start(origin));
        window.focus(&self.menu.focus, cx);
        cx.notify();
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests;
