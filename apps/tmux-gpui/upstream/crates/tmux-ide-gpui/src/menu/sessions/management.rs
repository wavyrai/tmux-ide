//! Picker forms capture device identity and host, never a mutable row ordinal.
use super::*;
use crate::search_input::SearchInput;
use herdr_client::RemoteHost;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(in crate::menu) enum Target {
    Local,
    Device { id: String, host: RemoteHost },
}

pub(in crate::menu) enum Edit {
    Create {
        target: Target,
        input: Entity<SearchInput>,
    },
    Delete {
        row: Row,
        target: Target,
    },
}

impl HerdrWindow {
    pub(super) fn local_management_available(&self) -> bool {
        !self.local_development()
            && !matches!(
                self.endpoints[0].connection.target,
                ConnectTarget::Socket(_)
            )
    }

    pub(super) fn add_session_entry(&self, target: Target) -> Entry {
        let unavailable = self.create_unavailable(&target);
        let enabled = unavailable.is_none();
        let detail = unavailable.unwrap_or("Create and connect");
        Entry::Row {
            row: Row::Add(target),
            spec: Spec {
                label: "Add session…".into(),
                detail: detail.into(),
                online: false,
                checked: false,
                enabled,
            },
        }
    }

    pub(super) fn management_target(&self, row: &Row) -> Option<Target> {
        match row {
            Row::Local(_) if self.local_management_available() => Some(Target::Local),
            Row::Device { id, .. } => self
                .endpoints
                .iter()
                .find(|e| e.id == *id && e.enabled)
                .and_then(|e| e.connection.target.remote_host())
                .filter(host_available)
                .map(|host| Target::Device {
                    id: id.clone(),
                    host,
                }),
            _ => None,
        }
    }

    /// Why a session cannot be created on `target` right now, if it cannot. A
    /// device must be connected: its sessions are created over the same SSH
    /// route, and an offline host would only fail after the form is filled in.
    fn create_unavailable(&self, target: &Target) -> Option<&'static str> {
        match target {
            Target::Local => {
                (!self.local_management_available()).then_some("Unavailable with --socket or --dev")
            }
            Target::Device { host, .. } if !host_available(host) => Some(match host {
                RemoteHost::Ssh(_) => "SSH is unavailable on Windows",
                RemoteHost::Wsl(_) => "WSL is only available on Windows",
            }),
            Target::Device { id, host } => {
                let Some(endpoint) = self.endpoints.iter().find(|e| {
                    e.id == *id
                        && e.enabled
                        && e.connection.target.remote_host().as_ref() == Some(host)
                }) else {
                    return Some("Enable this device to manage sessions");
                };
                (!endpoint.live.status.is_connected())
                    .then_some("Available once this device is online")
            }
        }
    }

    fn target_available(&self, target: &Target) -> bool {
        self.create_unavailable(target).is_none()
    }

    pub(super) fn session_delete_reason(&self, row: &Row) -> Option<&'static str> {
        if self.sessions.mutation.is_some() {
            return Some("Wait for session deletion to finish.");
        }
        let name = match row {
            Row::Local(name) | Row::Device { session: name, .. } => name,
            Row::Add(_) => return Some("Select a session to delete."),
        };
        if name == "default" {
            return Some("Herdr cannot delete the default session.");
        }
        let Some(target) = self.management_target(row) else {
            return Some(
                "Session management is unavailable for explicit sockets, development catalogs, or disabled devices.",
            );
        };
        match target {
            Target::Local => {
                if !self.sessions.entries.iter().any(|s| s.name == *name) {
                    return Some("Refresh the session list before deleting.");
                }
            }
            Target::Device { id, host } => {
                if self.endpoints.iter().any(|e| {
                    let saved = e.saved_target();
                    saved.remote_host().as_ref() == Some(&host)
                        && saved.remote_session() == Some(name.as_str())
                }) {
                    return Some(
                        "A saved device profile uses this session. Remove or reconfigure that profile before deleting it.",
                    );
                }
                let Some(DeviceScan::Sessions(sessions)) = self.sessions.devices.answers.get(&id)
                else {
                    return Some("Wait for this device's session list before deleting.");
                };
                if !sessions.iter().any(|s| s.name == *name) {
                    return Some("This session is not in the device's latest list.");
                }
            }
        }
        None
    }

    pub(super) fn open_session_create(
        &mut self,
        target: Target,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !self.target_available(&target) || self.sessions.mutation.is_some() {
            return;
        }
        let input = cx.new(|cx| {
            let mut input = SearchInput::new(cx);
            input.set_placeholder("Session name", cx);
            input.set_appearance(self.config.ui.clone(), self.theme.clone(), cx);
            input
        });
        window.focus(&input.read(cx).focus.clone(), cx);
        self.menu.error = None;
        self.menu.session_edit = Some(Edit::Create { target, input });
        cx.notify();
    }

    pub(super) fn confirm_session_delete(
        &mut self,
        row: Row,
        painted_target: Option<Target>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.management_target(&row) != painted_target {
            self.sessions.mutation_error =
                Some("The device changed. Reopen the session picker.".into());
            cx.notify();
            return;
        }
        if let Some(reason) = self.session_delete_reason(&row) {
            self.sessions.mutation_error = Some(reason.into());
        } else if let Some(target) = self.management_target(&row) {
            self.menu.error = None;
            self.menu.session_edit = Some(Edit::Delete { row, target });
            window.focus(&self.menu.focus, cx);
        }
        cx.notify();
    }

    fn cancel_session_edit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.menu.session_edit = None;
        self.menu.error = None;
        window.focus(&self.menu.focus, cx);
        cx.notify();
    }

    fn submit_session_edit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.sessions.mutation.is_some() {
            return;
        }
        let Some(edit) = &self.menu.session_edit else {
            return;
        };
        match edit {
            Edit::Create { target, input } => {
                if input.read(cx).is_composing() {
                    return;
                }
                let name = input.read(cx).text().to_owned();
                let target = target.clone();
                if !self.target_available(&target) {
                    self.menu.error = Some(
                        "The device changed or is unavailable. Reopen the session picker.".into(),
                    );
                    cx.notify();
                    return;
                }
                if herdr_client::session_socket(std::path::Path::new(""), &name).is_err() {
                    self.menu.error = Some("Use 1–64 ASCII letters, digits, dots, underscores or hyphens. The names ‘.’ and ‘..’ are not allowed.".into());
                    cx.notify();
                    return;
                }
                let duplicate = name == "default"
                    || match &target {
                        Target::Local => self
                            .sessions
                            .entries
                            .iter()
                            .any(|s| s.name.eq_ignore_ascii_case(&name)),
                        Target::Device { id, .. } => {
                            matches!(self.sessions.devices.answers.get(id),
                        Some(DeviceScan::Sessions(sessions)) if sessions.iter().any(|s| s.name == name))
                        }
                    };
                if duplicate {
                    self.menu.error =
                        Some("That session already exists. Select it from the list.".into());
                    cx.notify();
                    return;
                }
                let row = match target {
                    Target::Local => Row::Local(name),
                    Target::Device { id, .. } => Row::Device { id, session: name },
                };
                // The normal connection worker starts `herdr --session NAME
                // server` locally or remote-client-bridge over SSH. Startup
                // errors belong to that connection's authoritative inbox.
                self.sessions.refresh();
                self.sessions.devices.refresh();
                self.choose_session(row, window, cx);
            }
            Edit::Delete { row, target } => {
                if self.management_target(row).as_ref() != Some(target) {
                    self.menu.error = Some("The device changed. Reopen the session picker.".into());
                    cx.notify();
                    return;
                }
                if let Some(reason) = self.session_delete_reason(row) {
                    self.menu.error = Some(reason.into());
                    cx.notify();
                    return;
                }
                let name = match row {
                    Row::Local(name) | Row::Device { session: name, .. } => name.clone(),
                    Row::Add(_) => return,
                };
                let target = target.clone();
                let connection = match &target {
                    Target::Local => ConnectTarget::Session {
                        name: name.clone(),
                        development: false,
                    },
                    Target::Device { host, .. } => host.target(name.clone()),
                };
                // Retire old inboxes before stopping the daemon, so this window
                // cannot reconnect to and recreate the name being deleted.
                if self.retarget_session_for_deletion(&connection) {
                    self.reconnect(cx);
                    self.menu.page = Some(Page::Sessions);
                    self.menu.selected = Some(0);
                }
                let background = cx.background_executor().spawn(async move {
                    match target {
                        Target::Local => {
                            herdr_client::delete_local_session(&crate::daemon::executable(), &name)
                        }
                        Target::Device { host, .. } => host.delete_session(&name),
                    }
                });
                self.sessions.mutation_error = None;
                self.sessions.mutation_target = Some(connection.clone());
                self.cancel_session_edit(window, cx);
                let timer = cx.background_executor().clone();
                self.sessions.mutation = Some(cx.spawn(async move |this, cx| {
                    let result = background.await;
                    if result.is_ok() {
                        let _ = this.update(cx, |this, cx| {
                            this.sessions.departure = Some(crate::sessions::Departure::new(
                                connection,
                                std::time::Instant::now(),
                            ));
                            cx.notify();
                        });
                        timer.timer(crate::sessions::DELETION_ANIMATION).await;
                    }
                    let _ = this.update(cx, |this, cx| {
                        this.finish_session_departure();
                        this.sessions.mutation = None;
                        this.sessions.mutation_target = None;
                        this.sessions.mutation_error = result.err().map(|error| error.to_string());
                        // Refresh even after a timeout: the CLI may have applied
                        // the operation before its answer was lost.
                        this.sessions.refresh();
                        this.sessions.devices.refresh();
                        cx.notify();
                    });
                }));
            }
        }
    }

    pub(super) fn session_edit_key(
        &mut self,
        event: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if matches!(&self.menu.session_edit, Some(Edit::Create { input, .. }) if input.read(cx).is_composing())
        {
            return;
        }
        match event.keystroke.key.as_str() {
            "enter" => self.submit_session_edit(window, cx),
            "escape" => self.cancel_session_edit(window, cx),
            _ => {}
        }
    }

    pub(super) fn render_session_edit(&self, cx: &mut Context<Self>) -> Div {
        let theme = &self.theme;
        let mut view = div()
            .debug_selector(|| "session-modal".into())
            .flex()
            .flex_col()
            .gap(px(12.))
            .p(px(12.));
        match &self.menu.session_edit {
            Some(Edit::Create { input, target }) => {
                let destination = match target {
                    Target::Local => "this machine".to_owned(),
                    Target::Device {
                        host: RemoteHost::Ssh(target),
                        ..
                    } => target.clone(),
                    Target::Device {
                        host: RemoteHost::Wsl(distro),
                        ..
                    } => format!("WSL {distro}"),
                };
                view = view.child(div().text_size(px(self.config.ui.size * 1.35))
                    .font_weight(FontWeight::SEMIBOLD).child("Add session"))
                    .child(div().text_color(rgb(theme.muted)).child(format!("On {destination}")))
                    .child(input.clone())
                    .child(div().text_color(rgb(theme.subtext())).child("Creates and connects to a headless session. An existing name connects to that session."));
            }
            Some(Edit::Delete { row, .. }) => {
                let name = match row {
                    Row::Local(name) | Row::Device { session: name, .. } => name.as_str(),
                    Row::Add(_) => "",
                };
                view = view
                    .child(
                        div()
                            .text_size(px(self.config.ui.size * 1.35))
                            .font_weight(FontWeight::SEMIBOLD)
                            .child("Delete session?"),
                    )
                    .child(div().min_w_0().truncate().child(name.to_owned()))
                    .child(div().text_color(rgb(theme.subtext())).child(
                        "Herdr will stop this session, terminate its running processes, and remove its saved state. If you are using it, this window switches to default. This cannot be undone.",
                    ));
            }
            None => return view,
        }
        if let Some(error) = &self.menu.error {
            view = view.child(
                div()
                    .text_color(colors::danger(&self.theme))
                    .child(error.clone()),
            );
        }
        view.child(
            div()
                .flex()
                .justify_end()
                .gap(px(8.))
                .child(
                    div()
                        .id("session-edit-cancel")
                        .debug_selector(|| "session-edit-cancel".into())
                        .px(px(12.))
                        .py(px(6.))
                        .rounded(px(crate::config::corners::CONTROL))
                        .border_1()
                        .border_color(rgb(theme.active))
                        .hover(|s| s.bg(rgb(theme.active)))
                        .cursor_pointer()
                        .child("Cancel")
                        .on_click(
                            cx.listener(|this, _, window, cx| this.cancel_session_edit(window, cx)),
                        ),
                )
                .child(
                    div()
                        .id("session-edit-submit")
                        .debug_selector(|| "session-edit-submit".into())
                        .px(px(12.))
                        .py(px(6.))
                        .rounded(px(crate::config::corners::CONTROL))
                        .border_1()
                        .border_color(rgb(theme.active))
                        .bg(rgb(theme.active))
                        .when(
                            matches!(self.menu.session_edit, Some(Edit::Delete { .. })),
                            |s| s.text_color(colors::danger(theme)),
                        )
                        .cursor_pointer()
                        .child(
                            if matches!(self.menu.session_edit, Some(Edit::Create { .. })) {
                                "Create and connect"
                            } else {
                                "Delete permanently"
                            },
                        )
                        .on_click(
                            cx.listener(|this, _, window, cx| this.submit_session_edit(window, cx)),
                        ),
                ),
        )
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests;

/// Whether this build can reach `host` to manage its sessions: SSH from a POSIX
/// client, WSL from Windows.
fn host_available(host: &RemoteHost) -> bool {
    match host {
        RemoteHost::Ssh(_) => !cfg!(windows),
        RemoteHost::Wsl(_) => cfg!(windows),
    }
}
