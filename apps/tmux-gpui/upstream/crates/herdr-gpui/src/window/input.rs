//! Semantic input on its way to a pane or popup: keystrokes, paste, and wheel
//! deltas. Nothing here synthesizes terminal keys for an operation that has an
//! endpoint API method, and nothing is sent while a menu page holds input.

use super::HerdrWindow;
use crate::{
    connection::ConnectionBridge,
    terminal::{WheelAccumulator, key_input, pane_key_input, wheel_target},
};
use gpui::{Context, KeyDownEvent, KeyUpEvent, ScrollWheelEvent, Window};

impl HerdrWindow {
    pub(crate) fn open_terminal_link(
        &mut self,
        event: &gpui::ClickEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let pressed = self.pressed_terminal_link.take();
        let gpui::ClickEvent::Mouse(event) = event else {
            return;
        };
        if event.down.button != gpui::MouseButton::Left
            || event.down.click_count != 1
            || (event.up.position.x - event.down.position.x).abs() > gpui::px(4.)
            || (event.up.position.y - event.down.position.y).abs() > gpui::px(4.)
        {
            return;
        }
        let Some(pressed) = pressed else {
            return;
        };
        let in_tab = (self.config.open_links_in == crate::config::LinkTarget::BrowserTab)
            != event.down.modifiers.alt;
        if self.activate_terminal_link(
            &pressed,
            event.up.position,
            event.down.modifiers,
            in_tab,
            window,
            cx,
        ) {
            cx.stop_propagation();
        }
    }

    /// Whether the modifiers keep a press here from a mouse-reporting
    /// application. Shift keeps any gesture local; the platform link modifier
    /// (cmd on macOS, ctrl elsewhere) claims only a press on a link, so the
    /// application still receives it everywhere else.
    pub(crate) fn link_modifier_held(
        &self,
        position: gpui::Point<gpui::Pixels>,
        modifiers: gpui::Modifiers,
    ) -> bool {
        modifiers.shift
            || (modifiers.secondary()
                && (self.terminal_link_at(position).is_some()
                    || self.daemon_link_at(position).is_some()
                    || self.file_link_at(position).is_some()))
    }

    /// Whether a left click here would open a link, which the pointer shows.
    pub(crate) fn terminal_link_hovered(
        &self,
        position: gpui::Point<gpui::Pixels>,
        modifiers: gpui::Modifiers,
    ) -> bool {
        let web = (self.terminal_link_at(position).is_some()
            || self.daemon_link_at(position).is_some())
            && (modifiers.secondary()
                || modifiers.shift
                || self
                    .terminal_mouse_at(position)
                    .is_none_or(|hit| !hit.mouse_reporting));
        web || (modifiers.secondary() && self.file_link_at(position).is_some())
    }

    pub(crate) fn terminal_link_at(&self, position: gpui::Point<gpui::Pixels>) -> Option<String> {
        if self.menu.page.is_some()
            || !self.live.surface_ready()
            || !self.bounds.contains(&position)
        {
            return None;
        }
        crate::terminal::link_at(
            self.live.surface.as_deref()?,
            f32::from(position.x - self.bounds.origin.x),
            f32::from(position.y - self.bounds.origin.y),
            self.cell_width,
            self.config.terminal.line_height(),
        )
    }

    pub(crate) fn scroll_wheel(
        &mut self,
        event: &ScrollWheelEvent,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.shift_taps.cancel();
        if self.menu.page.is_some() || !self.input_ready() {
            return;
        }
        let (Some(handle), Some(snapshot), Some(surface)) = (
            &self.endpoints[self.selected_endpoint].connection.handle,
            &self.live.snapshot,
            &self.live.surface,
        ) else {
            return;
        };
        let x = (event.position.x - self.bounds.origin.x).to_f64() as f32;
        let y = (event.position.y - self.bounds.origin.y).to_f64() as f32;
        let cell_height = self.config.terminal.line_height();
        let Some(target) = wheel_target(surface, x, y, self.cell_width, cell_height) else {
            self.wheel = WheelAccumulator::default();
            return;
        };
        let steps = self
            .wheel
            .steps(&target, event, self.cell_width, cell_height);
        cx.stop_propagation();
        for input in target.wheel_events(steps, event.modifiers) {
            let result =
                ConnectionBridge::send_input(handle, &snapshot.boot_id, &target.target, input);
            if let Err(error) = result {
                self.local_error = Some(format!("Wheel input not sent: {error}"));
                cx.notify();
                return;
            }
        }
    }

    /// Cmd-V and Edit > Paste into the focused pane or popup.
    pub(crate) fn paste(&mut self, cx: &mut Context<Self>) {
        if self.copy_mode_active() {
            return;
        }
        // GPUI has no text-only Linux clipboard API. Preserve its native
        // ordinary paste (which needs no helper executable); explicit Ctrl-V
        // image acquisition still uses the bounded background reader.
        if self.accepts_clipboard_images() && !cfg!(target_os = "linux") {
            self.paste_native_clipboard(false, None, cx);
        } else if let Some(item) = cx.read_from_clipboard() {
            self.paste_terminal_clipboard(item, false, cx);
        }
    }

    pub(crate) fn key_down(
        &mut self,
        event: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        // A new press goes wherever this decides; only the pane branch at the
        // end holds it again for its release.
        self.held_keys.forget(&event.keystroke.key);
        // A keystroke bubbling out of the find field is the field's: an
        // unhandled one is still on its way to the field's IME.
        if self.find_focused(window, cx) {
            return;
        }
        // Copy mode owns the keyboard: its keys run and nothing else is typed.
        if self.copy_mode_active() {
            self.copy_mode_key(event, cx);
            if !event.keystroke.modifiers.platform {
                cx.stop_propagation();
                window.prevent_default();
            }
            return;
        }
        #[cfg(feature = "integration-test")]
        {
            self.input_probe.keys += 1;
        }
        let modifiers = event.keystroke.modifiers;
        let option_keys = if modifiers.alt {
            crate::input::held_option_keys()
        } else {
            crate::config::OptionKeys::LEFT
        };
        let alt_keys = self
            .config
            .option_as_alt
            .sends_alt(cx.keyboard_layout().id(), option_keys);
        // Cmd-C copies a selection that is still highlighted. Ctrl-C does too
        // only while Herdr's `copy_on_select` is off, as in Herdr, where the
        // highlight is waiting for that copy; a selection the release already
        // copied must not stop Ctrl-C from interrupting the pane.
        let copy = if modifiers.platform {
            !modifiers.control && !modifiers.shift
        } else {
            modifiers.control && (modifiers.shift || !self.copy_on_select())
        };
        if event.keystroke.key.eq_ignore_ascii_case("c")
            && copy
            && !modifiers.alt
            && self.copy_retained_selection(cx)
        {
            cx.stop_propagation();
            window.prevent_default();
            return;
        }
        self.clear_retained_selection(cx);
        if event.keystroke.key == "escape"
            && (self.cancel_workspace_drag(cx) | self.cancel_tab_drag(cx))
        {
            cx.stop_propagation();
            window.prevent_default();
        } else if (event.keystroke.modifiers.platform
            || (event.keystroke.modifiers.control && event.keystroke.modifiers.shift)
            || (event.keystroke.modifiers.shift && event.keystroke.key == "insert"))
            && (event.keystroke.key.eq_ignore_ascii_case("v") || event.keystroke.key == "insert")
        {
            self.paste(cx);
            cx.stop_propagation();
            window.prevent_default();
        } else if event.keystroke.key == "v"
            && event.keystroke.modifiers.control
            && !event.keystroke.modifiers.alt
            && !event.keystroke.modifiers.shift
            // Local agents read the shared clipboard themselves on Ctrl-V.
            && self.accepts_remote_images()
        {
            self.paste_native_clipboard(true, key_input(event, alt_keys), cx);
            cx.stop_propagation();
            window.prevent_default();
        } else if self.marked.is_empty()
            && let Some(input) = match self.keymap().pane_key(&event.keystroke) {
                Some(sent) => pane_key_input(event, sent),
                None => key_input(event, alt_keys),
            }
        {
            let input =
                self.held_keys
                    .press(&event.keystroke.key, input, self.live.keyboard_report_all);
            self.send(input, cx);
            cx.stop_propagation();
            window.prevent_default();
        }
    }

    /// Releases a key the pane received while Herdr reported that its focused
    /// pane wants every key event, as the TUI does by switching its outer
    /// terminal to report all keys. Text stays with the input handler, so
    /// only keys sent as key events are released.
    pub(crate) fn key_up(&mut self, event: &KeyUpEvent, _: &mut Window, cx: &mut Context<Self>) {
        let Some(release) = self.held_keys.release(&event.keystroke.key) else {
            return;
        };
        if self.live.keyboard_report_all && self.marked.is_empty() {
            self.send(release, cx);
            cx.stop_propagation();
        }
    }
}
