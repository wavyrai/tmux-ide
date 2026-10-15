//! Machine connection form shares picker focus, IME and terminal-input exclusion.
use super::super::controls::{self, ButtonStyle, Icon};
use super::{Mode, Selection, SnapshotView};
use gpui::{prelude::*, *};

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
        let theme = self.theme();
        Some(div().id("machine-dialog-overlay").absolute().inset_0().size_full()
            .flex().items_center().justify_center().bg(rgba(0x00000088))
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .child(div().id("machine-dialog").w(px(440.)).max_w_full().p_4().rounded(px(8.))
                .bg(rgb(theme.surface)).border_1().border_color(controls::separator(&theme))
                .flex().flex_col().gap_3()
                .child(div().text_lg().font_weight(FontWeight::SEMIBOLD).child("Add machine"))
                .child(div().text_color(rgb(theme.muted)).child("Use an existing SSH alias or user@host. The remote machine must run tmux-ide --headless. SSH keys and host trust use your SSH configuration. This saves the machine locally; if saving fails, the connection is marked temporary."))
                .child(picker.search.clone())
                .children(picker.error.map(|error| div().child(error)))
                .child(div().flex().justify_end().gap_2()
                    .child(controls::action_button("machine-cancel", Some("Cancel"), "Cancel", Icon::Close, ButtonStyle::Quiet, &theme)
                        .on_click(cx.listener(|view, _, window, cx| view.close_picker(window, cx))))
                    .child(controls::action_button("machine-connect", Some("Save and connect"), "Save and connect", Icon::Plus, ButtonStyle::Primary, &theme)
                        .on_click(cx.listener(|view, _, window, cx| view.submit_machine(window, cx))))))
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
