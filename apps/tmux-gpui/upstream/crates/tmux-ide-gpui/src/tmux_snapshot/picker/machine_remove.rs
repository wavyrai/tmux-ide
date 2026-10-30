use super::super::controls::{self, ButtonStyle, Icon};
use super::*;
use bezel_ui::widgets::Status;
pub(super) struct Confirmation {
    pub(super) identity: std::rc::Rc<()>,
    request: u64,
    revision: u64,
    profile: browser::machines::Profile,
    submitted: bool,
    confirm_focus: FocusHandle,
    cancel_focus: FocusHandle,
}
impl Confirmation {
    fn feedback(&self, registry: Option<&browser::machines::Registry>) -> (bool, &'static str) {
        let removed = self.submitted
            && registry.is_some_and(|r| {
                r.available && !r.pending && !r.machines.iter().any(|p| p.id == self.profile.id)
            });
        let status = if removed {
            "Saved connection removed."
        } else if self.submitted && registry.is_some_and(|r| r.pending) {
            "Removal submitted — waiting for saved machines. Cancel and refresh if unconfirmed."
        } else if self.submitted {
            "Removal not confirmed. Cancel and refresh saved machines before trying again."
        } else {
            "Remove this saved connection? Remote sessions keep running."
        };
        (removed, status)
    }
}
impl SnapshotView {
    pub(super) fn begin_machine_removal(
        &mut self,
        id: &str,
        revision: u64,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !self.presence.ready()
            || self.picker.as_ref().is_none_or(|p| {
                p.mode != Mode::ManageMachines
                    || p.request != self.browser_request
                    || p.removal.is_some()
                    || p.edit.is_some()
            })
        {
            return;
        }
        let Some(registry) = &self.browser_state.machines else {
            return;
        };
        if !registry.available || registry.pending || registry.revision != revision {
            return;
        }
        let Some(profile) = registry.machines.iter().find(|p| p.id == id).cloned() else {
            return;
        };
        if let Some(picker) = &mut self.picker {
            picker.removal = Some(Confirmation {
                identity: std::rc::Rc::new(()),
                request: self.browser_request,
                revision,
                profile,
                submitted: false,
                confirm_focus: cx.focus_handle(),
                cancel_focus: cx.focus_handle(),
            });
            picker.error = None;
        }
        self.terminal_focus.focus(window, cx);
        cx.notify();
    }
    pub(super) fn confirm_machine_removal_identity(
        &mut self,
        identity: &std::rc::Rc<()>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.machine_removal_identity_current(identity) {
            self.confirm_machine_removal(window, cx);
        }
    }
    pub(super) fn machine_removal_identity_current(&self, identity: &std::rc::Rc<()>) -> bool {
        self.picker.as_ref().is_some_and(|p| {
            p.mode == Mode::ManageMachines
                && p.request == self.browser_request
                && p.removal.as_ref().is_some_and(|c| {
                    c.request == self.browser_request && std::rc::Rc::ptr_eq(&c.identity, identity)
                })
        })
    }
    pub(super) fn machine_removal_key(
        &mut self,
        event: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(captured) = self.picker.as_ref().and_then(|p| p.removal.as_ref()) else {
            return;
        };
        let footer_focused =
            captured.confirm_focus.is_focused(window) || captured.cancel_focus.is_focused(window);
        match event.keystroke.key.as_str() {
            "escape" => self.close_picker(window, cx),
            // GPUI activates focused buttons on key-up through their captured identity.
            "enter" | "space" if footer_focused => return,
            "enter" => self.confirm_machine_removal(window, cx),
            "tab" => {
                let mut order = Vec::with_capacity(2);
                if !captured.submitted {
                    order.push(captured.confirm_focus.clone());
                }
                order.push(captured.cancel_focus.clone());
                let current = order.iter().position(|focus| focus.is_focused(window));
                let next = match (current, event.keystroke.modifiers.shift) {
                    (Some(index), true) => (index + order.len() - 1) % order.len(),
                    (Some(index), false) => (index + 1) % order.len(),
                    (None, true) => order.len() - 1,
                    (None, false) => 0,
                };
                order[next].focus(window, cx);
            }
            _ => {}
        }
        cx.stop_propagation();
        window.prevent_default();
    }
    pub(super) fn confirm_machine_removal(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(picker) = &mut self.picker else {
            return;
        };
        let Some(captured) = &mut picker.removal else {
            return;
        };
        if picker.mode != Mode::ManageMachines
            || picker.request != self.browser_request
            || captured.request != self.browser_request
            || captured.submitted
            || !self.presence.ready()
        {
            return;
        }
        let valid = self
            .browser_state
            .machines
            .as_ref()
            .is_some_and(|registry| {
                registry.available
                    && !registry.pending
                    && registry.revision == captured.revision
                    && registry.machines.iter().any(|p| {
                        p.id == captured.profile.id
                            && p.label == captured.profile.label
                            && p.ssh_target == captured.profile.ssh_target
                            && p.enabled == captured.profile.enabled
                            && p.expected_environment_id == captured.profile.expected_environment_id
                    })
            });
        if !valid {
            picker.error = Some("Machine changed — cancel and reopen management.");
            cx.notify();
            return;
        }
        let command = browser::Command::Machines {
            request: captured.request,
            operation: browser::machines::Operation::Mutate {
                revision: captured.revision,
                change: browser::machines::Change::Remove {
                    id: captured.profile.id.clone(),
                },
            },
        };
        if self
            .browser_commands
            .as_ref()
            .is_some_and(|sender| sender.try_send(command).is_ok())
        {
            captured.submitted = true;
            if captured.confirm_focus.is_focused(window) {
                captured.cancel_focus.focus(window, cx);
            }
            picker.error = None;
        } else {
            picker.error = Some("Machine change queue unavailable — try again");
        }
        cx.notify();
    }
    pub(super) fn machine_removal_dialog(&self, cx: &mut Context<Self>) -> AnyElement {
        let Some(picker) = &self.picker else {
            return div().into_any_element();
        };
        let Some(captured) = &picker.removal else {
            return div().into_any_element();
        };
        let confirm_identity = captured.identity.clone();
        let cancel_identity = captured.identity.clone();
        let theme = self.theme();
        let registry = self.browser_state.machines.as_ref();
        let (removed, status) = captured.feedback(registry);
        super::super::design::dialog_overlay("machine-remove-overlay", &theme)
            .child(
                bezel_ui::popover::dialog_card(&super::super::design::palette(&theme))
                    .id("machine-remove-dialog")
                    .w(px(480.))
                    .max_w_full()
                    .flex()
                    .flex_col()
                    .gap_3()
                    .child(bezel_ui::popover::dialog_title(
                        &super::super::design::palette(&theme),
                        "Remove saved machine",
                    ))
                    .child(
                        div()
                            .min_w_0()
                            .truncate()
                            .child(captured.profile.label.clone()),
                    )
                    .child(
                        div()
                            .min_w_0()
                            .truncate()
                            .child(captured.profile.ssh_target.clone()),
                    )
                    .child(
                        if captured.submitted && !removed && registry.is_none_or(|r| !r.pending) {
                            super::super::design::palette(&theme)
                                .warning_strip(status)
                                .mt_0()
                                .px_2()
                                .py_1()
                                .min_w_0()
                                .w_full()
                        } else {
                            div().child(status)
                        },
                    )
                    .children(picker.error.map(|error| {
                        super::super::design::palette(&theme)
                            .error_strip(error)
                            .mt_0()
                            .px_2()
                            .py_1()
                            .min_w_0()
                            .w_full()
                    }))
                    .children(registry.and_then(|r| {
                        // Preserve message precedence; informational registry messages
                        // are not failures just because they share this feedback slot.
                        r.message
                            .as_ref()
                            .map(|message| div().child(message.clone()))
                            .or_else(|| {
                                r.error.as_ref().map(|error| {
                                    super::super::design::palette(&theme)
                                        .error_strip(error.clone())
                                        .mt_0()
                                        .px_2()
                                        .py_1()
                                        .min_w_0()
                                        .w_full()
                                })
                            })
                    }))
                    .when(!captured.submitted, |d| {
                        d.child(
                            controls::action_button(
                                "machine-remove-confirm",
                                Some("Remove saved connection"),
                                "Remove saved connection",
                                Icon::Trash,
                                ButtonStyle::Destructive,
                                &theme,
                            )
                            .track_focus(&captured.confirm_focus)
                            .tab_index(0)
                            .focus_visible({
                                let theme = theme.clone();
                                move |style| {
                                    style.border_color(super::super::design::palette(&theme).ring)
                                }
                            })
                            .on_click(cx.listener(
                                move |view, _, window, cx| {
                                    view.confirm_machine_removal_identity(
                                        &confirm_identity,
                                        window,
                                        cx,
                                    );
                                },
                            )),
                        )
                    })
                    .child(
                        controls::action_button(
                            "machine-remove-cancel",
                            Some(if removed { "Done" } else { "Cancel" }),
                            "Close dialog",
                            Icon::Close,
                            ButtonStyle::Quiet,
                            &theme,
                        )
                        .track_focus(&captured.cancel_focus)
                        .tab_index(0)
                        .focus_visible({
                            let theme = theme.clone();
                            move |style| {
                                style.border_color(super::super::design::palette(&theme).ring)
                            }
                        })
                        .on_click(cx.listener(
                            move |view, _, window, cx| {
                                if view.machine_removal_identity_current(&cancel_identity) {
                                    view.close_picker(window, cx);
                                }
                            },
                        )),
                    ),
            )
            .into_any_element()
    }
}

#[cfg(test)]
#[path = "tests/machine_remove_focus.rs"]
mod focus_tests;
