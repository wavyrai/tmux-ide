//! The picker's keyboard: arrows, Return and Escape, after the dialogs and
//! modes that take keys of their own.
use super::{Mode, SnapshotView};
use gpui::*;

impl SnapshotView {
    pub(in crate::tmux_snapshot) fn picker_key(
        &mut self,
        event: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.pane_shortcut_key(event, window, cx) || self.session_tabs_key(event, window, cx) {
            return;
        }
        if self.session_history_key(event, window, cx) {
            return;
        }
        if self.new_session.is_some() {
            self.new_session_key(event, window, cx);
            return;
        }
        if self.pane_actions.is_some() {
            self.pane_actions_key(event, window, cx);
            return;
        }
        if self
            .picker
            .as_ref()
            .is_some_and(|p| p.search.read(cx).is_composing())
        {
            return;
        }
        if self.picker.as_ref().is_some_and(|p| p.closing.is_some()) {
            self.pane_close_key(event, window, cx);
            return;
        }
        if self.picker.as_ref().is_some_and(|p| p.agent.is_some()) {
            self.new_agent_key(event, window, cx);
            return;
        }
        if self.machine_edit_composing(cx) {
            return;
        }
        if self.sidebar_keyboard_key(event, window, cx) {
            return;
        }
        if self.home_filter_key(event, window, cx) {
            return;
        }
        let key = &event.keystroke;
        if key.key == "f10" && super::commands::shortcut(key) {
            if !event.is_held && self.picker.is_none() && self.marked.is_empty() {
                self.toggle_sidebar(cx);
            }
            cx.stop_propagation();
            window.prevent_default();
            return;
        }
        if super::commands::shortcut(key) {
            match key.key.as_str() {
                "f1" => self.dispatch_application_tab(
                    self.browser_request,
                    super::super::workspace_chrome::ApplicationTab::Home,
                    window,
                    cx,
                ),
                "f2" => {
                    if self.picker.is_some() {
                        self.close_picker(window, cx);
                    }
                    self.dispatch_application_tab(
                        self.browser_request,
                        super::super::workspace_chrome::ApplicationTab::Terminals,
                        window,
                        cx,
                    );
                }
                "f6" => self.open_picker(window, cx),
                "f7" => self.open_attention(window, cx),
                _ => self.open_commands(window, cx),
            }
            cx.stop_propagation();
            window.prevent_default();
            return;
        }
        if key.modifiers.platform
            && !key.modifiers.control
            && !key.modifiers.alt
            && matches!(key.key.as_str(), "k" | "p")
        {
            self.open_picker(window, cx);
            cx.stop_propagation();
            window.prevent_default();
            return;
        }
        if self
            .picker
            .as_ref()
            .is_some_and(|picker| picker.edit.is_some())
        {
            self.machine_edit_key(event, window, cx);
            return;
        }
        if self.picker.as_ref().is_some_and(|p| p.removal.is_some()) {
            self.machine_removal_key(event, window, cx);
            return;
        }
        if self
            .picker
            .as_ref()
            .is_some_and(|p| p.mode == Mode::Machine)
        {
            self.machine_key(event, window, cx);
            return;
        }
        let Some(picker) = &mut self.picker else {
            return;
        };
        if picker.search.read(cx).is_composing() {
            return;
        }
        match key.key.as_str() {
            "escape" if picker.mode.is_reference() => self.open_commands(window, cx),
            "escape" => self.close_picker(window, cx),
            "up" => picker.selected = picker.selected.saturating_sub(1),
            "down" => {
                picker.selected = (picker.selected + 1).min(picker.rows.len().saturating_sub(1))
            }
            // A held Return repeats: it must never choose a second row, such
            // as "Run …" after the first Return opened a confirm step.
            "enter" if event.is_held => {}
            "enter" => {
                let target = picker
                    .rows
                    .get(picker.selected)
                    .map(|row| row.target.clone());
                if let Some(target) = target {
                    self.choose_picker(target, window, cx);
                }
            }
            _ => return,
        }
        if let Some(picker) = &self.picker {
            picker.scroll.scroll_to_item(picker.selected);
        }
        cx.stop_propagation();
        window.prevent_default();
        cx.notify();
    }
}
