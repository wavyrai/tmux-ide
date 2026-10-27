//! Editing the note the user keeps on a checkout, from its workspace menu,
//! the sidebar line that shows it, or a shortcut. Notes stay in this app:
//! saving one never reaches the daemon.

use super::{Page, WorkspaceAction};
use crate::{
    HerdrWindow, NavigationTarget,
    worktree_notes::{Checkout, Notes},
};
use gpui::*;

impl HerdrWindow {
    /// The checkout the workspace menu's note is about, once the workspace is
    /// a Git checkout on a branch.
    pub(super) fn note_checkout(&self) -> Option<Checkout> {
        let target = self.menu.target.as_ref()?;
        Some(Checkout {
            endpoint: self.endpoints[self.selected_endpoint].id.clone(),
            repo_key: target.worktree.as_ref()?.key.clone(),
            branch: target.branch.clone()?,
        })
    }

    /// The menu's checkout's current note, if it has one.
    pub(super) fn menu_note<'a>(&self, cx: &'a App) -> Option<&'a str> {
        let checkout = self.note_checkout()?;
        Notes::of(cx)?.get(&checkout.endpoint, &checkout.repo_key, &checkout.branch)
    }

    /// The note dialog's draft: the current note, selected so typing replaces it.
    pub(super) fn note_draft(&self, cx: &App) -> String {
        self.menu_note(cx).unwrap_or_default().to_owned()
    }

    /// Opens the note dialog for `workspace` on `endpoint`, selecting that
    /// workspace first as its menu would.
    pub(crate) fn edit_worktree_note(
        &mut self,
        endpoint: &str,
        workspace: &str,
        anchor: Point<Pixels>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !self.navigate_endpoint(endpoint, NavigationTarget::Workspace(workspace), cx) {
            return;
        }
        self.open_workspace_menu(workspace, anchor, window, cx);
        self.open_note_dialog(window, cx);
    }

    /// Opens the focused workspace's note dialog.
    pub(crate) fn edit_focused_worktree_note(
        &mut self,
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
        self.open_note_dialog(window, cx);
    }

    fn open_note_dialog(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.menu.page != Some(Page::Workspace) {
            return;
        }
        if self.note_checkout().is_none() {
            self.dismiss_menu(window, cx);
            self.show_flash(
                crate::window::Flash::warning("Notes are kept on Git checkouts with a branch"),
                cx,
            );
            return;
        }
        self.open_workspace_dialog(WorkspaceAction::Note, window, cx);
    }

    /// Saves the draft as the checkout's note, or removes the note when the
    /// draft is empty, then closes the dialog.
    pub(super) fn save_worktree_note(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        // A composition still in progress is not text yet.
        if self
            .menu
            .input
            .as_ref()
            .is_some_and(|input| input.marked.is_some())
        {
            return;
        }
        let Some(checkout) = self.note_checkout().filter(|_| self.menu_target_current()) else {
            self.menu.error = Some(crate::Error::StaleConnection.to_string());
            cx.notify();
            return;
        };
        let text = self
            .menu
            .input
            .as_ref()
            .map_or(String::new(), |input| input.text.clone());
        Notes::update(cx, |notes| notes.set(checkout, &text));
        self.dismiss_menu(window, cx);
    }
}
