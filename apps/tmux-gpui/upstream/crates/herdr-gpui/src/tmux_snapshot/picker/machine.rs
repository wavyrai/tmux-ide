//! Machine connection form shares picker focus, IME and terminal-input exclusion.
use super::super::controls::{self, ButtonStyle, Icon};
use super::{Mode, Selection, SnapshotView};
use bezel_ui::widgets::Status;
use gpui::{prelude::*, *};

pub(super) struct Form {
    identity: std::rc::Rc<()>,
    cancel_focus: FocusHandle,
    connect_focus: FocusHandle,
}
impl Form {
    pub(super) fn new(cx: &App) -> Self {
        Self {
            identity: std::rc::Rc::new(()),
            cancel_focus: cx.focus_handle(),
            connect_focus: cx.focus_handle(),
        }
    }
}

pub(super) fn target(value: &str) -> Option<String> {
    let value = value.trim();
    fn name(value: &str) -> bool {
        value
            .as_bytes()
            .first()
            .is_some_and(|b| b.is_ascii_alphanumeric() || *b == b'_')
            && value
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
    }
    if value.len() > 255 {
        return None;
    }
    let host = if let Some((user, host)) = value.split_once('@') {
        if !name(user) {
            return None;
        }
        host
    } else {
        value
    };
    let valid = if let Some(address) = host.strip_prefix('[').and_then(|v| v.strip_suffix(']')) {
        !address.is_empty() && address.bytes().all(|b| b.is_ascii_hexdigit() || b == b':')
    } else {
        name(host)
    };
    valid.then(|| value.to_owned())
}

impl SnapshotView {
    fn machine_identity_current(&self, identity: &std::rc::Rc<()>, cx: &App) -> bool {
        self.picker.as_ref().is_some_and(|p| {
            p.mode == Mode::Machine
                && p.request == self.browser_request
                && !p.search.read(cx).is_composing()
                && p.machine
                    .as_ref()
                    .is_some_and(|f| std::rc::Rc::ptr_eq(&f.identity, identity))
        })
    }
    pub(super) fn machine_key(
        &mut self,
        event: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(picker) = &self.picker else {
            return;
        };
        let Some(form) = &picker.machine else {
            return;
        };
        if picker.search.read(cx).is_composing() {
            return;
        }
        let footer_focused =
            form.cancel_focus.is_focused(window) || form.connect_focus.is_focused(window);
        match event.keystroke.key.as_str() {
            "escape" => self.close_picker(window, cx),
            // Focused buttons activate on key-up through their captured form identity.
            "enter" | "space" if footer_focused => return,
            "enter" => self.submit_machine(window, cx),
            "tab" => {
                let order = [
                    picker.search.read(cx).focus.clone(),
                    form.cancel_focus.clone(),
                    form.connect_focus.clone(),
                ];
                let current = order.iter().position(|focus| focus.is_focused(window));
                let next = match (current, event.keystroke.modifiers.shift) {
                    (Some(index), true) => (index + order.len() - 1) % order.len(),
                    (Some(index), false) => (index + 1) % order.len(),
                    (None, true) => order.len() - 1,
                    (None, false) => 0,
                };
                order[next].focus(window, cx);
            }
            _ => return,
        }
        cx.stop_propagation();
        window.prevent_default();
    }

    pub(super) fn submit_machine(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(picker) = &self.picker else {
            return;
        };
        if picker.mode != Mode::Machine
            || picker.request != self.browser_request
            || picker.search.read(cx).is_composing()
            || !self.presence.ready()
        {
            return;
        }
        let Some(target) = target(picker.search.read(cx).text()) else {
            if let Some(picker) = &mut self.picker {
                picker.error = Some(
                    "Enter an SSH alias or user@host. Configure ports and keys in SSH config.",
                );
            }
            cx.notify();
            return;
        };
        self.select(Selection::Machine(Some(target)), window, cx);
    }
    pub(in crate::tmux_snapshot) fn machine_dialog(
        &self,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        if self
            .picker
            .as_ref()
            .is_some_and(|picker| matches!(picker.mode, Mode::SavedMachines | Mode::ManageMachines))
        {
            return Some(self.saved_machines_dialog(cx));
        }
        let picker = self
            .picker
            .as_ref()
            .filter(|picker| picker.mode == Mode::Machine)?;
        let form = picker.machine.as_ref()?;
        let cancel_identity = form.identity.clone();
        let connect_identity = form.identity.clone();
        let theme = self.theme();
        Some(div().id("machine-dialog-overlay").absolute().inset_0().size_full()
            .flex().items_center().justify_center().bg(rgba(0x00000088))
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .child(bezel_ui::popover::dialog_card(&super::super::design::palette(&theme)).id("machine-dialog").w(px(440.)).max_w_full()
                .flex().flex_col().gap_3()
                .child(bezel_ui::popover::dialog_title(&super::super::design::palette(&theme), "Add machine"))
                .child(bezel_ui::popover::dialog_body(&super::super::design::palette(&theme), "Use an existing SSH alias or user@host. The remote machine must run tmux-ide --headless. SSH keys and host trust use your SSH configuration. This saves the machine locally; if saving fails, the connection is marked temporary."))
                .child(picker.search.clone())
                .children(picker.error.map(|error| super::super::design::palette(&theme).error_strip(error).mt_0().px_2().py_1().min_w_0().w_full()))
                .child(div().flex().justify_end().gap_2()
                    .child(controls::action_button("machine-cancel", Some("Cancel"), "Cancel", Icon::Close, ButtonStyle::Quiet, &theme)

                        .track_focus(&form.cancel_focus)
                        .tab_index(0)
                        .focus_visible({
                            let theme = theme.clone();
                            move |style| {
                                style.border_color(super::super::design::palette(&theme).ring)
                            }
                        })
                        .on_click(cx.listener(move |view, _, window, cx| {
                            if view.machine_identity_current(&cancel_identity, cx) {
                                view.close_picker(window, cx);
                            }
                        })))
                    .child(controls::action_button("machine-connect", Some("Save and connect"), "Save and connect", Icon::Plus, ButtonStyle::Primary, &theme)

                        .track_focus(&form.connect_focus)
                        .tab_index(0)
                        .focus_visible({
                            let theme = theme.clone();
                            move |style| {
                                style.border_color(super::super::design::palette(&theme).ring)
                            }
                        })
                        .on_click(cx.listener(move |view, _, window, cx| {
                            if view.machine_identity_current(&connect_identity, cx) {
                                view.submit_machine(window, cx);
                            }
                        })))))
            .into_any_element())
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn validates_the_shared_ssh_target_grammar() {
        for value in [
            "spark",
            "user@192.168.178.12",
            "[::1]",
            "a_b@host-name",
            " host ",
        ] {
            assert!(super::target(value).is_some());
        }
        for value in [
            "",
            "-host",
            "host:22",
            "a@@host",
            "user@-host",
            "a/b",
            "host\ncommand",
            "$(id)",
            "[]",
            "[zz]",
        ] {
            assert!(super::target(value).is_none());
        }
        assert!(super::target(&"a".repeat(256)).is_none());
    }
}

#[cfg(test)]
#[path = "tests/machine_focus.rs"]
mod focus_tests;
