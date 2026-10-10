//! WSL distributions as devices: the dialog that lists this machine's
//! distributions and saves one once Herdr answers inside it, and removal, which
//! only forgets the distribution here. Nothing here installs Herdr, edits a
//! distribution, or boots one the user did not pick.
use super::Page;
use crate::{HerdrWindow, endpoint::WSL_PREFIX, search_input::SearchInput};
use gpui::{prelude::*, *};
use herdr_client::HostProbe;

pub(in crate::menu) struct WslSetup {
    distros: Distros,
    /// The distribution the user picked; the first unsaved one by default.
    selected: Option<String>,
    session: Entity<SearchInput>,
    step: Step,
    task: Option<Task<()>>,
}

enum Distros {
    Loading,
    Ready(Vec<String>),
    Failed(String),
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum Step {
    Form,
    /// Probing the distribution, then saving it when Herdr answers.
    Checking(String),
}

/// What became of one add: saved, or why not, in the dialog's words.
enum Outcome {
    Saved,
    Refused(String),
}

impl HerdrWindow {
    /// Show the dialog and list the distributions in the background.
    pub(super) fn open_add_wsl(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let session = cx.new(SearchInput::new);
        session.update(cx, |input, cx| {
            input.set_appearance(self.config.ui.clone(), self.theme.clone(), cx);
            input.set_placeholder("default", cx);
        });
        window.focus(&session.read(cx).focus.clone(), cx);
        let background = cx
            .background_executor()
            .spawn(async { herdr_client::list_distros() });
        let task = cx.spawn(async move |this, cx| {
            let result = background.await;
            let _ = this.update(cx, |this, cx| {
                let saved = this.saved_distros();
                let Some(setup) = &mut this.menu.wsl_setup else {
                    return;
                };
                setup.distros = match result {
                    Ok(distros) => {
                        setup.selected = distros
                            .iter()
                            .find(|distro| !saved.contains(distro))
                            .cloned();
                        Distros::Ready(distros)
                    }
                    Err(error) => Distros::Failed(error.to_string()),
                };
                setup.task = None;
                cx.notify();
            });
        });
        self.menu.wsl_setup = Some(WslSetup {
            distros: Distros::Loading,
            selected: None,
            session,
            step: Step::Form,
            task: Some(task),
        });
        self.menu.error = None;
        self.menu.page = Some(Page::AddWsl);
    }

    /// The distributions already saved as devices.
    fn saved_distros(&self) -> Vec<String> {
        self.endpoints
            .iter()
            .filter_map(|endpoint| endpoint.id.strip_prefix(WSL_PREFIX))
            .map(str::to_owned)
            .collect()
    }

    pub(in crate::menu) fn add_wsl_key(
        &mut self,
        event: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let saved = self.saved_distros();
        let Some(setup) = &mut self.menu.wsl_setup else {
            return;
        };
        if setup.session.read(cx).is_composing() {
            return;
        }
        match event.keystroke.key.as_str() {
            "enter" => self.submit_add_wsl(window, cx),
            "escape" => self.dismiss_menu(window, cx),
            key @ ("up" | "down") => {
                let Distros::Ready(distros) = &setup.distros else {
                    return;
                };
                // Only the distributions that can still be added, as a click allows.
                let distros: Vec<&String> = distros
                    .iter()
                    .filter(|distro| !saved.contains(distro))
                    .collect();
                if distros.is_empty() {
                    return;
                }
                let current = setup
                    .selected
                    .as_ref()
                    .and_then(|selected| distros.iter().position(|distro| *distro == selected));
                let next = match (current, key) {
                    (None, "up") => distros.len() - 1,
                    (None, _) => 0,
                    (Some(index), "up") => (index + distros.len() - 1) % distros.len(),
                    (Some(index), _) => (index + 1) % distros.len(),
                };
                setup.selected = Some(distros[next].to_owned());
                cx.notify();
            }
            _ => return,
        }
        cx.stop_propagation();
        window.prevent_default();
    }

    fn submit_add_wsl(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let saved = self.saved_distros();
        let Some(setup) = &mut self.menu.wsl_setup else {
            return;
        };
        if setup.step != Step::Form {
            return;
        }
        let Some(distro) = setup.selected.clone() else {
            self.menu.error = Some("Pick a distribution.".into());
            cx.notify();
            return;
        };
        if saved.contains(&distro) {
            self.menu.error = Some(format!("{distro} is already a device."));
            cx.notify();
            return;
        }
        let session = match setup.session.read(cx).text().trim() {
            "" => "default".to_owned(),
            session => session.to_owned(),
        };
        setup.step = Step::Checking(distro.clone());
        self.menu.error = None;
        let background = cx
            .background_executor()
            .spawn(async move { add(&distro, &session) });
        setup.task = Some(cx.spawn_in(window, async move |this, cx| {
            let outcome = background.await;
            let _ = this.update_in(cx, |this, window, cx| {
                let Some(setup) = &mut this.menu.wsl_setup else {
                    return;
                };
                setup.task = None;
                match outcome {
                    // The catalog poll shows the device; nothing is left to say.
                    Outcome::Saved => this.dismiss_menu(window, cx),
                    Outcome::Refused(message) => {
                        setup.step = Step::Form;
                        this.menu.error = Some(message);
                        cx.notify();
                    }
                }
            });
        }));
        cx.notify();
    }

    pub(in crate::menu) fn render_add_wsl(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = &self.theme;
        let view = div()
            .debug_selector(|| "wsl-setup-dialog".into())
            .flex()
            .flex_col()
            .min_h_0()
            .child(
                div()
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
                            .child("Add WSL Distribution"),
                    )
                    .child(
                        div()
                            .id("wsl-setup-close")
                            .debug_selector(|| "wsl-setup-close".into())
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
        let Some(setup) = &self.menu.wsl_setup else {
            return view;
        };
        let saved = self.saved_distros();
        let mut list = div()
            .debug_selector(|| "wsl-setup-distros".into())
            .flex()
            .flex_col()
            .gap(px(2.));
        match &setup.distros {
            Distros::Loading => {
                list = list.child(div().text_color(rgb(theme.muted)).child("Looking for distributions…"))
            }
            Distros::Failed(error) => {
                list = list.child(
                    div()
                        .text_color(crate::menu::danger(theme))
                        .child(format!("WSL did not list its distributions: {error}")),
                )
            }
            Distros::Ready(distros) if distros.is_empty() => {
                list = list.child(div().text_color(rgb(theme.muted)).child(
                    "No WSL distributions are installed. Install one with `wsl --install`, then open this dialog again.",
                ))
            }
            Distros::Ready(distros) => {
                for (index, distro) in distros.iter().enumerate() {
                    let added = saved.contains(distro);
                    let checked = setup.selected.as_ref() == Some(distro);
                    let pick = distro.clone();
                    list = list.child(
                        div()
                            .id(("wsl-distro", index))
                            .debug_selector(move || format!("wsl-distro-{index}"))
                            .px(px(8.))
                            .py(px(6.))
                            .rounded(px(crate::config::corners::CONTROL))
                            .flex()
                            .items_center()
                            .gap(px(8.))
                            .when(checked, |row| row.bg(rgb(theme.active)))
                            .when(added, |row| row.text_color(rgb(theme.muted)))
                            .when(!added, |row| {
                                row.cursor_pointer().hover(|s| s.bg(rgb(theme.active)))
                            })
                            .child(crate::toggles::radio(theme, self.config.ui.size + 2., checked))
                            .child(div().flex_1().truncate().child(distro.clone()))
                            .when(added, |row| row.child("Added"))
                            .on_click(cx.listener(move |this, _, _, cx| {
                                if added {
                                    return;
                                }
                                if let Some(setup) = &mut this.menu.wsl_setup {
                                    setup.selected = Some(pick.clone());
                                    cx.notify();
                                }
                            })),
                    );
                }
            }
        }
        let mut body = div()
            .id("wsl-setup-body")
            .debug_selector(|| "wsl-setup-body".into())
            .min_h_0()
            .overflow_y_scroll()
            .p(px(16.))
            .flex()
            .flex_col()
            .gap(px(12.))
            .child(div().flex_none().text_color(rgb(theme.subtext())).child(
                "Herdr is checked inside the distribution and its server started if it is installed. Install Herdr there first if it is not.",
            ))
            .child(list)
            .child(
                div()
                    .flex_none()
                    .flex()
                    .flex_col()
                    .gap(px(6.))
                    .child("Session (optional)")
                    .child(setup.session.clone()),
            );
        if let Some(error) = &self.menu.error {
            body = body.child(
                div()
                    .debug_selector(|| "wsl-setup-error".into())
                    .flex_none()
                    .text_color(crate::menu::danger(theme))
                    .child(error.clone()),
            );
        }
        if let Step::Checking(distro) = &setup.step {
            body = body.child(
                div()
                    .debug_selector(|| "wsl-setup-status".into())
                    .flex_none()
                    .text_color(rgb(theme.muted))
                    .child(format!("Checking Herdr in {distro}…")),
            );
        }
        let ready = setup.step == Step::Form && setup.selected.is_some();
        let footer = div()
            .flex_none()
            .p(px(16.))
            .border_t_1()
            .border_color(rgb(theme.active))
            .flex()
            .justify_end()
            .child(
                div()
                    .id("wsl-setup-submit")
                    .debug_selector(|| "wsl-setup-submit".into())
                    .p(px(8.))
                    .rounded(px(crate::config::corners::CONTROL))
                    .bg(rgb(theme.active))
                    .when(ready, |button| {
                        button.cursor_pointer().hover(|s| {
                            s.bg(rgb(theme.active).blend(rgba((theme.foreground << 8) | 0x20)))
                        })
                    })
                    .when(!ready, |button| button.text_color(rgb(theme.muted)))
                    .child(match setup.step {
                        Step::Form => "Add distribution",
                        Step::Checking(_) => "Checking…",
                    })
                    .on_click(cx.listener(|this, _, window, cx| this.submit_add_wsl(window, cx))),
            );
        view.child(body).child(footer)
    }

    /// Ask before forgetting a saved distribution.
    pub(crate) fn open_remove_wsl(
        &mut self,
        id: &str,
        anchor: Point<Pixels>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(distro) = id.strip_prefix(WSL_PREFIX) else {
            return;
        };
        if self.menu.removing_devices.contains(id) || !self.open_menu(window, cx) {
            return;
        }
        self.menu.anchor = anchor;
        self.menu.wsl_remove = Some(distro.to_owned());
        self.menu.page = Some(Page::RemoveWsl);
    }

    pub(in crate::menu) fn remove_wsl_key(
        &mut self,
        event: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match event.keystroke.key.as_str() {
            "enter" => self.confirm_remove_wsl(window, cx),
            "escape" => self.dismiss_menu(window, cx),
            _ => return,
        }
        cx.stop_propagation();
        window.prevent_default();
    }

    /// Close at once and forget the distribution in the background; its header
    /// pulses until the catalog drops it, like an SSH device's removal.
    fn confirm_remove_wsl(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(distro) = self.menu.wsl_remove.take() else {
            return;
        };
        let id = format!("{WSL_PREFIX}{distro}");
        let background = cx.background_executor().spawn({
            let distro = distro.clone();
            async move { herdr_client::remove_wsl_host(false, &distro) }
        });
        self.menu.removing_devices.insert(id.clone());
        self.dismiss_menu(window, cx);
        cx.spawn(async move |this, cx| {
            let result = background.await;
            let _ = this.update(cx, |this, cx| {
                if let Err(error) = result {
                    crate::storage_warning::warn_storage_failure("Remove WSL device", &error);
                    this.menu.removing_devices.remove(&id);
                    this.local_error = Some(format!("Remove {distro}: {error}"));
                    cx.notify();
                }
            });
        })
        .detach();
    }

    pub(in crate::menu) fn render_remove_wsl(&self, cx: &mut Context<Self>) -> Div {
        let theme = &self.theme;
        let Some(distro) = &self.menu.wsl_remove else {
            return div();
        };
        div()
            .debug_selector(|| "remove-wsl".into())
            .flex()
            .flex_col()
            .p(px(8.))
            .gap(px(12.))
            .child(
                div()
                    .font_weight(FontWeight::SEMIBOLD)
                    .child("Remove distribution"),
            )
            .child(div().text_color(rgb(theme.subtext())).child(format!(
                "Remove {distro} from this computer's devices? Herdr keeps running inside it."
            )))
            .child(
                div()
                    .flex()
                    .justify_end()
                    .gap(px(8.))
                    .child(
                        div()
                            .id("remove-wsl-cancel")
                            .p(px(6.))
                            .cursor_pointer()
                            .child("Cancel")
                            .on_click(
                                cx.listener(|this, _, window, cx| this.dismiss_menu(window, cx)),
                            ),
                    )
                    .child(
                        div()
                            .id("remove-wsl-submit")
                            .debug_selector(|| "remove-wsl-submit".into())
                            .p(px(6.))
                            .rounded(px(crate::config::corners::CONTROL))
                            .bg(rgb(theme.active))
                            .text_color(crate::menu::danger(theme))
                            .cursor_pointer()
                            .child("Remove")
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.confirm_remove_wsl(window, cx)
                            })),
                    ),
            )
    }
}

/// Check Herdr inside `distro` and save it when a compatible copy answers. A
/// stopped server is fine: the bridge starts it on the first connection.
/// Blocking: runs on the background executor.
fn add(distro: &str, session: &str) -> Outcome {
    match herdr_client::probe_distro(distro, session) {
        Ok(HostProbe::Running | HostProbe::Stopped) => {
            match herdr_client::add_wsl_host(false, distro, session) {
                Ok(()) => Outcome::Saved,
                Err(error) => {
                    crate::storage_warning::warn_storage_failure("Save WSL device", &error);
                    Outcome::Refused(format!("Save {distro}: {error}"))
                }
            }
        }
        Ok(HostProbe::Missing) => Outcome::Refused(format!(
            "Herdr was not found in {distro}. Install it inside the distribution, then add it again."
        )),
        Ok(HostProbe::Outdated) => Outcome::Refused(format!(
            "The Herdr in {distro} is too old for this app. Update it inside the distribution, then add it again."
        )),
        Ok(HostProbe::SshFailed) => Outcome::Refused(format!("{distro} did not answer.")),
        Err(error) => Outcome::Refused(format!("Check {distro}: {error}")),
    }
}

#[cfg(test)]
mod tests;
