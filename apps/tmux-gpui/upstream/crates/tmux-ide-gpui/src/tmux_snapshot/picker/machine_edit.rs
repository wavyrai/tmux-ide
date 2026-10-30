//! Local-registry form. Identity and environment pin are never editable fields.
use super::super::controls::{self, ButtonStyle, Icon};
use super::*;
use bezel_ui::widgets::Status;
pub(super) struct Form {
    pub(super) identity: std::rc::Rc<()>,
    request: u64,
    revision: u64,
    original: browser::machines::Profile,
    pub(super) label: Entity<SearchInput>,
    pub(super) target: Entity<SearchInput>,
    submitted: Option<(String, String)>,
    save_focus: FocusHandle,
    cancel_focus: FocusHandle,
}
fn same_profile(a: &browser::machines::Profile, b: &browser::machines::Profile) -> bool {
    a.id == b.id
        && a.label == b.label
        && a.ssh_target == b.ssh_target
        && a.enabled == b.enabled
        && a.expected_environment_id == b.expected_environment_id
}
impl SnapshotView {
    pub(super) fn begin_machine_edit(
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
                    || p.edit.is_some()
                    || p.removal.is_some()
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
        let Some(original) = registry.machines.iter().find(|p| p.id == id).cloned() else {
            return;
        };
        let theme = self.theme();
        let label = cx.new(|cx| {
            let mut input = SearchInput::new(cx).with_max_bytes(320);
            input.set_placeholder("Machine label", cx);
            input.set_appearance(crate::config::Config::default().ui, theme.clone(), cx);
            input.set_text_selected(&original.label, cx);
            input
        });
        let target = cx.new(|cx| {
            let mut input = SearchInput::new(cx).with_max_bytes(255);
            input.set_placeholder("SSH alias or user@host", cx);
            input.set_appearance(crate::config::Config::default().ui, theme, cx);
            input.set_text_selected(&original.ssh_target, cx);
            input
        });
        label.read(cx).focus.clone().focus(window, cx);
        if let Some(picker) = &mut self.picker {
            picker.edit = Some(Form {
                identity: std::rc::Rc::new(()),
                request: self.browser_request,
                revision,
                original,
                label,
                target,
                submitted: None,
                save_focus: cx.focus_handle(),
                cancel_focus: cx.focus_handle(),
            });
            picker.error = None;
        }
        cx.notify();
    }
    pub(super) fn machine_edit_composing(&self, cx: &App) -> bool {
        self.picker
            .as_ref()
            .and_then(|p| p.edit.as_ref())
            .is_some_and(|f| f.label.read(cx).is_composing() || f.target.read(cx).is_composing())
    }
    pub(super) fn machine_edit_identity_current(&self, identity: &std::rc::Rc<()>) -> bool {
        self.picker.as_ref().is_some_and(|p| {
            p.mode == Mode::ManageMachines
                && p.request == self.browser_request
                && p.edit.as_ref().is_some_and(|f| {
                    f.request == self.browser_request && std::rc::Rc::ptr_eq(&f.identity, identity)
                })
        })
    }
    pub(super) fn save_machine_edit_identity(
        &mut self,
        identity: &std::rc::Rc<()>,
        cx: &mut Context<Self>,
    ) {
        if self.machine_edit_identity_current(identity) {
            self.save_machine_edit(cx);
        }
    }
    pub(super) fn save_machine_edit(&mut self, cx: &mut Context<Self>) {
        if self.machine_edit_composing(cx) {
            return;
        }
        let Some(picker) = &mut self.picker else {
            return;
        };
        let Some(form) = &mut picker.edit else {
            return;
        };
        if picker.mode != Mode::ManageMachines
            || picker.request != self.browser_request
            || form.request != self.browser_request
            || !self.presence.ready()
            || form.submitted.is_some()
        {
            return;
        }
        if !self.browser_state.machines.as_ref().is_some_and(|r| {
            r.available
                && !r.pending
                && r.revision == form.revision
                && r.machines.iter().any(|p| same_profile(p, &form.original))
        }) {
            picker.error = Some("Machine changed — cancel and reopen management.");
            cx.notify();
            return;
        }
        let label = form.label.read(cx).text().trim().to_owned();
        let target = machine::target(form.target.read(cx).text());
        if label.is_empty()
            || label.encode_utf16().count() > 80
            || label.chars().any(char::is_control)
            || target.is_none()
        {
            picker.error =
                Some("Use a label of 1–80 characters and a valid SSH alias or user@host.");
            cx.notify();
            return;
        }
        let Some(target) = target else {
            return;
        };
        if label == form.original.label && target == form.original.ssh_target {
            picker.error = Some("No changes to save.");
            cx.notify();
            return;
        }
        let command = browser::Command::Machines {
            request: form.request,
            operation: browser::machines::Operation::Mutate {
                revision: form.revision,
                change: browser::machines::Change::Edit {
                    id: form.original.id.clone(),
                    patch: browser::machines::EditPatch {
                        label: label.clone(),
                        ssh_target: target.clone(),
                    },
                },
            },
        };
        if self
            .browser_commands
            .as_ref()
            .is_some_and(|sender| sender.try_send(command).is_ok())
        {
            form.submitted = Some((label, target));
            picker.error = None;
        } else {
            picker.error = Some("Machine change queue unavailable — try again");
        }
        cx.notify();
    }
    pub(super) fn machine_edit_key(
        &mut self,
        event: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        let Some(form) = self.picker.as_ref().and_then(|p| p.edit.as_ref()) else {
            return false;
        };
        if self.machine_edit_composing(cx) {
            return true;
        }
        let footer_focused =
            form.save_focus.is_focused(window) || form.cancel_focus.is_focused(window);
        match event.keystroke.key.as_str() {
            "escape" => self.close_picker(window, cx),
            // Focused buttons activate on key-up through their captured identity.
            // The picker owner returns before any terminal/row key handler runs.
            "enter" | "space" if footer_focused => return false,
            "enter" => self.save_machine_edit(cx),
            "tab" => {
                let mut order = vec![
                    form.label.read(cx).focus.clone(),
                    form.target.read(cx).focus.clone(),
                ];
                if form.submitted.is_none() {
                    order.push(form.save_focus.clone());
                }
                order.push(form.cancel_focus.clone());
                let current = order.iter().position(|focus| focus.is_focused(window));
                let next = match (current, event.keystroke.modifiers.shift) {
                    (Some(index), true) => (index + order.len() - 1) % order.len(),
                    (Some(index), false) => (index + 1) % order.len(),
                    (None, true) => order.len() - 1,
                    (None, false) => 0,
                };
                order[next].focus(window, cx);
            }
            _ => return false,
        }
        cx.stop_propagation();
        window.prevent_default();
        true
    }
    pub(super) fn machine_edit_dialog(&self, cx: &mut Context<Self>) -> AnyElement {
        let Some(picker) = &self.picker else {
            return div().into_any_element();
        };
        let Some(form) = &picker.edit else {
            return div().into_any_element();
        };
        let theme = self.theme();
        let save_identity = form.identity.clone();
        let cancel_identity = form.identity.clone();
        let registry = self.browser_state.machines.as_ref();
        let saved = form.submitted.as_ref().is_some_and(|(label, target)| {
            registry.is_some_and(|r| {
                r.available
                    && !r.pending
                    && r.revision > form.revision
                    && r.error.is_none()
                    && r.message.is_none()
                    && r.machines.iter().any(|p| {
                        p.id == form.original.id
                            && &p.label == label
                            && &p.ssh_target == target
                            && p.expected_environment_id == form.original.expected_environment_id
                            && p.enabled == form.original.enabled
                    })
            })
        });
        let status = if saved {
            "Saved machine updated."
        } else if form.submitted.is_some() {
            "Save submitted — waiting for saved machines. Cancel and refresh if unconfirmed."
        } else {
            "Changing the SSH target disconnects this app's existing route. Remote sessions keep running. The saved identity pin is preserved."
        };
        super::super::design::dialog_overlay("machine-edit-overlay", &theme)
            .child(
                bezel_ui::popover::dialog_card(&super::super::design::palette(&theme))
                    .id("machine-edit-dialog")
                    .w(px(520.))
                    .max_w_full()
                    .max_h_full()
                    .overflow_y_scroll()
                    .debug_selector(|| "machine-edit-dialog".into())
                    .flex()
                    .flex_col()
                    .gap_3()
                    .child(bezel_ui::popover::dialog_title(
                        &super::super::design::palette(&theme),
                        "Edit saved machine",
                    ))
                    .child("Label")
                    .child(form.label.clone())
                    .child("SSH target")
                    .child(form.target.clone())
                    .child(
                        div()
                            .debug_selector(move || {
                                if saved {
                                    "machine-edit-saved".into()
                                } else {
                                    "machine-edit-unconfirmed".into()
                                }
                            })
                            .child(status),
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
                    .when(form.submitted.is_none(), |d| {
                        d.child(
                            controls::action_button(
                                "machine-edit-save",
                                Some("Save changes"),
                                "Save changes",
                                Icon::Check,
                                ButtonStyle::Primary,
                                &theme,
                            )
                            .track_focus(&form.save_focus)
                            .tab_index(0)
                            .focus_visible({
                                let theme = theme.clone();
                                move |style| {
                                    style.border_color(super::super::design::palette(&theme).ring)
                                }
                            })
                            .on_click(cx.listener(
                                move |view, _, window, cx| {
                                    view.save_machine_edit_identity(&save_identity, cx);
                                    if let Some(form) =
                                        view.picker.as_ref().and_then(|p| p.edit.as_ref())
                                        && form.submitted.is_some()
                                        && form.save_focus.is_focused(window)
                                    {
                                        form.cancel_focus.focus(window, cx);
                                    }
                                },
                            )),
                        )
                    })
                    .child(
                        controls::action_button(
                            "machine-edit-cancel",
                            Some(if saved { "Done" } else { "Cancel" }),
                            "Close dialog",
                            Icon::Close,
                            ButtonStyle::Quiet,
                            &theme,
                        )
                        .track_focus(&form.cancel_focus)
                        .tab_index(0)
                        .focus_visible({
                            let theme = theme.clone();
                            move |style| {
                                style.border_color(super::super::design::palette(&theme).ring)
                            }
                        })
                        .on_click(cx.listener(
                            move |view, _, window, cx| {
                                if view.machine_edit_identity_current(&cancel_identity) {
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
#[path = "tests/machine_edit_focus.rs"]
mod focus_tests;
