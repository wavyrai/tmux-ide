use crate::{HerdrWindow, close_modal::CloseConfirmation, menu::Page, search_input::SearchInput};
use gpui::{prelude::*, *};
use herdr_client::{Method, protocol::ClientShellSnapshot};
use serde_json::{Value, json};

mod processes;

#[cfg(test)]
pub(crate) mod tests;

#[derive(Clone)]
struct Target {
    boot: String,
    workspace: String,
    tab: String,
    pane: String,
    label: String,
    /// Whether the pane's tab was zoomed when the menu opened, so the zoom
    /// row says what it will do and asks Herdr for exactly that.
    zoomed: bool,
    /// The focused pane when it is another one in the same tab, which "Swap
    /// with focused pane" trades places with.
    focused: Option<String>,
    /// Herdr routes this pane's right-clicks to its application, as seen when
    /// the menu opened; the toggle asks for the other routing.
    right_click_passthrough: bool,
}

impl Target {
    fn capture(snapshot: &ClientShellSnapshot, id: &str) -> Option<Self> {
        let pane = snapshot.panes.iter().find(|pane| pane.pane_id == id)?;
        let zoomed = snapshot
            .tabs
            .iter()
            .any(|tab| tab.tab_id == pane.tab_id && tab.zoomed);
        let focused = snapshot.focused_pane_id.as_ref().filter(|focused| {
            **focused != pane.pane_id
                && snapshot.panes.iter().any(|p| {
                    p.pane_id == **focused
                        && p.tab_id == pane.tab_id
                        && p.workspace_id == pane.workspace_id
                })
        });
        let target = Self {
            boot: snapshot.boot_id.clone(),
            workspace: pane.workspace_id.clone(),
            tab: pane.tab_id.clone(),
            pane: pane.pane_id.clone(),
            label: pane.label.clone().unwrap_or_default(),
            zoomed,
            focused: focused.cloned(),
            right_click_passthrough: pane.right_click_passthrough,
        };
        target.validate(snapshot).ok()?;
        Some(target)
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
            || !snapshot.panes.iter().any(|p| {
                p.pane_id == self.pane && p.tab_id == self.tab && p.workspace_id == self.workspace
            })
        {
            return Err(crate::Error::StalePane);
        }
        Ok(())
    }

    fn rename_params(&self, label: &str) -> Value {
        json!({"pane_id": self.pane, "label": label.trim()})
    }
}

#[derive(Clone, Copy)]
enum Action {
    Rename,
    SplitRight,
    SplitDown,
    Swap,
    Zoom,
    EditScrollback,
    RightClick,
    Processes,
    Close,
}

impl Action {
    fn request(self, target: &Target) -> Option<(Method, Value)> {
        Some(match self {
            Self::SplitRight | Self::SplitDown => (
                Method::PaneSplit,
                json!({
                    "target_pane_id": target.pane,
                    "direction": if matches!(self, Self::SplitRight) { "right" } else { "down" },
                    "focus": true,
                }),
            ),
            // The focused pane moves to this one's place and keeps focus,
            // as Herdr's directional swaps move it.
            Self::Swap => (
                Method::PaneSwap,
                json!({"source_pane_id": target.focused.as_ref()?, "target_pane_id": target.pane}),
            ),
            // An explicit mode, so a zoom another client changed meanwhile
            // leaves the pane as the row promised rather than flipping it.
            Self::Zoom => (
                Method::PaneZoom,
                json!({"pane_id": target.pane, "mode": if target.zoomed { "off" } else { "on" }}),
            ),
            Self::RightClick => (
                Method::PaneInputSet,
                json!({
                    "pane_id": target.pane,
                    "right_click": if target.right_click_passthrough { "herdr" } else { "pane" },
                }),
            ),
            Self::Rename | Self::EditScrollback | Self::Processes | Self::Close => return None,
        })
    }

    fn label(self, target: &Target) -> &'static str {
        match self {
            Self::Rename => "Rename",
            Self::SplitRight => "Split Right",
            Self::SplitDown => "Split Down",
            Self::Swap => "Swap with Focused Pane",
            Self::Zoom if target.zoomed => "Unzoom",
            Self::Zoom => "Zoom",
            Self::EditScrollback => "Open Scrollback in Editor",
            Self::RightClick if target.right_click_passthrough => "Open This Menu on Right-Click",
            Self::RightClick => "Send Right-Clicks to Pane",
            Self::Processes => "Processes",
            Self::Close => "Close",
        }
    }
}

const ACTIONS: [Action; 9] = [
    Action::Rename,
    Action::SplitRight,
    Action::SplitDown,
    Action::Swap,
    Action::Zoom,
    Action::EditScrollback,
    Action::RightClick,
    Action::Processes,
    Action::Close,
];

impl PaneMenu {
    /// The rows this menu offers: a swap needs another pane to trade with,
    /// and a process list needs the pane's processes on this machine.
    fn actions(&self) -> Vec<Action> {
        ACTIONS
            .into_iter()
            .filter(|action| match action {
                Action::Swap => self.target.focused.is_some(),
                Action::Processes => self.daemon.is_some(),
                _ => true,
            })
            .collect()
    }
}

pub(super) struct PaneMenu {
    target: Target,
    selected: Option<usize>,
    input: Option<Entity<SearchInput>>,
    pending: Option<String>,
    error: Option<String>,
    /// The daemon to ask for the pane's processes, when they run here.
    daemon: Option<crate::processes::Daemon>,
    processes: Option<processes::PaneProcesses>,
}

impl HerdrWindow {
    pub(super) fn open_pane_menu_at(
        &mut self,
        position: Point<Pixels>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.pressed_terminal_link = None;
        if self.menu.page.is_some() || !self.input_ready() {
            return;
        }
        let Some(surface) = &self.live.surface else {
            return;
        };
        let Some(id) = crate::terminal::pane_at(
            surface,
            self.bounds,
            position,
            self.cell_width,
            self.config.terminal.line_height(),
        ) else {
            return;
        };
        let id = id.to_owned();
        self.open_pane_menu(&id, position, window, cx);
    }

    fn open_pane_menu(
        &mut self,
        id: &str,
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
        let daemon = crate::processes::Daemon::for_target(
            &self.endpoints[self.selected_endpoint].connection.target,
        );
        self.menu.anchor = anchor;
        self.menu.page = Some(Page::Pane);
        self.menu.pane = Some(PaneMenu {
            target,
            selected: None,
            input: None,
            pending: None,
            error: None,
            daemon,
            processes: None,
        });
    }

    /// Opens the focused pane's rename dialog, as its menu's "Rename" row
    /// would, at the pane's top-left corner.
    pub(super) fn rename_focused_pane(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(id) = self
            .live
            .snapshot
            .as_ref()
            .and_then(|s| s.focused_pane_id.clone())
        else {
            return;
        };
        let origin = self.bounds.origin;
        let anchor = self
            .live
            .surface
            .as_ref()
            .and_then(|surface| surface.panes.iter().find(|pane| pane.pane_id == id))
            .map_or(origin, |pane| {
                point(
                    origin.x + px(f32::from(pane.rect.x) * self.cell_width),
                    origin.y + px(f32::from(pane.rect.y) * self.config.terminal.line_height()),
                )
            });
        self.open_pane_menu(&id, anchor, window, cx);
        if self.menu.page == Some(Page::Pane) {
            self.activate_pane_menu(Action::Rename, window, cx);
        }
    }

    fn validate_pane_target(&self) -> crate::Result<&Target> {
        if !self.menu_target_current() {
            return Err(crate::Error::StaleConnection);
        }
        let target = &self
            .menu
            .pane
            .as_ref()
            .ok_or(crate::Error::StalePane)?
            .target;
        target.validate(
            self.live
                .snapshot
                .as_ref()
                .ok_or(crate::Error::NotConnected)?,
        )?;
        Ok(target)
    }

    fn pane_error(&mut self, error: impl std::fmt::Display, cx: &mut Context<Self>) {
        if let Some(pane) = &mut self.menu.pane {
            pane.error = Some(error.to_string());
        }
        cx.notify();
    }

    fn activate_pane_menu(&mut self, action: Action, window: &mut Window, cx: &mut Context<Self>) {
        let target = match self.validate_pane_target() {
            Ok(target) => target.clone(),
            Err(error) => {
                self.pane_error(error, cx);
                return;
            }
        };
        match action {
            Action::Rename => {
                let input = cx.new(SearchInput::new);
                input.update(cx, |input, cx| {
                    input.set_appearance(self.config.ui.clone(), self.theme.clone(), cx);
                    input.set_placeholder("Pane name (blank clears)", cx);
                    input.set_text_selected(&target.label, cx);
                    window.focus(&input.focus, cx);
                });
                if let Some(pane) = &mut self.menu.pane {
                    pane.input = Some(input);
                    pane.error = None;
                }
                self.menu.page = Some(Page::RenamePane);
                cx.notify();
            }
            Action::Close => {
                // Keep the original endpoint fence, rather than reopening the menu.
                if let Some(close) = self
                    .live
                    .snapshot
                    .as_ref()
                    .and_then(|s| CloseConfirmation::capture_pane(s, &target.pane))
                {
                    self.present_close(close, window, cx);
                }
            }
            Action::Processes => self.open_pane_processes(cx),
            Action::EditScrollback => {
                let result = (|| {
                    if !self.live.supports_edit_scrollback {
                        return Err(herdr_client::Error::UnsupportedMethod.into());
                    }
                    if !self.input_ready() {
                        return Err(crate::Error::ConnectionNotReady);
                    }
                    let handle = self.endpoints[self.selected_endpoint]
                        .connection
                        .handle
                        .as_ref()
                        .ok_or(crate::Error::NotConnected)?;
                    // The daemon opens only its focused pane's history, and
                    // runs requests in order, so focusing first is enough.
                    let focused = self
                        .live
                        .snapshot
                        .as_ref()
                        .and_then(|s| s.focused_pane_id.as_deref());
                    if focused != Some(target.pane.as_str()) {
                        handle.focus_pane(&target.boot, &target.pane)?;
                    }
                    handle.edit_scrollback(&target.boot, &target.pane)?;
                    Ok::<_, crate::Error>(())
                })();
                match result {
                    Ok(()) => {
                        self.fence_focus_change(None);
                        self.dismiss_menu(window, cx);
                    }
                    Err(error) => self.pane_error(error, cx),
                }
            }
            action => {
                let result = (|| {
                    let (method, params) = action
                        .request(&target)
                        .ok_or(crate::Error::UnsupportedCommand)?;
                    if !self.input_ready()
                        || self
                            .live
                            .surface
                            .as_ref()
                            .is_some_and(|s| s.popup.is_some())
                    {
                        return Err(crate::Error::ConnectionNotReady);
                    }
                    let handle = self.endpoints[self.selected_endpoint]
                        .connection
                        .handle
                        .as_ref()
                        .ok_or(crate::Error::NotConnected)?;
                    handle.request(&target.boot, method, params)?;
                    Ok::<_, crate::Error>(())
                })();
                match result {
                    Ok(()) => {
                        self.fence_focus_change(None);
                        self.dismiss_menu(window, cx);
                    }
                    Err(error) => self.pane_error(error, cx),
                }
            }
        }
    }

    fn submit_pane_rename(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(pane) = &self.menu.pane else { return };
        let Some(input) = &pane.input else { return };
        if pane.pending.is_some() || input.read(cx).is_composing() {
            return;
        }
        let result = (|| {
            let target = self.validate_pane_target()?;
            if !self.input_ready()
                || self
                    .live
                    .surface
                    .as_ref()
                    .is_some_and(|s| s.popup.is_some())
            {
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
            // Register under the reducer's lock so even an immediate reply is retained.
            let request = handle.request(
                &target.boot,
                Method::PaneRename,
                target.rename_params(input.read(cx).text()),
            )?;
            inbox.pane_rename = Some(crate::state::RenameResult {
                request: request.clone(),
                result: None,
            });
            Ok::<_, crate::Error>(request)
        })();
        match result {
            Ok(request) => {
                if let Some(pane) = &mut self.menu.pane {
                    pane.pending = Some(request);
                    pane.error = None;
                }
                window.focus(&self.menu.focus, cx);
                cx.notify();
            }
            Err(error) => self.pane_error(error, cx),
        }
    }

    pub(super) fn poll_pane_rename(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(request) = self
            .menu
            .pane
            .as_ref()
            .and_then(|pane| pane.pending.as_ref())
        else {
            return;
        };
        let result = if let Err(error) = self.validate_pane_target() {
            Some(Err(std::sync::Arc::new(error)))
        } else {
            self.live
                .pane_rename
                .as_ref()
                .filter(|rename| &rename.request == request)
                .and_then(|rename| rename.result.clone())
        };
        match result {
            Some(Ok(())) => self.dismiss_menu(window, cx),
            Some(Err(error)) => {
                if let Some(pane) = &mut self.menu.pane {
                    pane.pending = None;
                    if let Some(input) = &pane.input {
                        window.focus(&input.read(cx).focus.clone(), cx);
                    }
                }
                self.pane_error(error, cx);
            }
            None => {}
        }
    }

    pub(super) fn pane_menu_key(
        &mut self,
        event: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(pane) = &mut self.menu.pane else {
            return;
        };
        let key = event.keystroke.key.as_str();
        if matches!(
            self.menu.page,
            Some(Page::PaneProcesses | Page::KillProcesses)
        ) {
            if key == "escape" && self.menu.page == Some(Page::PaneProcesses) {
                self.dismiss_menu(window, cx);
            } else if !self.pane_processes_key(key, cx) {
                return;
            }
            cx.stop_propagation();
            window.prevent_default();
            return;
        }
        if self.menu.page == Some(Page::RenamePane)
            && pane.pending.is_none()
            && (pane
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
            "enter" if self.menu.page == Some(Page::RenamePane) => {
                self.submit_pane_rename(window, cx)
            }
            "up" | "down" if self.menu.page == Some(Page::Pane) => {
                let count = pane.actions().len();
                pane.selected = Some(match (pane.selected, key) {
                    (None, "up") => count - 1,
                    (None, _) => 0,
                    (Some(i), "up") => (i + count - 1) % count,
                    (Some(i), _) => (i + 1) % count,
                });
                cx.notify();
            }
            "enter" => {
                if let Some(action) = pane
                    .selected
                    .and_then(|index| pane.actions().get(index).copied())
                {
                    self.activate_pane_menu(action, window, cx);
                }
            }
            _ => {}
        }
    }

    pub(super) fn render_pane_menu(&self, cx: &mut Context<Self>) -> Div {
        let Some(pane) = &self.menu.pane else {
            return div();
        };
        match self.menu.page {
            Some(Page::PaneProcesses) => return self.render_pane_processes(pane, cx),
            Some(Page::KillProcesses) => return self.render_kill_processes(pane, cx),
            _ => {}
        }
        let mut body = div().flex().flex_col();
        if self.menu.page == Some(Page::Pane) {
            for (index, action) in pane.actions().into_iter().enumerate() {
                body = body.child(
                    div()
                        .id(("pane-menu-action", index))
                        .debug_selector(move || format!("pane-menu-{index}"))
                        .min_h(px(self.config.ui.line_height() + 12.))
                        .px(px(8.))
                        .flex()
                        .items_center()
                        .cursor_pointer()
                        .when(pane.selected == Some(index), |row| {
                            row.bg(rgb(self.theme.active))
                        })
                        .hover(|row| row.bg(rgb(self.theme.active)))
                        .child(
                            // One line: the panel widens to fit it, and a
                            // window too narrow for that ends it with "…".
                            div()
                                .debug_selector(move || format!("pane-menu-label-{index}"))
                                .min_w_0()
                                .truncate()
                                .child(action.label(&pane.target)),
                        )
                        .on_hover(cx.listener(move |this, hovered, _, cx| {
                            if *hovered && let Some(pane) = &mut this.menu.pane {
                                pane.selected = Some(index);
                                cx.notify();
                            }
                        }))
                        .on_click(cx.listener(move |this, _, window, cx| {
                            this.activate_pane_menu(action, window, cx)
                        })),
                );
            }
        } else {
            body =
                body.p(px(8.))
                    .gap(px(12.))
                    .child(div().font_weight(FontWeight::SEMIBOLD).child("Rename pane"))
                    .child(
                        div()
                            .text_color(rgb(self.theme.subtext()))
                            .child("Leave blank to clear the custom label."),
                    )
                    .when_some(pane.input.clone(), |body, input| {
                        if pane.pending.is_some() {
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
                                    .id("pane-rename-cancel")
                                    .p(px(6.))
                                    .cursor_pointer()
                                    .child("Cancel")
                                    .on_click(cx.listener(|this, _, window, cx| {
                                        this.dismiss_menu(window, cx)
                                    })),
                            )
                            .child(
                                div()
                                    .id("pane-rename-submit")
                                    .p(px(6.))
                                    .rounded(px(crate::config::corners::CONTROL))
                                    .bg(rgb(self.theme.active))
                                    .cursor_pointer()
                                    .child(if pane.pending.is_some() {
                                        "Renaming..."
                                    } else {
                                        "Rename"
                                    })
                                    .on_click(cx.listener(|this, _, window, cx| {
                                        this.submit_pane_rename(window, cx)
                                    })),
                            ),
                    );
        }
        body.when_some(pane.error.clone(), |body, error| {
            // No width of its own, so the labels set the panel's width and
            // the message wraps inside it.
            body.child(div().w_0().min_w_full().p(px(8.)).child(error))
        })
    }
}
