//! The Add Device dialog: its form, the host check and save that run off the
//! UI thread, and the local workspace that carries a setup needing prompts.

use super::{Page, discover::Discovery, setup};
use crate::{
    HerdrWindow, NavigationTarget,
    search_input::{Changed, SearchInput},
};
use gpui::{prelude::*, *};
use herdr_client::{
    HostProbe, Method,
    protocol::{ClientKeyCode, ClientKeyKind, ClientPaneInputEvent},
};

pub(in crate::menu) struct Setup {
    pub(super) fields: [Entity<SearchInput>; 3],
    pub(super) step: Step,
    /// This process's claim on the host being added, from the first check
    /// until the device is saved or the dialog closes.
    pub(super) claim: Option<setup::Claim>,
    pub(super) task: Option<Task<()>>,
    /// The search for hosts to suggest, from when the form opens.
    pub(super) discovery: Option<Discovery>,
    /// The label a suggestion filled in, until the user edits it. Only that
    /// label is replaced when another suggestion is chosen.
    pub(super) suggested_label: Option<String>,
    /// Clears `suggested_label` once the label field holds anything else.
    pub(super) _label_edits: Option<Subscription>,
}

/// Where adding a device stands. Each step after `Form` belongs to the request
/// that was submitted, not to whatever the fields hold now.
pub(super) enum Step {
    Form,
    Checking(setup::Request),
    /// Herdr is present, so the CLI saves the device without a terminal. A
    /// stopped server is started by that same command.
    Saving(setup::Request, HostProbe),
    /// Saved; the next frame closes the dialog (see `poll_device_setup`).
    Saved,
    /// Setup needs prompts, so the user decides whether to run it locally.
    Confirm(setup::Request, Offer),
    /// Checking the catalog on disk again before opening the setup workspace.
    Verifying(setup::Request),
    /// Waiting for the local daemon to create the setup workspace.
    Opening(setup::Request, LocalSpace),
}

/// Why setup has to continue in a terminal.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Offer {
    Install,
    Update,
    /// SSH needs a prompt, or saving without a terminal failed.
    Terminal,
}

impl Offer {
    /// `None` when Herdr is present, so the device is saved without a terminal.
    pub(super) fn for_probe(probe: HostProbe) -> Option<Self> {
        match probe {
            HostProbe::Running | HostProbe::Stopped => None,
            HostProbe::Missing => Some(Self::Install),
            HostProbe::Outdated => Some(Self::Update),
            HostProbe::SshFailed => Some(Self::Terminal),
        }
    }

    pub(super) fn question(self, target: &str) -> String {
        match self {
            Self::Install => {
                format!("Herdr was not detected on {target}. Should we install it?")
            }
            Self::Update => {
                format!("The Herdr on {target} is too old for this app. Should we update it?")
            }
            Self::Terminal => format!(
                "Setting up {target} needs your input, such as an SSH password or host key. Continue in a local terminal?"
            ),
        }
    }

    fn action(self) -> &'static str {
        match self {
            Self::Install => "Install",
            Self::Update => "Update",
            Self::Terminal => "Open terminal",
        }
    }
}

/// The local workspace request whose root pane will run the setup command.
pub(super) struct LocalSpace {
    pub(super) request: String,
    pub(super) boot: String,
    pub(super) command: String,
}

impl HerdrWindow {
    /// Show an empty Add Device form with the target field focused.
    pub(super) fn open_add_device(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let fields = std::array::from_fn(|index| {
            let input = cx.new(SearchInput::new);
            input.update(cx, |input, cx| {
                input.set_appearance(self.config.ui.clone(), self.theme.clone(), cx);
                input.set_placeholder(
                    ["user@hostname or SSH alias", "The SSH target", "default"][index],
                    cx,
                );
            });
            input
        });
        window.focus(&fields[0].read(cx).focus.clone(), cx);
        let label_edits = cx.subscribe(&fields[1], |this, field, _: &Changed, cx| {
            if let Some(setup) = &mut this.menu.device_setup
                && setup.suggested_label.as_deref() != Some(field.read(cx).text())
            {
                setup.suggested_label = None;
            }
        });
        self.menu.device_setup = Some(Setup {
            fields,
            step: Step::Form,
            claim: None,
            task: None,
            discovery: None,
            suggested_label: None,
            _label_edits: Some(label_edits),
        });
        self.menu.page = Some(Page::AddDevice);
        self.start_device_discovery(cx);
    }

    /// Route a key to the Add Device form. Returns `false` when the key is
    /// left to propagate: during composition, or when the form ignores it.
    pub(super) fn add_device_key(
        &mut self,
        event: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        let Some(form) = &self.menu.device_setup else {
            return false;
        };
        if form
            .fields
            .iter()
            .any(|field| field.read(cx).is_composing())
        {
            return false;
        }
        match event.keystroke.key.as_str() {
            "tab" => {
                let index = form
                    .fields
                    .iter()
                    .position(|field| field.read(cx).focus.is_focused(window))
                    .unwrap_or(0);
                let next = (index
                    + if event.keystroke.modifiers.shift {
                        2
                    } else {
                        1
                    })
                    % 3;
                window.focus(&form.fields[next].read(cx).focus.clone(), cx);
            }
            "enter" => self.submit_device_setup(cx),
            "escape" => self.dismiss_menu(window, cx),
            _ => return false,
        }
        true
    }

    pub(in crate::menu) fn render_add_device(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = &self.theme;
        let view = div()
            .debug_selector(|| "device-setup-dialog".into())
            .flex()
            .flex_col()
            .min_h_0()
            .child(
                div()
                    .debug_selector(|| "device-setup-header".into())
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
                            .text_size(px(self.config.ui.size * 1.35))
                            .font_weight(FontWeight::SEMIBOLD)
                            .child("Add Device"),
                    )
                    .child(
                        div()
                            .id("device-setup-close")
                            .debug_selector(|| "device-setup-close".into())
                            .px_2()
                            .py_1()
                            .cursor_pointer()
                            .rounded(px(crate::config::corners::CONTROL))
                            .hover(|s| s.bg(rgb(theme.active)))
                            .child("Close")
                            .on_click(
                                cx.listener(|this, _, window, cx| this.dismiss_menu(window, cx)),
                            ),
                    ),
            );
        let Some(setup) = &self.menu.device_setup else {
            return view;
        };
        let mut body = div().id("device-setup-body").debug_selector(|| "device-setup-body".into())
            .min_h_0().overflow_y_scroll().p(px(16.)).flex().flex_col().gap(px(12.))
            .child(div().flex_none().text_color(rgb(theme.subtext()))
                .child("Herdr checks the host over SSH and saves the device. If Herdr is missing or SSH needs your input, setup continues in a local workspace."));
        for (index, (label, field)) in [
            "SSH target",
            "Label (optional)",
            "Remote session (optional)",
        ]
        .into_iter()
        .zip(&setup.fields)
        .enumerate()
        {
            body = body.child(
                div()
                    .flex_none()
                    .flex()
                    .flex_col()
                    .gap(px(6.))
                    .child(label)
                    .child(field.clone()),
            );
            // Suggestions fill the target, so they sit right under it, and
            // only while the form can still take one.
            if index == 0
                && matches!(setup.step, Step::Form)
                && let Some(discovery) = &setup.discovery
            {
                body = body.child(self.render_device_suggestions(discovery, cx));
            }
        }
        if let Some(error) = &self.menu.error {
            body = body.child(
                div()
                    .flex_none()
                    .text_color(crate::menu::danger(theme))
                    .child(error.clone()),
            );
        }
        let status = match &setup.step {
            Step::Form => None,
            Step::Checking(request) => Some(format!("Checking Herdr on {}…", request.target())),
            Step::Saving(request, HostProbe::Stopped) => Some(format!(
                "Herdr is installed on {} but not running. Starting it…",
                request.target()
            )),
            Step::Saving(request, _) => Some(format!(
                "Herdr is running on {}. Saving the device…",
                request.target()
            )),
            Step::Saved => None,
            Step::Confirm(request, offer) => Some(offer.question(request.target())),
            Step::Verifying(request) => {
                Some(format!("Checking {} is not saved yet…", request.target()))
            }
            Step::Opening(..) => Some("Opening a local workspace…".into()),
        };
        if let Some(status) = status {
            body = body.child(
                div()
                    .debug_selector(|| "device-setup-status".into())
                    .flex_none()
                    .text_color(rgb(theme.muted))
                    .child(status),
            );
        }
        let button = |id: &'static str, label: SharedString, enabled: bool| {
            div()
                .id(id)
                .debug_selector(move || id.into())
                .p(px(8.))
                .rounded(px(crate::config::corners::CONTROL))
                .bg(rgb(theme.active))
                .when(enabled, |button| {
                    button.cursor_pointer().hover(|s| {
                        s.bg(rgb(theme.active).blend(rgba((theme.foreground << 8) | 0x20)))
                    })
                })
                .when(!enabled, |button| button.text_color(rgb(theme.muted)))
                .child(label)
        };
        let mut footer = div()
            .debug_selector(|| "device-setup-footer".into())
            .flex_none()
            .p(px(16.))
            .border_t_1()
            .border_color(rgb(theme.active))
            .flex()
            .justify_end()
            .gap(px(8.));
        footer = match &setup.step {
            Step::Confirm(_, offer) => footer
                .child(
                    button("device-setup-cancel", "Cancel".into(), true).on_click(cx.listener(
                        |this, _, _, cx| {
                            if let Some(setup) = &mut this.menu.device_setup {
                                setup.step = Step::Form;
                                this.menu.error = None;
                                cx.notify();
                            }
                        },
                    )),
                )
                .child(
                    button("device-setup-submit", offer.action().into(), true)
                        .on_click(cx.listener(|this, _, _, cx| this.open_setup_space(cx))),
                ),
            step => {
                let ready = matches!(step, Step::Form);
                footer.child(
                    button(
                        "device-setup-submit",
                        if ready { "Add device" } else { "Checking…" }.into(),
                        ready,
                    )
                    .on_click(cx.listener(|this, _, _, cx| this.submit_device_setup(cx))),
                )
            }
        };
        view.child(body).child(footer)
    }

    /// Refuse a host already in the catalog. Checked again before each step
    /// that saves, since another window or the CLI can add it meanwhile. A
    /// device is matched by its saved entry: the sessions list may have attached
    /// it to another session, and that does not add one to the catalog.
    pub(super) fn ensure_new_device(&self, request: &setup::Request) -> crate::Result<()> {
        match self.endpoints.iter().find(|endpoint| {
            endpoint
                .saved_ssh()
                .is_some_and(|(target, session)| request.same_host(target, session))
        }) {
            Some(endpoint) => Err(crate::Error::DeviceExists(endpoint.label.clone())),
            None => Ok(()),
        }
    }

    fn submit_device_setup(&mut self, cx: &mut Context<Self>) {
        let Some(form) = &mut self.menu.device_setup else {
            return;
        };
        match &form.step {
            Step::Form => {}
            Step::Confirm(..) => return self.open_setup_space(cx),
            _ => return,
        }
        let request = setup::Request::new(
            form.fields[0].read(cx).text(),
            form.fields[1].read(cx).text(),
            form.fields[2].read(cx).text(),
        );
        let request = match request.and_then(|request| {
            self.ensure_new_device(&request)?;
            Ok(request)
        }) {
            Ok(request) => request,
            Err(error) => {
                self.menu.error = Some(error.to_string());
                cx.notify();
                return;
            }
        };
        let Some(form) = &mut self.menu.device_setup else {
            return;
        };
        form.step = Step::Checking(request.clone());
        self.menu.error = None;
        // Claim before probing: a second add of this host, from any window of
        // this process, is refused from here on rather than after a slow probe.
        let background = cx.background_executor().spawn(async move {
            let claim = setup::claim(&request)?;
            Ok::<_, crate::Error>((claim, request.probe()))
        });
        form.task = Some(cx.spawn(async move |this, cx| {
            let result = background.await;
            let _ = this.update(cx, |this, cx| this.device_probed(result, cx));
        }));
        cx.notify();
    }

    /// Return to the form when the host is already saved or being added:
    /// offering a terminal would only add it again.
    fn refuse_duplicate(&mut self, error: &crate::Error, cx: &mut Context<Self>) -> bool {
        if !matches!(
            error,
            crate::Error::DeviceExists(_) | crate::Error::DeviceAdding
        ) {
            return false;
        }
        if let Some(form) = &mut self.menu.device_setup {
            form.step = Step::Form;
            form.claim = None;
        }
        self.menu.error = Some(error.to_string());
        cx.notify();
        true
    }

    pub(super) fn device_probed(
        &mut self,
        result: crate::Result<(setup::Claim, crate::Result<HostProbe>)>,
        cx: &mut Context<Self>,
    ) {
        let Some(Setup {
            step: Step::Checking(request),
            ..
        }) = &self.menu.device_setup
        else {
            return;
        };
        let request = request.clone();
        let (claim, probe) = match result {
            Ok(result) => result,
            Err(error) => {
                if !self.refuse_duplicate(&error, cx) {
                    self.menu.error = Some(format!("Check {}: {error}", request.target()));
                    if let Some(form) = &mut self.menu.device_setup {
                        form.step = Step::Confirm(request, Offer::Terminal);
                    }
                    cx.notify();
                }
                return;
            }
        };
        let offer = match probe {
            Ok(probe) => match Offer::for_probe(probe) {
                None => return self.save_device(request, probe, claim, cx),
                Some(offer) => offer,
            },
            Err(error) => {
                self.menu.error = Some(format!("Check {}: {error}", request.target()));
                Offer::Terminal
            }
        };
        if let Some(form) = &mut self.menu.device_setup {
            form.step = Step::Confirm(request, offer);
            form.claim = Some(claim);
        }
        cx.notify();
    }

    fn save_device(
        &mut self,
        request: setup::Request,
        probe: HostProbe,
        claim: setup::Claim,
        cx: &mut Context<Self>,
    ) {
        let Some(form) = &mut self.menu.device_setup else {
            return;
        };
        form.step = Step::Saving(request.clone(), probe);
        // The claim travels with the save and comes back, so a failure that
        // offers a terminal still holds the host.
        let background = cx.background_executor().spawn(async move {
            let result = setup::save(&request, &claim);
            (result, claim)
        });
        form.task = Some(cx.spawn(async move |this, cx| {
            let (result, claim) = background.await;
            let _ = this.update(cx, |this, cx| {
                let Some(Setup {
                    step: Step::Saving(request, _),
                    ..
                }) = &this.menu.device_setup
                else {
                    return;
                };
                let request = request.clone();
                let error = match result {
                    Ok(()) => {
                        // Saved: the catalog now refuses this host by itself.
                        if let Some(form) = &mut this.menu.device_setup {
                            form.step = Step::Saved;
                        }
                        cx.notify();
                        return;
                    }
                    Err(error) => error,
                };
                if this.refuse_duplicate(&error, cx) {
                    return;
                }
                this.menu.error = Some(error.to_string());
                if let Some(form) = &mut this.menu.device_setup {
                    form.step = Step::Confirm(request, Offer::Terminal);
                    form.claim = Some(claim);
                }
                cx.notify();
            });
        }));
        cx.notify();
    }

    /// Check the catalog on disk once more, then ask the local daemon for a
    /// workspace whose root pane runs the setup (see `poll_device_setup`).
    fn open_setup_space(&mut self, cx: &mut Context<Self>) {
        let Some(form) = &mut self.menu.device_setup else {
            return;
        };
        let Step::Confirm(request, _) = &form.step else {
            return;
        };
        let request = request.clone();
        let claim = form.claim.take();
        form.step = Step::Verifying(request.clone());
        self.menu.error = None;
        let background = cx.background_executor().spawn(async move {
            // A failed probe left no claim; take one now.
            match claim {
                Some(claim) => setup::verify_unsaved(&request, &claim).map(|()| claim),
                None => setup::claim(&request),
            }
        });
        form.task = Some(cx.spawn(async move |this, cx| {
            let result = background.await;
            let _ = this.update(cx, |this, cx| this.setup_space_verified(result, cx));
        }));
        cx.notify();
    }

    pub(super) fn setup_space_verified(
        &mut self,
        result: crate::Result<setup::Claim>,
        cx: &mut Context<Self>,
    ) {
        let Some(Setup {
            step: Step::Verifying(request),
            ..
        }) = &self.menu.device_setup
        else {
            return;
        };
        let request = request.clone();
        let claim = match result {
            Ok(claim) => claim,
            Err(error) => {
                if !self.refuse_duplicate(&error, cx) {
                    self.menu.error = Some(format!("Open a local workspace: {error}"));
                    if let Some(form) = &mut self.menu.device_setup {
                        form.step = Step::Confirm(request, Offer::Terminal);
                    }
                    cx.notify();
                }
                return;
            }
        };
        let local = &self.endpoints[0];
        let result = (|| {
            let setup = setup::terminal_command(&request)?;
            let boot = local
                .live
                .snapshot
                .as_ref()
                .filter(|_| local.live.status.is_connected())
                .map(|snapshot| snapshot.boot_id.clone())
                .ok_or(crate::Error::NotConnected)?;
            let id = local.connection.request_dialog(
                &boot,
                Method::WorkspaceCreate,
                serde_json::json!({
                    "focus": true,
                    "label": format!("Set up {}", request.label()),
                    "env": setup.environment,
                }),
            )?;
            Ok::<_, crate::Error>(LocalSpace {
                request: id,
                boot,
                command: setup.command,
            })
        })();
        let Some(form) = &mut self.menu.device_setup else {
            return;
        };
        form.claim = Some(claim);
        match result {
            Ok(space) => form.step = Step::Opening(request, space),
            Err(error) => {
                form.step = Step::Confirm(request, Offer::Terminal);
                self.menu.error = Some(format!("Open a local workspace: {error}"));
            }
        }
        cx.notify();
    }

    /// Runs the setup command in the workspace the local daemon created, then
    /// shows it. The command is typed into the pane's shell: the endpoint API
    /// has no method that starts a command in a pane.
    pub(crate) fn poll_device_setup(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        // A saved device appears in the sidebar and picker by itself, so the
        // dialog has nothing left to say. Closing here, where the window is
        // at hand, returns focus to the terminal.
        if self
            .menu
            .device_setup
            .as_ref()
            .is_some_and(|form| matches!(form.step, Step::Saved))
        {
            return self.dismiss_menu(window, cx);
        }
        let Some(Setup {
            step: Step::Opening(_, space),
            ..
        }) = &self.menu.device_setup
        else {
            return;
        };
        let local = &self.endpoints[0];
        let fail = |this: &mut Self, error: String, cx: &mut Context<Self>| {
            if let Some(form) = &mut this.menu.device_setup
                && let Step::Opening(request, _) = &form.step
            {
                form.step = Step::Confirm(request.clone(), Offer::Terminal);
            }
            this.menu.error = Some(format!("Open a local workspace: {error}"));
            cx.notify();
        };
        let current = local.live.status.is_connected()
            && local
                .live
                .snapshot
                .as_ref()
                .is_some_and(|snapshot| snapshot.boot_id == space.boot);
        if !current {
            return fail(self, crate::Error::StaleConnection.to_string(), cx);
        }
        let Some((id, Some(result))) = &local.live.dialog_response else {
            return;
        };
        if id != &space.request {
            return;
        }
        let response = match result {
            Ok(response) => response,
            Err(error) => return fail(self, error.to_string(), cx),
        };
        if let Some(error) = response.get("error") {
            let (code, message) = crate::menu::endpoint_error(error);
            return fail(self, format!("{code}: {message}"), cx);
        }
        let result = &response["result"];
        let created = (result["type"] == "workspace_created")
            .then(|| {
                Some((
                    result["workspace"]["workspace_id"].as_str()?,
                    result["root_pane"]["pane_id"].as_str()?,
                ))
            })
            .flatten()
            .filter(|(workspace, pane)| !workspace.is_empty() && !pane.is_empty());
        let Some((workspace, pane)) = created else {
            return fail(self, "Unexpected daemon response".into(), cx);
        };
        let (workspace, pane) = (workspace.to_owned(), pane.to_owned());
        let sent = local
            .connection
            .handle
            .as_ref()
            .ok_or(crate::Error::NotConnected)
            .and_then(|handle| {
                Ok(handle.send_input(
                    &space.boot,
                    &pane,
                    [
                        ClientPaneInputEvent::TextCommit(space.command.clone()),
                        enter(),
                    ],
                )?)
            });
        if let Err(error) = sent {
            return fail(self, error.to_string(), cx);
        }
        // The terminal's `machine add` outlives this dialog; keep the host
        // claimed so this process cannot start a second add meanwhile.
        if let Some(claim) = self
            .menu
            .device_setup
            .as_mut()
            .and_then(|form| form.claim.take())
        {
            claim.hold();
        }
        let local = local.id.clone();
        self.dismiss_menu(window, cx);
        self.navigate_endpoint(&local, NavigationTarget::Workspace(&workspace), cx);
    }
}

/// The Enter key, which submits a line typed into a pane's shell.
pub(crate) fn enter() -> ClientPaneInputEvent {
    ClientPaneInputEvent::Key {
        code: ClientKeyCode::Enter,
        modifiers: 0,
        kind: ClientKeyKind::Press,
        repeat_count: 1,
        shifted_codepoint: None,
        generated_text: None,
        tracks_release: false,
        physical_key_id: None,
        windows_record: None,
    }
}
