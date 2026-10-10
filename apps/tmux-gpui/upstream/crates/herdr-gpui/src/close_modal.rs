use crate::{
    Error, HerdrWindow, Result,
    config::preferences::Preference,
    controls::{self, Command},
    menu::Page,
};
use gpui::{prelude::*, *};
use herdr_client::{
    Method,
    protocol::{AgentStatus, ClientShellSnapshot},
};
use serde_json::{Value, json};

#[derive(Debug, PartialEq, Eq)]
pub(super) struct CloseConfirmation {
    boot: String,
    workspace: String,
    tab: String,
    pane: Option<String>,
    label: String,
    confirm_selected: bool,
    /// Pane closes only: confirming also saves `confirm_close_pane = false`.
    do_not_ask_again: bool,
    error: Option<String>,
}

impl CloseConfirmation {
    pub(super) fn capture_pane(snapshot: &ClientShellSnapshot, id: &str) -> Option<Self> {
        let pane = snapshot.panes.iter().find(|pane| pane.pane_id == id)?;
        let mut close = Self::capture_tab(snapshot, &pane.tab_id)?;
        if close.workspace != pane.workspace_id {
            return None;
        }
        close.pane = Some(pane.pane_id.clone());
        close.label = pane.label.clone().unwrap_or_else(|| pane.pane_id.clone());
        close.request(snapshot).ok()?;
        Some(close)
    }

    pub(super) fn capture_tab(snapshot: &ClientShellSnapshot, id: &str) -> Option<Self> {
        let tab = snapshot.tabs.iter().find(|tab| tab.tab_id == id)?;
        Some(Self {
            boot: snapshot.boot_id.clone(),
            workspace: tab.workspace_id.clone(),
            tab: tab.tab_id.clone(),
            pane: None,
            label: tab.label.clone(),
            confirm_selected: false,
            do_not_ask_again: false,
            error: None,
        })
    }

    fn capture(command: Command, snapshot: &ClientShellSnapshot) -> Option<Self> {
        if !matches!(command, Command::ClosePane | Command::CloseTab) {
            return None;
        }
        controls::request(command, snapshot)?;
        let tab = snapshot
            .tabs
            .iter()
            .find(|tab| Some(&tab.tab_id) == snapshot.focused_tab_id.as_ref())?;
        let pane = if command == Command::ClosePane {
            Some(
                snapshot
                    .panes
                    .iter()
                    .find(|pane| Some(&pane.pane_id) == snapshot.focused_pane_id.as_ref())?,
            )
        } else {
            None
        };
        Some(Self {
            boot: snapshot.boot_id.clone(),
            workspace: tab.workspace_id.clone(),
            tab: tab.tab_id.clone(),
            pane: pane.map(|pane| pane.pane_id.clone()),
            label: pane
                .map(|pane| pane.label.clone().unwrap_or_else(|| pane.pane_id.clone()))
                .unwrap_or_else(|| tab.label.clone()),
            confirm_selected: false,
            do_not_ask_again: false,
            error: None,
        })
    }

    /// Whether closing this target could interrupt an agent mid-task: one
    /// working, or blocked on a prompt. Idle, done, and unknown agents, and
    /// tabs without any, have nothing in flight to lose. Pane closes ask
    /// unless `confirm_close_pane` is off, so this only matters for tabs.
    fn interrupts_agent(&self, snapshot: &ClientShellSnapshot) -> bool {
        let busy = |status| matches!(status, AgentStatus::Working | AgentStatus::Blocked);
        // The tab's aggregate status may rank a finished agent above a
        // working one, so each agent in the tab is checked as well.
        snapshot
            .tabs
            .iter()
            .any(|tab| tab.tab_id == self.tab && busy(tab.agent_status))
            || snapshot
                .agents
                .iter()
                .any(|agent| agent.tab_id == self.tab && busy(agent.agent_status))
    }

    fn request(&self, snapshot: &ClientShellSnapshot) -> Result<(Method, Value)> {
        if snapshot.boot_id != self.boot
            || !snapshot
                .workspaces
                .iter()
                .any(|workspace| workspace.workspace_id == self.workspace)
            || !snapshot
                .tabs
                .iter()
                .any(|tab| tab.tab_id == self.tab && tab.workspace_id == self.workspace)
            || self.pane.as_ref().is_some_and(|id| {
                !snapshot.panes.iter().any(|pane| {
                    &pane.pane_id == id
                        && pane.tab_id == self.tab
                        && pane.workspace_id == self.workspace
                })
            })
        {
            return Err(Error::StaleCloseTarget);
        }
        Ok(if let Some(id) = &self.pane {
            (Method::PaneClose, json!({"pane_id": id}))
        } else {
            (Method::TabClose, json!({"tab_id": self.tab}))
        })
    }
}

impl HerdrWindow {
    pub(super) fn open_tab_close(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) {
        let close = self
            .live
            .snapshot
            .as_ref()
            .and_then(|snapshot| CloseConfirmation::capture_tab(snapshot, id));
        self.show_close(close, window, cx);
    }

    pub(super) fn open_close_confirmation(
        &mut self,
        command: Command,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let close = self
            .live
            .snapshot
            .as_ref()
            .and_then(|snapshot| CloseConfirmation::capture(command, snapshot));
        self.show_close(close, window, cx);
    }

    fn show_close(
        &mut self,
        close: Option<CloseConfirmation>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(close) = close else {
            return;
        };
        if self.open_menu(window, cx) {
            self.present_close(close, window, cx);
        }
    }

    /// Shows the confirmation in a menu the caller has already opened and
    /// fenced, or closes straight away when confirmation is turned off for the
    /// target kind or a tab has no agent mid-task. The immediate close still
    /// goes through `confirm_close`, so its connection and target checks hold
    /// and a refusal stays visible in the dialog.
    pub(super) fn present_close(
        &mut self,
        close: CloseConfirmation,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let immediate = if close.pane.is_some() {
            !self.config.confirm_close_pane
        } else {
            !self.config.confirm_close_tab
                || !self
                    .live
                    .snapshot
                    .as_ref()
                    .is_some_and(|snapshot| close.interrupts_agent(snapshot))
        };
        self.menu.close = Some(close);
        self.menu.page = Some(Page::ConfirmClose);
        if immediate {
            self.confirm_close(window, cx);
        } else {
            cx.notify();
        }
    }

    fn confirm_close(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(edit) = self.send_close(window, cx) {
            self.save_preference(move || crate::config::Config::save_preference(edit), cx);
        }
    }

    /// Whether the open dialog offers "Do not ask again": only for a pane, and
    /// only while pane closes still ask. A refused immediate close falls back
    /// to the dialog with the option already off, so there is nothing to save.
    fn offers_do_not_ask_again(&self) -> bool {
        self.config.confirm_close_pane
            && self
                .menu
                .close
                .as_ref()
                .is_some_and(|close| close.pane.is_some())
    }

    /// Sends the close, returning the preference "Do not ask again" asks to
    /// persist once the close actually went out; a refusal persists nothing.
    pub(super) fn send_close(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<Preference> {
        let close = self.menu.close.as_ref()?;
        let result = (|| {
            if !self.menu_target_current() || !self.input_ready() {
                return Err(Error::StaleConnection);
            }
            if close.pane.is_some()
                && self
                    .live
                    .surface
                    .as_ref()
                    .is_some_and(|s| s.popup.is_some())
            {
                return Err(Error::ConnectionNotReady);
            }
            let snapshot = self.live.snapshot.as_ref().ok_or(Error::NotConnected)?;
            close.request(snapshot)
        })();
        match result {
            Ok((method, params)) => {
                let stop_asking = close.do_not_ask_again;
                self.request_focus_change(method.as_str(), None, |handle, boot| {
                    handle.request(boot, method, params)
                });
                self.dismiss_menu(window, cx);
                stop_asking.then_some(Preference::ConfirmClosePane(false))
            }
            Err(error) => {
                if let Some(close) = &mut self.menu.close {
                    close.error = Some(error.to_string());
                }
                cx.notify();
                None
            }
        }
    }

    pub(super) fn close_confirmation_key(
        &mut self,
        event: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        cx.stop_propagation();
        window.prevent_default();
        match event.keystroke.key.as_str() {
            "escape" => self.dismiss_menu(window, cx),
            "tab" | "left" | "right" => {
                if let Some(close) = &mut self.menu.close {
                    close.confirm_selected = !close.confirm_selected;
                }
                cx.notify();
            }
            "space" => self.toggle_do_not_ask_again(cx),
            "enter" => {
                if self
                    .menu
                    .close
                    .as_ref()
                    .is_some_and(|close| close.confirm_selected)
                {
                    self.confirm_close(window, cx);
                } else {
                    self.dismiss_menu(window, cx);
                }
            }
            _ => {}
        }
    }

    fn toggle_do_not_ask_again(&mut self, cx: &mut Context<Self>) {
        if !self.offers_do_not_ask_again() {
            return;
        }
        if let Some(close) = &mut self.menu.close {
            close.do_not_ask_again = !close.do_not_ask_again;
            cx.notify();
        }
    }

    pub(super) fn render_close_confirmation(&self, cx: &mut Context<Self>) -> Div {
        let Some(close) = &self.menu.close else {
            return div();
        };
        let theme = &self.theme;
        let kind = if close.pane.is_some() { "pane" } else { "tab" };
        div().p(px(12.)).flex().flex_col().gap(px(12.))
            .child(div().text_size(px(self.config.ui.size * 1.35)).font_weight(FontWeight::SEMIBOLD).child(format!("Close {kind}?")))
            .child(div().child(close.label.clone()))
            .child(div().text_color(rgb(theme.subtext())).child(if close.pane.is_some() {
                "This terminates the pane and its running processes. This cannot be undone."
            } else { "This terminates every pane and running process in this tab. This cannot be undone." }))
            .when_some(close.error.clone(), |panel, error| panel.child(div().bg(rgb(theme.active)).p(px(8.)).child(error)))
            .when(self.offers_do_not_ask_again(), |panel| panel.child(div().id("close-do-not-ask").debug_selector(|| "close-do-not-ask".into())
                .flex().items_center().gap(px(8.)).cursor_pointer().text_color(rgb(theme.muted))
                .child(crate::toggles::checkbox(theme, self.config.ui.size + 2., close.do_not_ask_again))
                .child("Do not ask again")
                .on_click(cx.listener(|this, _, _, cx| this.toggle_do_not_ask_again(cx)))))
            .child(div().flex().justify_end().gap(px(8.))
                .child(div().id("close-cancel").debug_selector(|| "close-cancel".into()).px(px(12.)).py(px(6.)).rounded(px(crate::config::corners::CONTROL)).border_1()
                    .border_color(rgb(if close.confirm_selected { theme.active } else { theme.foreground }))
                    .cursor_pointer().hover(|s| s.bg(rgb(theme.active))).child("Cancel")
                    .on_click(cx.listener(|this, _, window, cx| this.dismiss_menu(window, cx))))
                .child(div().id("close-confirm").debug_selector(|| "close-confirm".into()).px(px(12.)).py(px(6.)).rounded(px(crate::config::corners::CONTROL)).border_1()
                    .border_color(rgb(if close.confirm_selected { theme.foreground } else { theme.active }))
                    .bg(rgb(theme.active)).cursor_pointer().child(format!("Close {kind}"))
                    .on_click(cx.listener(|this, _, window, cx| this.confirm_close(window, cx)))))
    }
}

#[cfg(test)]
mod tests;
