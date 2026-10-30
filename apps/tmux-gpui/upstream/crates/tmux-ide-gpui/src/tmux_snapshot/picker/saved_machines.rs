use super::super::controls::{self, ButtonStyle, Icon};
use super::{Action, Mode, Row, SnapshotView, Target, browser};
use gpui::{prelude::*, *};

pub(super) fn rows(state: &browser::State, query: &str) -> Vec<Row> {
    let query = query.chars().take(256).collect::<String>().to_lowercase();
    let mut rows = vec![
        Row {
            target: Target::Command(Action::LocalMachine),
            label: "Local machine".into(),
        },
        Row {
            target: Target::Command(Action::AddMachine),
            label: "Connect to another machine…".into(),
        },
    ];
    if let Some(registry) = &state.machines {
        rows.extend(registry.machines.iter().map(|profile| Row {
            target: Target::Machine {
                id: profile.id.clone(),
                revision: registry.revision,
            },
            label: format!(
                "{} · {}{}",
                profile.label,
                profile.ssh_target,
                if !registry.available {
                    " · unavailable"
                } else if !profile.enabled {
                    " · disabled"
                } else {
                    ""
                }
            ),
        }));
    }
    rows.retain(|row| {
        query
            .split_whitespace()
            .all(|term| row.label.to_lowercase().contains(term))
    });
    rows
}

pub(super) fn management_rows(state: &browser::State, query: &str) -> Vec<Row> {
    let query = query.chars().take(256).collect::<String>().to_lowercase();
    state.machines.as_ref().map_or_else(Vec::new, |registry| {
        registry
            .machines
            .iter()
            .flat_map(|profile| {
                [
                    Row {
                        target: Target::MachineToggle {
                            id: profile.id.clone(),
                            revision: registry.revision,
                            enabled: !profile.enabled,
                        },
                        label: format!(
                            "{} {} · {}",
                            if profile.enabled { "Disable" } else { "Enable" },
                            profile.label,
                            profile.ssh_target
                        ),
                    },
                    Row {
                        target: Target::MachineRemove {
                            id: profile.id.clone(),
                            revision: registry.revision,
                        },
                        label: format!("Remove {} · {}", profile.label, profile.ssh_target),
                    },
                    Row {
                        target: Target::MachineEdit {
                            id: profile.id.clone(),
                            revision: registry.revision,
                        },
                        label: format!("Edit {} · {}", profile.label, profile.ssh_target),
                    },
                ]
            })
            .filter(|row| {
                query
                    .split_whitespace()
                    .all(|term| row.label.to_lowercase().contains(term))
            })
            .collect()
    })
}

impl SnapshotView {
    pub(super) fn open_machine_management(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.open_machine_list(Mode::ManageMachines, window, cx);
    }
    pub(super) fn open_saved_machines(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.open_machine_list(Mode::SavedMachines, window, cx);
    }
    fn open_machine_list(&mut self, mode: Mode, window: &mut Window, cx: &mut Context<Self>) {
        self.open_picker_mode(mode, window, cx);
        if let Some(sender) = &self.browser_commands
            && sender
                .try_send(browser::Command::Machines {
                    request: self.browser_request,
                    operation: browser::machines::Operation::Read,
                })
                .is_err()
            && let Some(picker) = &mut self.picker
        {
            picker.error = Some("Machine list unavailable — close and try again");
        }
        cx.notify();
    }

    pub(super) fn saved_machines_dialog(&self, cx: &mut Context<Self>) -> AnyElement {
        if self.picker.as_ref().is_some_and(|p| p.edit.is_some()) {
            return self.machine_edit_dialog(cx);
        }
        if self.picker.as_ref().is_some_and(|p| p.removal.is_some()) {
            return self.machine_removal_dialog(cx);
        }
        let theme = self.theme();
        let managing = self
            .picker
            .as_ref()
            .is_some_and(|p| p.mode == Mode::ManageMachines);
        let message = match &self.browser_state.machines {
            None => "Loading saved machines…".to_owned(),
            Some(registry) => registry
                .message
                .as_ref()
                .or(registry.error.as_ref())
                .cloned()
                .unwrap_or_else(|| {
                    if registry.pending { return "Saving machine change…".into(); }
                    if managing && !registry.machines.is_empty() { return "Edit, enable, disable or remove a saved connection. Remote sessions keep running.".into(); }
                    if registry.machines.is_empty() {
                        "No saved machines yet. Connect to an SSH machine to get started.".into()
                    } else {
                        "Choose a saved machine or return to Local.".into()
                    }
                }),
        };
        super::super::design::dialog_overlay("saved-machines-overlay", &theme)
            .child(
                bezel_ui::popover::dialog_card(&super::super::design::palette(&theme))
                    .id("saved-machines-dialog")
                    .w(px(520.))
                    .max_w_full()
                    .h(px(420.))
                    .max_h_full()
                    .flex()
                    .flex_col()
                    .gap_2()
                    .overflow_hidden()
                    .child(
                        div()
                            .text_lg()
                            .font_weight(FontWeight::SEMIBOLD)
                            .child(if managing {
                                "Manage machines"
                            } else {
                                "Machines"
                            }),
                    )
                    .child(
                        bezel_ui::popover::dialog_body(
                            &super::super::design::palette(&theme),
                            message,
                        )
                        .text_color(super::super::design::dialog_muted(&theme)),
                    )
                    .child(self.picker_render(cx))
                    .child(
                        div().flex().justify_end().child(
                            controls::action_button(
                                "saved-machines-cancel",
                                Some("Cancel"),
                                "Close dialog",
                                Icon::Close,
                                ButtonStyle::Quiet,
                                &theme,
                            )
                            .on_click(
                                cx.listener(|view, _, window, cx| view.close_picker(window, cx)),
                            ),
                        ),
                    ),
            )
            .into_any_element()
    }
}
