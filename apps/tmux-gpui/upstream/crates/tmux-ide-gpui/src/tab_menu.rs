use crate::{
    HerdrWindow,
    browser::{GroupId, Pick},
    controls::Command,
    menu::Page,
    search_input::SearchInput,
};
use gpui::{prelude::*, *};
use herdr_client::{Method, protocol::ClientShellSnapshot};
use serde_json::{Value, json};

#[derive(Clone)]
struct Target {
    boot: String,
    workspace: String,
    tab: String,
    label: String,
}

#[cfg(test)]
mod tests;

impl Target {
    fn capture(snapshot: &ClientShellSnapshot, id: &str) -> Option<Self> {
        let tab = snapshot.tabs.iter().find(|tab| tab.tab_id == id)?;
        Some(Self {
            boot: snapshot.boot_id.clone(),
            workspace: tab.workspace_id.clone(),
            tab: tab.tab_id.clone(),
            label: tab.label.clone(),
        })
    }

    fn validate(&self, snapshot: &ClientShellSnapshot) -> crate::Result<()> {
        if snapshot.boot_id != self.boot
            || !snapshot
                .workspaces
                .iter()
                .any(|w| w.workspace_id == self.workspace)
            || !snapshot
                .tabs
                .iter()
                .any(|t| t.tab_id == self.tab && t.workspace_id == self.workspace)
        {
            return Err(crate::Error::StaleTab);
        }
        Ok(())
    }

    fn rename_params(&self, label: &str) -> crate::Result<Value> {
        let label = label.trim();
        if label.is_empty() {
            return Err(crate::Error::EmptyTabName);
        }
        Ok(json!({"tab_id": self.tab, "label": label}))
    }
}

#[derive(Clone, Copy)]
enum Action {
    NewTab,
    Rename,
    Close,
}

/// Herdr's own tab menu, in its order.
const ACTIONS: [(Action, &str); 3] = [
    (Action::NewTab, "New Tab"),
    (Action::Rename, "Rename"),
    (Action::Close, "Close Tab"),
];

pub(super) struct TabMenu {
    target: Target,
    /// The editor group whose strip opened the menu, if any. A new tab
    /// opens in it, and while split, closing removes the tab from it alone.
    group: Option<GroupId>,
    selected: Option<usize>,
    input: Option<Entity<SearchInput>>,
    pending: Option<String>,
    error: Option<String>,
}

impl HerdrWindow {
    pub(super) fn open_tab_menu(
        &mut self,
        id: &str,
        group: Option<GroupId>,
        anchor: Point<Pixels>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(target) = self
            .live
            .snapshot
            .as_ref()
            .and_then(|s| Target::capture(s, id))
        else {
            return;
        };
        if !self.open_menu(window, cx) {
            return;
        }
        self.menu.anchor = anchor;
        self.menu.page = Some(Page::Tab);
        self.menu.tab = Some(TabMenu {
            target,
            group,
            selected: None,
            input: None,
            pending: None,
            error: None,
        });
    }

    /// Opens the focused tab's rename dialog, as its menu's "Rename" row
    /// would, just below the tab strip.
    pub(super) fn rename_focused_tab(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(id) = self
            .live
            .snapshot
            .as_ref()
            .and_then(|s| s.focused_tab_id.clone())
        else {
            return;
        };
        self.open_tab_menu(&id, None, self.bounds.origin, window, cx);
        if self.menu.page == Some(Page::Tab) {
            self.activate_tab_menu(Action::Rename, window, cx);
        }
    }

    fn validate_tab_target(&self) -> crate::Result<&Target> {
        if !self.menu_target_current() {
            return Err(crate::Error::StaleConnection);
        }
        let target = &self.menu.tab.as_ref().ok_or(crate::Error::NoTab)?.target;
        target.validate(
            self.live
                .snapshot
                .as_ref()
                .ok_or(crate::Error::NotConnected)?,
        )?;
        Ok(target)
    }

    fn tab_error(&mut self, error: impl std::fmt::Display, cx: &mut Context<Self>) {
        if let Some(tab) = &mut self.menu.tab {
            tab.error = Some(error.to_string());
        }
        cx.notify();
    }

    fn activate_tab_menu(&mut self, action: Action, window: &mut Window, cx: &mut Context<Self>) {
        let target = match self.validate_tab_target() {
            Ok(target) => target.clone(),
            Err(error) => {
                self.tab_error(error, cx);
                return;
            }
        };
        let group = self.menu.tab.as_ref().and_then(|tab| tab.group);
        match action {
            Action::NewTab => {
                self.dismiss_menu(window, cx);
                if let Some(group) = group {
                    self.expect_new_tab_in(group);
                }
                self.command(Command::Tab, window, cx);
            }
            // As the tab's own close button: split, a group lets go of the
            // tab and Herdr keeps it; otherwise the close confirmation decides.
            Action::Close => match group {
                Some(group) if self.is_split() => {
                    self.dismiss_menu(window, cx);
                    self.close_in_group(group, vec![Pick::Herdr(target.tab)], window, cx);
                }
                _ => self.open_tab_close(&target.tab, window, cx),
            },
            Action::Rename => {
                let input = cx.new(SearchInput::new);
                input.update(cx, |input, cx| {
                    input.set_appearance(self.config.ui.clone(), self.theme.clone(), cx);
                    input.set_placeholder("Tab name", cx);
                    input.set_text_selected(&target.label, cx);
                    window.focus(&input.focus, cx);
                });
                if let Some(tab) = &mut self.menu.tab {
                    tab.input = Some(input);
                    tab.error = None;
                }
                self.menu.page = Some(Page::RenameTab);
                cx.notify();
            }
        }
    }

    fn submit_tab_rename(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(tab) = &self.menu.tab else { return };
        let Some(input) = &tab.input else { return };
        if tab.pending.is_some() || input.read(cx).is_composing() {
            return;
        }
        let result = (|| {
            let target = self.validate_tab_target()?;
            let params = target.rename_params(input.read(cx).text())?;
            if !self.input_ready() {
                return Err(crate::Error::ConnectionNotReady);
            }
            let endpoint = &self.endpoints[self.selected_endpoint];
            let handle = endpoint
                .connection
                .handle
                .as_ref()
                .ok_or(crate::Error::NotConnected)?;
            let mut inbox = endpoint
                .connection
                .inbox
                .try_lock()
                .map_err(|_| crate::Error::ConnectionBusy)?;
            // Install correlation under the same lock used by the event reducer.
            let request = handle.request(&target.boot, Method::TabRename, params)?;
            inbox.tab_rename = Some(crate::state::RenameResult {
                request: request.clone(),
                result: None,
            });
            Ok::<_, crate::Error>(request)
        })();
        match result {
            Ok(request) => {
                if let Some(tab) = &mut self.menu.tab {
                    tab.pending = Some(request);
                    tab.error = None;
                }
                window.focus(&self.menu.focus, cx);
                cx.notify();
            }
            Err(error) => self.tab_error(error, cx),
        }
    }

    pub(super) fn poll_tab_rename(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(request) = self.menu.tab.as_ref().and_then(|tab| tab.pending.as_ref()) else {
            return;
        };
        let result = if let Err(error) = self.validate_tab_target() {
            Some(Err(std::sync::Arc::new(error)))
        } else {
            self.live
                .tab_rename
                .as_ref()
                .filter(|r| &r.request == request)
                .and_then(|r| r.result.clone())
        };
        match result {
            Some(Ok(())) => self.dismiss_menu(window, cx),
            Some(Err(error)) => {
                if let Some(tab) = &mut self.menu.tab {
                    tab.pending = None;
                    if let Some(input) = &tab.input {
                        window.focus(&input.read(cx).focus.clone(), cx);
                    }
                }
                self.tab_error(error, cx);
            }
            None => {}
        }
    }

    pub(super) fn tab_menu_key(
        &mut self,
        event: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(tab) = &mut self.menu.tab else {
            return;
        };
        let key = event.keystroke.key.as_str();
        if self.menu.page == Some(Page::RenameTab)
            && tab.pending.is_none()
            && (tab
                .input
                .as_ref()
                .is_some_and(|input| input.read(cx).is_composing())
                || !matches!(key, "escape" | "enter"))
        {
            return;
        }
        cx.stop_propagation();
        window.prevent_default();
        match key {
            "escape" => self.dismiss_menu(window, cx),
            "enter" if self.menu.page == Some(Page::RenameTab) => {
                self.submit_tab_rename(window, cx)
            }
            "up" | "down" if self.menu.page == Some(Page::Tab) => {
                tab.selected = Some(match (tab.selected, key) {
                    (None, "up") => ACTIONS.len() - 1,
                    (None, _) => 0,
                    (Some(i), "up") => (i + ACTIONS.len() - 1) % ACTIONS.len(),
                    (Some(i), _) => (i + 1) % ACTIONS.len(),
                });
                cx.notify();
            }
            "enter" => {
                if let Some(index) = tab.selected {
                    self.activate_tab_menu(ACTIONS[index].0, window, cx);
                }
            }
            _ => {}
        }
    }

    pub(super) fn render_tab_menu(&self, cx: &mut Context<Self>) -> Div {
        let Some(tab) = &self.menu.tab else {
            return div();
        };
        let theme = &self.theme;
        let mut body = div().flex().flex_col();
        if self.menu.page == Some(Page::Tab) {
            for (index, (action, label)) in ACTIONS.into_iter().enumerate() {
                body = body.child(
                    div()
                        .id(("tab-menu-action", index))
                        .debug_selector(move || format!("tab-menu-{index}"))
                        .min_h(px(self.config.ui.line_height() + 12.))
                        .px(px(8.))
                        .flex()
                        .items_center()
                        .cursor_pointer()
                        .when(tab.selected == Some(index), |row| row.bg(rgb(theme.active)))
                        .hover(|row| row.bg(rgb(theme.active)))
                        .child(div().min_w_0().truncate().child(label))
                        .on_hover(cx.listener(move |this, hovered, _, cx| {
                            if *hovered && let Some(tab) = &mut this.menu.tab {
                                tab.selected = Some(index);
                                cx.notify();
                            }
                        }))
                        .on_click(cx.listener(move |this, _, window, cx| {
                            this.activate_tab_menu(action, window, cx)
                        })),
                );
            }
        } else {
            body =
                body.p(px(8.))
                    .gap(px(12.))
                    .child(div().font_weight(FontWeight::SEMIBOLD).child("Rename tab"))
                    .when_some(tab.input.clone(), |body, input| {
                        if tab.pending.is_some() {
                            body.child(div().child(input.read(cx).text().to_owned()))
                        } else {
                            body.child(input)
                        }
                    })
                    .child(
                        div()
                            .flex()
                            .justify_end()
                            .gap(px(8.))
                            .child(
                                div()
                                    .id("tab-rename-cancel")
                                    .p(px(6.))
                                    .cursor_pointer()
                                    .child("Cancel")
                                    .on_click(cx.listener(|this, _, window, cx| {
                                        this.dismiss_menu(window, cx)
                                    })),
                            )
                            .child(
                                div()
                                    .id("tab-rename-submit")
                                    .p(px(6.))
                                    .rounded(px(crate::config::corners::CONTROL))
                                    .bg(rgb(theme.active))
                                    .cursor_pointer()
                                    .child(if tab.pending.is_some() {
                                        "Renaming..."
                                    } else {
                                        "Rename"
                                    })
                                    .on_click(cx.listener(|this, _, window, cx| {
                                        this.submit_tab_rename(window, cx)
                                    })),
                            ),
                    );
        }
        body.when_some(tab.error.clone(), |body, error| {
            // No width of its own, so the labels set the panel's width and
            // the message wraps inside it.
            body.child(div().w_0().min_w_full().p(px(8.)).child(error))
        })
    }
}
