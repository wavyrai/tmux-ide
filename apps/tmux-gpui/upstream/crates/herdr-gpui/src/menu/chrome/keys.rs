//! Keyboard input while a menu page holds focus: the Edit menu's shortcuts
//! and the overlay's key handler, which routes each key to the page that owns
//! it and leaves text editing and composition to the native input handler.

use crate::{
    HerdrWindow, actions,
    menu::{Page, WorkspaceAction},
};
use gpui::*;

impl HerdrWindow {
    /// An Edit menu item while a menu page holds focus. Only the targets the
    /// overlay's key handler gives these shortcuts to are reached: a dialog's
    /// text draft, and the GitHub page's device code for Copy. Search fields
    /// take the action themselves before it bubbles here. Handlers that act
    /// without stopping propagation are never called, so a shortcut the
    /// overlay leaves unhandled cannot run twice through the menu bar.
    pub(super) fn menu_edit(&mut self, key: &str, window: &mut Window, cx: &mut Context<Self>) {
        let event = actions::edit_key(key);
        if self.menu.page == Some(Page::Dialog(WorkspaceAction::OpenWorktree))
            || self.worktree_listing()
        {
            return;
        }
        if let Some(input) = self.menu.input.as_mut() {
            if input.key(&event.keystroke, cx) {
                cx.notify();
            }
            return;
        }
        if self.menu.page == Some(Page::GitHub) {
            self.github_key(&event, window, cx);
        }
    }

    pub(super) fn menu_key_down(
        &mut self,
        event: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.settings_key(event, window, cx) {
            return;
        }
        if self.menu.page == Some(Page::Dialog(WorkspaceAction::OpenWorktree))
            && (self
                .menu
                .worktree_open
                .as_ref()
                .is_some_and(|picker| picker.search.read(cx).is_composing())
                || !matches!(
                    event.keystroke.key.as_str(),
                    "escape" | "enter" | "up" | "down"
                ))
        {
            // SearchInput and the platform own text editing and composition.
            return;
        }
        // A listing has its own search field, so the branch draft must
        // not consume the keys typed into it.
        if self.worktree_source_key(event, window, cx) {
            cx.stop_propagation();
            window.prevent_default();
            return;
        }
        let listing = self.worktree_listing() || self.worktree_search_focused(window, cx);
        // The shared search owns its own typing, so everything the list
        // itself does not own must reach the native text handler.
        if listing
            && (self.worktree_source_composing(cx) || event.keystroke.key.as_str() != "escape")
        {
            return;
        }
        // The name field edits itself; only Escape and Enter are left
        // for the dialog, and neither may reach the branch draft.
        let naming = self.worktree_name_focused(window, cx);
        if naming
            && (self
                .menu
                .worktree
                .as_ref()
                .is_some_and(|source| source.name.read(cx).is_composing())
                || !matches!(event.keystroke.key.as_str(), "escape" | "enter"))
        {
            return;
        }
        if let Some(input) = self.menu.input.as_mut().filter(|_| !listing && !naming) {
            if input.key(&event.keystroke, cx) {
                cx.stop_propagation();
                window.prevent_default();
                cx.notify();
                return;
            }
            // Let the platform deliver printable text and IME navigation/commit.
            if input.marked.is_some() || !matches!(event.keystroke.key.as_str(), "escape" | "enter")
            {
                return;
            }
        }
        if self.menu.page == Some(Page::Git) {
            self.git_key(event, window, cx);
            return;
        }
        if self.menu.page == Some(Page::Teleport) {
            self.teleport_key(event, window, cx);
            return;
        }
        if self.menu.page == Some(Page::Checkpoints) {
            self.checkpoints_key(event, window, cx);
            return;
        }
        if self.menu.page == Some(Page::FanOut) {
            self.fan_out_key(event, window, cx);
            return;
        }
        if matches!(
            self.menu.page,
            Some(Page::Host | Page::RenameDevice | Page::ForwardPort | Page::RemoveDevice)
        ) {
            self.host_menu_key(event, window, cx);
            return;
        }
        if matches!(self.menu.page, Some(Page::Tab | Page::RenameTab)) {
            self.tab_menu_key(event, window, cx);
            return;
        }
        if self.menu.page == Some(Page::Group) {
            self.group_menu_key(event, window, cx);
            return;
        }
        if matches!(
            self.menu.page,
            Some(Page::Pane | Page::RenamePane | Page::PaneProcesses | Page::KillProcesses)
        ) {
            self.pane_menu_key(event, window, cx);
            return;
        }
        if let Some(Page::Usage(provider)) = self.menu.page
            && self.usage_key(provider, event, cx)
        {
            cx.stop_propagation();
            window.prevent_default();
            return;
        }
        if self.menu.page == Some(Page::AddWsl) {
            self.add_wsl_key(event, window, cx);
            return;
        }
        if self.menu.page == Some(Page::RemoveWsl) {
            self.remove_wsl_key(event, window, cx);
            return;
        }
        if matches!(self.menu.page, Some(Page::Devices | Page::AddDevice)) {
            self.devices_key(event, window, cx);
            return;
        }
        #[cfg(feature = "coder")]
        if self.menu.page == Some(Page::AddCoder) {
            if self.coder_key(event, window, cx) {
                cx.stop_propagation();
                window.prevent_default();
            }
            return;
        }
        if self.menu.page == Some(Page::Sessions) {
            self.sessions_key(event, window, cx);
            return;
        }
        if self.menu.page == Some(Page::Palette) {
            self.palette_key(event, window, cx);
            return;
        }
        if self.menu.page == Some(Page::ConfirmClose) {
            self.close_confirmation_key(event, window, cx);
            return;
        }
        if self.menu.page == Some(Page::GitHub) {
            self.github_key(event, window, cx);
            return;
        }
        if self.menu.page == Some(Page::Themes) {
            self.theme_picker_key(event, window, cx);
            return;
        }
        if self.menu.page == Some(Page::Fonts) {
            self.font_picker_key(event, window, cx);
            return;
        }
        if self.menu.page == Some(Page::Preferences) && self.menu.font_size_editor.is_some() {
            let editor = self.menu.font_size_editor.as_ref();
            if editor.is_some_and(|editor| editor.input.read(cx).is_composing()) {
                return;
            }
            match event.keystroke.key.as_str() {
                "enter" | "escape" => {
                    cx.stop_propagation();
                    window.prevent_default();
                    self.finish_font_size_edit(event.keystroke.key == "enter", cx);
                    window.focus(&self.menu.focus, cx);
                    return;
                }
                _ => return, // Native text editing and IME handle printable input.
            }
        }
        if self.menu.page == Some(Page::Keybinds)
            && (self
                .menu
                .keybinds_search
                .as_ref()
                .is_some_and(|search| search.read(cx).is_composing())
                || !matches!(
                    event.keystroke.key.as_str(),
                    "escape" | "up" | "down" | "pageup" | "pagedown"
                ))
        {
            // Printable input and IME commands must reach the native text handler.
            return;
        }
        cx.stop_propagation();
        window.prevent_default();
        match event.keystroke.key.as_str() {
            "escape" => self.dismiss_menu(window, cx),
            "up" | "down"
                if self.menu.page == Some(Page::Dialog(WorkspaceAction::OpenWorktree)) =>
            {
                if let Some(picker) = &mut self.menu.worktree_open
                    && !picker.filtered.is_empty()
                    && self.menu.creation.is_none()
                {
                    let count = picker.filtered.len();
                    picker.selected = if event.keystroke.key == "up" {
                        (picker.selected + count - 1) % count
                    } else {
                        (picker.selected + 1) % count
                    };
                    picker
                        .scroll
                        .scroll_to_item(picker.selected, ScrollStrategy::Top);
                    cx.notify();
                }
            }
            "enter" if matches!(self.menu.page, Some(Page::Dialog(_))) => {
                self.submit_workspace_dialog(window, cx)
            }
            "enter" if self.menu.page == Some(Page::GitCommit) => self.submit_git_commit(cx),
            "enter" if self.menu.page == Some(Page::PrComment) => self.submit_pr_comment(cx),
            "enter" if self.menu.page == Some(Page::PrMerge) => self.submit_pr_merge(cx),
            "up" | "down" if self.menu.page == Some(Page::PrMerge) => {
                self.cycle_merge_method(event.keystroke.key == "down", cx)
            }
            // The tiles read row by row, so left and right walk the same
            // order as up and down.
            "up" | "down" | "left" | "right" if self.menu.page == Some(Page::Workspace) => {
                let actions = self.workspace_menu_actions();
                let selected = self
                    .menu
                    .workspace_selected
                    .and_then(|selected| actions.iter().position(|action| *action == selected));
                let back = matches!(event.keystroke.key.as_str(), "up" | "left");
                if !actions.is_empty() {
                    let index = match (selected, back) {
                        (None, true) => actions.len() - 1,
                        (None, false) => 0,
                        (Some(index), true) => (index + actions.len() - 1) % actions.len(),
                        (Some(index), false) => (index + 1) % actions.len(),
                    };
                    self.menu.workspace_selected = Some(actions[index]);
                }
                cx.notify();
            }
            "up" | "down" if self.menu.page == Some(Page::Menu) => {
                let count = self.menu_items().len();
                if count > 0 {
                    self.menu.selected =
                        Some(match (self.menu.selected, event.keystroke.key.as_str()) {
                            (None, "up") => count - 1,
                            (None, _) => 0,
                            (Some(index), "up") => (index + count - 1) % count,
                            (Some(index), _) => (index + 1) % count,
                        });
                }
                cx.notify();
            }
            "enter" if self.menu.page == Some(Page::Workspace) => {
                if let Some(action) = self
                    .menu
                    .workspace_selected
                    .filter(|action| self.workspace_menu_actions().contains(action))
                {
                    self.activate_workspace_menu(action, window, cx);
                }
            }
            "up" | "down" | "pageup" | "pagedown"
                if matches!(self.menu.page, Some(Page::Keybinds | Page::Preferences)) =>
            {
                let scroll = if self.menu.page == Some(Page::Preferences) {
                    &self.menu.preferences_scroll
                } else {
                    &self.menu.keybinds_scroll
                };
                let key = event.keystroke.key.as_str();
                let distance = if key.starts_with("page") {
                    scroll.bounds().size.height * 0.8
                } else {
                    px(self.config.ui.line_height() * 3.)
                };
                let direction = if key.ends_with("up") { 1. } else { -1. };
                scroll.set_offset(scroll.offset() + point(px(0.), distance * direction));
                cx.notify();
            }
            "enter" if self.menu.page == Some(Page::AgentSkill) => {
                self.install_browser_skill(window, cx);
            }
            "enter" if self.menu.page == Some(Page::VersionMismatch) => {
                self.act_on_version_mismatch(window, cx);
            }
            "enter" if self.menu.page == Some(Page::Install) => {
                cx.open_url(crate::about::WEBSITE);
            }
            "enter" if self.menu.page == Some(Page::About) => {
                self.dismiss_menu(window, cx);
            }
            "enter" if self.menu.page == Some(Page::Menu) => {
                if let Some(item) = self
                    .menu
                    .selected
                    .and_then(|index| self.menu_items().get(index).copied())
                {
                    self.activate_menu(item, window, cx);
                }
            }
            _ => {}
        }
    }
}
