//! The sidebar host header's context menu. Saved SSH devices have this one;
//! a WSL distribution's only offers its removal (see `wsl`). Local is always
//! present, and an explicit socket is not in the catalog.
use super::setup;
use crate::{
    HerdrWindow,
    config::{Config, KeybindingSource},
    github::Account,
    menu::Page,
    search_input::SearchInput,
};
use gpui::{prelude::*, *};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Action {
    Rename,
    /// Toggles `[devices.<id>] keybindings` between local and server.
    ServerKeybindings,
    /// Forwards one of the host's listening ports to this computer.
    ForwardPort,
    Remove,
}

const ACTIONS: [(Action, &str); 4] = [
    (Action::Rename, "Rename…"),
    (Action::ServerKeybindings, "Use server keybindings"),
    (Action::ForwardPort, "Forward port…"),
    (Action::Remove, "Remove device…"),
];

pub(crate) struct HostMenu {
    /// The endpoint, as the window and its account slots key it.
    id: String,
    /// The catalog profile the `herdr machine` commands name.
    profile: String,
    label: String,
    target: String,
    session: String,
    selected: Option<usize>,
    /// Also delete the device's own GitHub sign-in. Offered only when it has
    /// one, since its account panel disappears with the device.
    forget_github: bool,
    /// The new name while renaming, or the port to forward.
    input: Option<Entity<SearchInput>>,
    renaming: bool,
    error: Option<String>,
}

impl HerdrWindow {
    pub(crate) fn open_host_menu(
        &mut self,
        id: &str,
        anchor: Point<Pixels>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if id.starts_with(crate::endpoint::WSL_PREFIX) {
            if self.device_setup_unavailable().is_none() {
                self.open_remove_wsl(id, anchor, window, cx);
            }
            return;
        }
        // The CLI edits the default catalog, the one device setup also uses.
        // A device already being removed has nothing left to offer.
        if self.ssh_setup_unavailable().is_some() || self.menu.removing_devices.contains(id) {
            return;
        }
        let Some(endpoint) = self.endpoints.iter().find(|endpoint| endpoint.id == id) else {
            return;
        };
        // The saved entry, not the live target: removal claims and names the
        // profile, whichever session the list has attached the device to.
        let Some((target, session)) = endpoint.saved_ssh() else {
            return;
        };
        let Some(profile) = crate::endpoint::saved_profile_id(&endpoint.id) else {
            return;
        };
        let menu = HostMenu {
            id: endpoint.id.clone(),
            profile: profile.to_owned(),
            label: endpoint.label.clone(),
            target: target.to_owned(),
            session: session.to_owned(),
            selected: None,
            forget_github: true,
            input: None,
            renaming: false,
            error: None,
        };
        if !self.open_menu(window, cx) {
            return;
        }
        self.menu.anchor = anchor;
        self.menu.page = Some(Page::Host);
        self.menu.host = Some(menu);
    }

    /// Whether the device has a GitHub sign-in of its own saved on this computer.
    fn host_has_github(&self, id: &str) -> bool {
        self.menu
            .github_hosts
            .get(id)
            .is_some_and(|auth| auth.can_sign_out())
    }

    fn activate_host_menu(&mut self, action: Action, window: &mut Window, cx: &mut Context<Self>) {
        match action {
            Action::Rename => {
                let Some(host) = &self.menu.host else {
                    return;
                };
                let (label, target) = (host.label.clone(), host.target.clone());
                let input = cx.new(SearchInput::new);
                input.update(cx, |input, cx| {
                    input.set_appearance(self.config.ui.clone(), self.theme.clone(), cx);
                    // An empty name falls back to the target, as when adding.
                    input.set_placeholder(&target, cx);
                    input.set_text_selected(&label, cx);
                    window.focus(&input.focus, cx);
                });
                if let Some(host) = &mut self.menu.host {
                    host.input = Some(input);
                    host.error = None;
                }
                self.menu.page = Some(Page::RenameDevice);
            }
            Action::ServerKeybindings => self.toggle_server_keybindings(cx),
            Action::ForwardPort => {
                let input = cx.new(SearchInput::new);
                input.update(cx, |input, cx| {
                    input.set_appearance(self.config.ui.clone(), self.theme.clone(), cx);
                    input.set_placeholder("3000", cx);
                    window.focus(&input.focus, cx);
                });
                if let Some(host) = &mut self.menu.host {
                    host.input = Some(input);
                    host.error = None;
                }
                self.menu.page = Some(Page::ForwardPort);
            }
            Action::Remove => self.menu.page = Some(Page::RemoveDevice),
        }
        cx.notify();
    }

    /// Saves the other choice. The reload that follows the save applies it, in
    /// every window, so a save that could not start changes nothing.
    fn toggle_server_keybindings(&mut self, cx: &mut Context<Self>) {
        let Some(host) = &self.menu.host else {
            return;
        };
        let profile = host.profile.clone();
        let source = match self.config.keybinding_source(&host.id) {
            KeybindingSource::Local => KeybindingSource::Server,
            KeybindingSource::Server => KeybindingSource::Local,
        };
        self.save_preference(
            move || Config::save_device_keybindings(&profile, source),
            cx,
        );
    }

    /// Rename in the background and close once the catalog has the new name;
    /// the sidebar and picker pick it up from there.
    fn submit_rename_device(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(host) = &mut self.menu.host else {
            return;
        };
        let Some(input) = &host.input else {
            return;
        };
        if host.renaming || input.read(cx).is_composing() {
            return;
        }
        let label = match setup::device_label(input.read(cx).text(), &host.target) {
            Ok(label) => label,
            Err(error) => {
                host.error = Some(error.to_string());
                cx.notify();
                return;
            }
        };
        let (id, profile) = (host.id.clone(), host.profile.clone());
        host.renaming = true;
        host.error = None;
        let background = cx
            .background_executor()
            .spawn(async move { setup::rename(&profile, &label) });
        cx.spawn_in(window, async move |this, cx| {
            let result = background.await;
            let _ = this.update_in(cx, |this, window, cx| {
                // The menu may have closed or moved to another device meanwhile.
                let Some(host) = this
                    .menu
                    .host
                    .as_mut()
                    .filter(|host| host.id == id && host.renaming)
                else {
                    return;
                };
                host.renaming = false;
                match result {
                    Ok(()) => this.dismiss_menu(window, cx),
                    Err(error) => {
                        host.error = Some(error.to_string());
                        if let Some(input) = &host.input {
                            window.focus(&input.read(cx).focus.clone(), cx);
                        }
                        cx.notify();
                    }
                }
            });
        })
        .detach();
        cx.notify();
    }

    /// Close the confirmation at once and remove in the background. Until the
    /// catalog drops the device, its sidebar header pulses the way a worktree
    /// row does while it is removed; a failure is reported in the status bar.
    fn confirm_remove_device(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(host) = self.menu.host.take() else {
            return;
        };
        let forget = host.forget_github && self.host_has_github(&host.id);
        let store = self.menu.github_hosts.get(&host.id).map_or_else(
            || crate::github::Store::select(&self.config),
            |auth| auth.store(),
        );
        let HostMenu {
            id,
            profile,
            label,
            target,
            session,
            ..
        } = host;
        // The outer result is the removal itself; the inner one, the GitHub
        // credential that only matters once the device is gone.
        let background = cx.background_executor().spawn(async move {
            let _claim = setup::claim_saved(&target, &session)?;
            setup::remove(&profile)?;
            Ok::<_, crate::Error>(match Account::host(&profile).filter(|_| forget) {
                Some(account) => crate::github::forget(store, &account),
                None => Ok(()),
            })
        });
        self.menu.removing_devices.insert(id.clone());
        self.dismiss_menu(window, cx);
        cx.spawn(async move |this, cx| {
            let result = background.await;
            let _ = this.update(cx, |this, cx| {
                this.device_removed(&id, &label, forget, result, cx)
            });
        })
        .detach();
    }

    fn device_removed(
        &mut self,
        id: &str,
        label: &str,
        forget: bool,
        result: crate::Result<crate::Result<()>>,
        cx: &mut Context<Self>,
    ) {
        match result {
            Err(error) => {
                self.menu.removing_devices.remove(id);
                self.local_error = Some(format!("Remove {label}: {error}"));
            }
            // The catalog watcher drops the device, and a filter or selection
            // on it falls back to Local, as for any removal. The header keeps
            // pulsing until then; `prune_device_removals` clears the mark.
            Ok(forgotten) => {
                if forget {
                    self.menu.github_hosts.remove(id);
                }
                if let Err(error) = forgotten {
                    self.local_error = Some(format!(
                        "Removed {label}, but could not delete its GitHub sign-in: {error}"
                    ));
                }
            }
        }
        cx.notify();
    }

    /// Forget removal marks for devices the catalog no longer lists.
    pub(crate) fn prune_device_removals(&mut self) {
        let endpoints = &self.endpoints;
        self.menu
            .removing_devices
            .retain(|id| endpoints.iter().any(|endpoint| &endpoint.id == id));
    }

    pub(in crate::menu) fn host_menu_key(
        &mut self,
        event: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(host) = &mut self.menu.host else {
            return;
        };
        let key = event.keystroke.key.as_str();
        // The name and port fields own typing and composition; only their
        // submit and cancel keys belong to the menu.
        if matches!(self.menu.page, Some(Page::RenameDevice | Page::ForwardPort))
            && !host.renaming
            && (host
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
            "enter" if self.menu.page == Some(Page::RenameDevice) => {
                self.submit_rename_device(window, cx)
            }
            "enter" if self.menu.page == Some(Page::ForwardPort) => {
                self.submit_forward_port(window, cx)
            }
            "enter" if self.menu.page == Some(Page::RemoveDevice) => {
                self.confirm_remove_device(window, cx)
            }
            "space" if self.menu.page == Some(Page::RemoveDevice) => {
                host.forget_github = !host.forget_github;
                cx.notify();
            }
            key @ ("up" | "down") if self.menu.page == Some(Page::Host) => {
                host.selected = Some(match (host.selected, key) {
                    (None, "up") => ACTIONS.len() - 1,
                    (None, _) => 0,
                    (Some(i), "up") => (i + ACTIONS.len() - 1) % ACTIONS.len(),
                    (Some(i), _) => (i + 1) % ACTIONS.len(),
                });
                cx.notify();
            }
            "enter" => {
                if let Some(index) = host.selected {
                    self.activate_host_menu(ACTIONS[index].0, window, cx);
                }
            }
            _ => {}
        }
    }

    pub(in crate::menu) fn render_host_menu(&self, cx: &mut Context<Self>) -> Div {
        let Some(host) = &self.menu.host else {
            return div();
        };
        let theme = &self.theme;
        let mut body = div().flex().flex_col();
        if self.menu.page == Some(Page::Host) {
            // Name the device first, so the destructive row below cannot be
            // mistaken for acting on another host.
            body = body.child(
                // No width of its own, so a long name or target ends with
                // "…" instead of widening the menu past its actions.
                div()
                    .debug_selector(|| "host-menu-header".into())
                    .w_0()
                    .min_w_full()
                    .px(px(8.))
                    .pt(px(4.))
                    .pb(px(8.))
                    .mb(px(4.))
                    .border_b_1()
                    .border_color(rgb(theme.active))
                    .child(
                        div()
                            .font_weight(FontWeight::SEMIBOLD)
                            .truncate()
                            .child(host.label.clone()),
                    )
                    .child(
                        div()
                            .text_size(px(self.config.ui.size * 0.85))
                            .text_color(rgb(theme.muted))
                            .truncate()
                            .child(format!("{} · {}", host.target, host.session)),
                    ),
            );
            let server_keys = self.config.keybinding_source(&host.id) == KeybindingSource::Server;
            for (index, (action, label)) in ACTIONS.into_iter().enumerate() {
                let toggle = action == Action::ServerKeybindings;
                body = body.child(
                    div()
                        .id(("host-menu-action", index))
                        .debug_selector(move || format!("host-menu-{index}"))
                        .min_h(px(self.config.ui.line_height() + 12.))
                        .px(px(8.))
                        .flex()
                        .items_center()
                        .gap(px(8.))
                        .cursor_pointer()
                        .when(toggle, |row| {
                            row.child(crate::toggles::checkbox(
                                theme,
                                self.config.ui.size + 2.,
                                server_keys,
                            ))
                        })
                        .when(action == Action::Remove, |row| {
                            row.text_color(crate::menu::danger(theme))
                        })
                        .when(host.selected == Some(index), |row| {
                            row.bg(rgb(theme.active))
                        })
                        .hover(|row| row.bg(rgb(theme.active)))
                        .child(
                            div()
                                .debug_selector(move || format!("host-menu-label-{index}"))
                                .min_w_0()
                                .truncate()
                                .child(label),
                        )
                        .on_hover(cx.listener(move |this, hovered, _, cx| {
                            if *hovered && let Some(host) = &mut this.menu.host {
                                host.selected = Some(index);
                                cx.notify();
                            }
                        }))
                        .on_click(cx.listener(move |this, _, window, cx| {
                            this.activate_host_menu(action, window, cx)
                        })),
                );
                // Opting in never silently changes nothing: say why the
                // device is still on local keys.
                if let Some(error) = toggle
                    .then(|| self.server_keybindings_error(&host.id))
                    .flatten()
                {
                    body = body.child(
                        // No width of its own, so the labels set the menu's
                        // width and the message wraps inside it.
                        div()
                            .debug_selector(|| "host-menu-keybindings-error".into())
                            .w_0()
                            .min_w_full()
                            .px(px(8.))
                            .pb(px(4.))
                            .text_size(px(self.config.ui.size * 0.85))
                            .text_color(rgb(theme.muted))
                            .child(format!("Using local keybindings: {error}")),
                    );
                }
            }
            return body.child(self.render_forwards(host, cx));
        }
        if self.menu.page == Some(Page::RenameDevice) {
            return self.render_rename_device(host, cx);
        }
        if self.menu.page == Some(Page::ForwardPort) {
            return self.render_forward_port(host, cx);
        }
        let github = self.host_has_github(&host.id);
        body = body
            .debug_selector(|| "remove-device".into())
            .p(px(8.))
            .gap(px(12.))
            .child(
                div()
                    .font_weight(FontWeight::SEMIBOLD)
                    .child("Remove device"),
            )
            .child(div().text_color(rgb(theme.subtext())).child(format!(
                "Remove {} ({} · {}) from this computer? Herdr keeps running on that host.",
                host.label, host.target, host.session
            )))
            .when(github, |body| {
                body.child(
                    div()
                        .id("remove-device-github")
                        .debug_selector(|| "remove-device-github".into())
                        .flex()
                        .items_center()
                        .gap(px(8.))
                        .cursor_pointer()
                        .child(crate::toggles::checkbox(
                            theme,
                            self.config.ui.size + 2.,
                            host.forget_github,
                        ))
                        .child("Also delete its GitHub sign-in from this computer")
                        .on_click(cx.listener(|this, _, _, cx| {
                            if let Some(host) = &mut this.menu.host {
                                host.forget_github = !host.forget_github;
                                cx.notify();
                            }
                        })),
                )
            })
            .child(
                div()
                    .flex()
                    .justify_end()
                    .gap(px(8.))
                    .child(
                        div()
                            .id("remove-device-cancel")
                            .p(px(6.))
                            .cursor_pointer()
                            .child("Cancel")
                            .on_click(
                                cx.listener(|this, _, window, cx| this.dismiss_menu(window, cx)),
                            ),
                    )
                    .child(
                        div()
                            .id("remove-device-submit")
                            .debug_selector(|| "remove-device-submit".into())
                            .p(px(6.))
                            .rounded(px(crate::config::corners::CONTROL))
                            .bg(rgb(theme.active))
                            .text_color(crate::menu::danger(theme))
                            .cursor_pointer()
                            .child("Remove")
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.confirm_remove_device(window, cx)
                            })),
                    ),
            );
        body
    }

    /// A centered modal like Add Device: header with the title and Close,
    /// the name field in the body, and the action in the footer.
    fn render_rename_device(&self, host: &HostMenu, cx: &mut Context<Self>) -> Div {
        let theme = &self.theme;
        let header = div()
            .debug_selector(|| "rename-device-header".into())
            .flex_none()
            .p(px(16.))
            .border_b_1()
            .border_color(rgb(theme.active))
            .flex()
            .items_center()
            .gap(px(12.))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .text_size(px(self.config.ui.size * 1.35))
                    .font_weight(FontWeight::SEMIBOLD)
                    .child("Rename device"),
            )
            .child(
                div()
                    .id("rename-device-close")
                    .debug_selector(|| "rename-device-close".into())
                    .px_2()
                    .py_1()
                    .cursor_pointer()
                    .rounded(px(crate::config::corners::CONTROL))
                    .hover(|s| s.bg(rgb(theme.active)))
                    .child("Close")
                    .on_click(cx.listener(|this, _, window, cx| this.dismiss_menu(window, cx))),
            );
        let body = div()
            .debug_selector(|| "rename-device".into())
            .min_h_0()
            .p(px(16.))
            .flex()
            .flex_col()
            .gap(px(12.))
            .child(
                div()
                    .text_color(rgb(theme.muted))
                    .child(format!("{} · {}", host.target, host.session)),
            )
            .child(div().flex().flex_col().gap(px(6.)).child("Name").when_some(
                host.input.clone(),
                |field, input| {
                    if host.renaming {
                        field.child(div().child(input.read(cx).text().to_owned()))
                    } else {
                        field.child(input)
                    }
                },
            ))
            .when_some(host.error.clone(), |body, error| {
                body.child(div().text_color(crate::menu::danger(theme)).child(error))
            });
        let ready = !host.renaming;
        let footer = div()
            .debug_selector(|| "rename-device-footer".into())
            .flex_none()
            .p(px(16.))
            .border_t_1()
            .border_color(rgb(theme.active))
            .flex()
            .justify_end()
            .child(
                div()
                    .id("rename-device-submit")
                    .debug_selector(|| "rename-device-submit".into())
                    .p(px(8.))
                    .rounded(px(crate::config::corners::CONTROL))
                    .bg(rgb(theme.active))
                    .when(ready, |button| {
                        button.cursor_pointer().hover(|s| {
                            s.bg(rgb(theme.active).blend(rgba((theme.foreground << 8) | 0x20)))
                        })
                    })
                    .when(!ready, |button| button.text_color(rgb(theme.muted)))
                    .child(if ready { "Rename" } else { "Renaming…" })
                    .on_click(
                        cx.listener(|this, _, window, cx| this.submit_rename_device(window, cx)),
                    ),
            );
        div()
            .flex()
            .flex_col()
            .min_h_0()
            .child(header)
            .child(body)
            .child(footer)
    }
}

mod forwards;

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests;
