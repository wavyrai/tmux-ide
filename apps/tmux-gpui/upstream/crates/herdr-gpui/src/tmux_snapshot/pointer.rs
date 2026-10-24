//! Display-mode routing only. The bridge rechecks canonical modes and owns delivery.
use super::browser_ui::Selection;
use super::{
    SnapshotView, browser,
    decode::{MouseProtocol, PointerModes},
    hit_regions::Region,
};
use gpui::*;
use serde::Serialize;
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum Action {
    Down,
    Drag,
    Move,
    Up,
}
#[derive(Debug, PartialEq, Serialize)]
#[serde(tag = "action", rename_all = "lowercase")]
pub(super) enum Command {
    Cancel {
        gesture: u64,
    },
    #[serde(untagged)]
    Event {
        action: Action,
        gesture: u64,
        row: u16,
        col: u16,
        button: Option<u8>,
        shift: bool,
        alt: bool,
        control: bool,
        protocol: MouseProtocol,
        encoding: super::decode::MouseEncoding,
        cols: u16,
        rows: u16,
    },
}
#[derive(Clone, PartialEq)]
struct Lease {
    request: u64,
    pane: String,
    region: Region,
    modes: PointerModes,
    presence: u64,
    resize: Option<String>,
    bounds: Bounds<Pixels>,
    cell_width: f32,
    cell_height: f32,
}
#[derive(Default)]
pub(super) struct Owner {
    serial: u64,
    held: Option<(u64, u8, Lease)>,
}
fn button(b: MouseButton) -> Option<u8> {
    match b {
        MouseButton::Left => Some(0),
        MouseButton::Middle => Some(1),
        MouseButton::Right => Some(2),
        _ => None,
    }
}
impl SnapshotView {
    fn pointer_lease(&self) -> Option<Lease> {
        if !self.terminal_input_ready()
            || self.browser_state.history_offset != 0
            || self.browser_request != self.browser_state.request
        {
            return None;
        }
        let pane = self.browser_state.selected_pane.clone()?;
        let content = self.browser_state.copy_region.as_ref()?;
        let full = self
            .browser_state
            .regions
            .iter()
            .find(|region| region.id == pane)?;
        if content.id != pane
            || content.left < full.left
            || content.top < full.top
            || u32::from(content.left) + u32::from(content.width)
                > u32::from(full.left) + u32::from(full.width)
            || u32::from(content.top) + u32::from(content.height)
                > u32::from(full.top) + u32::from(full.height)
        {
            return None;
        }
        let region = Region {
            id: pane.clone(),
            left: content.left,
            top: content.top,
            width: content.width,
            height: content.height,
        };
        Some(Lease {
            request: self.browser_request,
            pane,
            region,
            modes: self.browser_state.pointer_modes?,
            presence: self.browser_state.presence_revision,
            resize: self.browser_state.resize_token.clone(),
            bounds: self.input_geometry?.0,
            cell_width: self.input_cell_width?,
            cell_height: self.terminal_height(),
        })
    }
    pub(super) fn cancel_pointer(&mut self) {
        if let Some((gesture, _, lease)) = self.pointer.held.take()
            && let Some(sender) = &self.browser_commands
        {
            let _ = sender.try_send(browser::Command::Input {
                input_target: None,
                request: lease.request,
                id: lease.pane,
                input: super::keys::Input::Mouse(Command::Cancel { gesture }),
            });
        }
    }
    pub(super) fn observe_pointer(&mut self) {
        if self
            .pointer
            .held
            .as_ref()
            .is_some_and(|(_, _, lease)| Some(lease) != self.pointer_lease().as_ref())
        {
            self.cancel_pointer();
        }
    }
    pub(super) fn pointer_event(
        &mut self,
        action: Action,
        position: Point<Pixels>,
        pressed: Option<MouseButton>,
        modifiers: Modifiers,
        cx: &mut Context<Self>,
    ) -> bool {
        self.observe_pointer();
        if action == Action::Move && self.pointer.held.is_some() {
            self.cancel_pointer();
            return true;
        }
        if modifiers.shift || modifiers.platform || self.divider.is_some() {
            self.cancel_pointer();
            return false;
        }
        let Some(lease) = self.pointer_lease() else {
            self.cancel_pointer();
            return false;
        };
        if matches!(action, Action::Down | Action::Move)
            && !super::hit_regions::is_painted(self.frame.as_ref(), self.painted_frame.as_ref())
        {
            self.cancel_pointer();
            return false;
        }
        let point = position - lease.bounds.origin;
        let col = (f32::from(point.x) / lease.cell_width).floor();
        let row = (f32::from(point.y) / lease.cell_height).floor();
        if !lease.bounds.contains(&position)
            || col < f32::from(lease.region.left)
            || row < f32::from(lease.region.top)
            || col >= f32::from(lease.region.left + lease.region.width)
            || row >= f32::from(lease.region.top + lease.region.height)
        {
            self.cancel_pointer();
            return false;
        }
        let btn = pressed.and_then(button);
        let gesture = match action {
            Action::Down => {
                let Some(btn) = btn else {
                    return false;
                };
                self.cancel_pointer();
                self.pointer.serial = self.pointer.serial.saturating_add(1);
                self.input_interrupted = false;
                self.clear_selection(cx);
                self.pointer.held = Some((self.pointer.serial, btn, lease.clone()));
                self.pointer.serial
            }
            Action::Move => {
                if self.pointer.held.is_some()
                    || lease.modes.protocol != MouseProtocol::Any
                    || self.input_interrupted
                {
                    return false;
                }
                self.pointer.serial = self.pointer.serial.saturating_add(1);
                self.pointer.serial
            }
            Action::Drag | Action::Up => {
                let Some((gesture, held, _)) = self.pointer.held.as_ref() else {
                    return false;
                };
                if Some(*held) != btn {
                    self.cancel_pointer();
                    return false;
                }
                *gesture
            }
        };
        if !self.offer_terminal_input(cx) {
            self.cancel_pointer();
            return true;
        }
        self.discard_composition(cx);
        self.queue_input(
            super::keys::Input::Mouse(Command::Event {
                action,
                gesture,
                row: row as u16 - lease.region.top,
                col: col as u16 - lease.region.left,
                button: btn,
                shift: false,
                alt: modifiers.alt,
                control: modifiers.control,
                protocol: lease.modes.protocol,
                encoding: lease.modes.encoding,
                cols: lease.region.width,
                rows: lease.region.height,
            }),
            cx,
        );
        if !self.browser_state.input_ready {
            self.cancel_pointer();
        } else if action == Action::Up {
            self.pointer.held = None;
        }
        cx.stop_propagation();
        true
    }
}

impl SnapshotView {
    pub(super) fn terminal_click(
        &mut self,
        event: &MouseDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.cancel_tab_focus_restore();
        self.cancel_tab_selection_restore();
        if self.browser_state.retained_preview || self.resize_gesture.busy() {
            self.cancel_pointer();
            self.interrupt_input(cx);
            return;
        }
        if self.picker.is_some() || self.pane_actions.is_some() || self.new_session.is_some() {
            self.cancel_pointer();
            return;
        }
        if super::terminal_links::gesture(event) {
            self.cancel_pointer();
            if let Some(url) = self.terminal_web_link(event.position) {
                cx.open_url(&url);
            }
            cx.stop_propagation();
            return;
        }
        if event.button == MouseButton::Left && self.begin_divider(event.position, cx) {
            self.cancel_pointer();
            return;
        }
        if self.pointer_event(
            Action::Down,
            event.position,
            Some(event.button),
            event.modifiers,
            cx,
        ) {
            self.terminal_focus.focus(window, cx);
            return;
        }
        if event.button != MouseButton::Left {
            return;
        }
        if self.selection.is_some() {
            self.clear_selection(cx);
        }
        let input_ready = self.terminal_input_ready();

        if !input_ready {
            // A click is not dropped input. Only a verified foreground target may
            // hold later, never-dispatched typing until the new lease arrives.
            if !self.focus_click_matches_selected(event.position) {
                // Refused navigation must not leave the previously selected pane armed.
                self.interrupt_input(cx);
            } else if event.modifiers == Modifiers::default() {
                self.capture_focus_reclaim(event.position, cx);
            }
            self.terminal_focus.focus(window, cx);
            if self.focus_reclaim_ready() || !self.historical_selection_ready() {
                return;
            }
        }
        if !super::hit_regions::is_painted(self.frame.as_ref(), self.painted_frame.as_ref()) {
            // A content-only publication cannot invalidate the selected focus
            // target. Copying and application mouse gestures still need exact paint.
            if input_ready
                && event.modifiers == Modifiers::default()
                && self.focus_click_matches_selected(event.position)
            {
                self.input_interrupted = false;
                self.terminal_focus.focus(window, cx);
                return;
            }
            // An unresolved target change must not leave the old pane armed for typing.
            self.interrupt_input(cx);
            return;
        }
        let (Some((bounds, _)), Some(width)) = (self.input_geometry, self.input_cell_width) else {
            self.interrupt_input(cx);
            return;
        };
        if !bounds.contains(&event.position) {
            return;
        }
        let point = event.position - bounds.origin;
        let id = super::hit_regions::hit(
            &self.browser_state.regions,
            f32::from(point.x),
            f32::from(point.y),
            width,
            self.terminal_height(),
        )
        .map(str::to_owned);
        if let Some(id) = id {
            if self.browser_state.selected_pane.as_ref() != Some(&id) {
                if input_ready {
                    self.select(Selection::Pane(id), window, cx);
                }
            } else {
                // Copying history is local; it cannot re-arm terminal input.
                if input_ready {
                    self.input_interrupted = false;
                }
                self.discard_composition(cx);
                self.selection = super::selection::Capture::begin(
                    &self.browser_state,
                    f32::from(point.x) / width,
                    f32::from(point.y) / self.terminal_height(),
                );
                cx.notify();
            }
            self.terminal_focus.focus(window, cx);
        }
    }
    pub(super) fn clear_selection(&mut self, cx: &mut Context<Self>) {
        self.cancel_tab_selection_restore();
        if self.selection.take().is_some() {
            self.frame = self.browser_state.frame.clone();
            cx.notify();
        }
    }
    pub(super) fn terminal_drag(
        &mut self,
        event: &MouseMoveEvent,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.divider.is_some() {
            if event.pressed_button != Some(MouseButton::Left) {
                self.divider = None;
            } else {
                self.move_divider(event.position, false, cx);
            }
            cx.stop_propagation();
            return;
        }
        if self.pointer_event(
            if event.pressed_button.is_some() {
                Action::Drag
            } else {
                Action::Move
            },
            event.position,
            event.pressed_button,
            event.modifiers,
            cx,
        ) {
            return;
        }
        if event.pressed_button != Some(MouseButton::Left) {
            if let Some(selection) = &mut self.selection {
                selection.dragging = false;
            }
            return;
        }
        self.update_drag(event.position, cx);
    }
    fn update_drag(&mut self, position: Point<Pixels>, cx: &mut Context<Self>) {
        if self.browser_state.retained_preview {
            self.clear_selection(cx);
            return;
        }
        let height = self.terminal_height();
        let (Some(selection), Some((bounds, _)), Some(width)) = (
            &mut self.selection,
            self.input_geometry,
            self.input_cell_width,
        ) else {
            return;
        };
        if !selection.dragging {
            return;
        }
        let point = position - bounds.origin;
        if selection
            .update(f32::from(point.x) / width, f32::from(point.y) / height)
            .is_err()
        {
            self.clear_selection(cx);
        }
        cx.notify();
        cx.stop_propagation();
    }
    pub(super) fn terminal_release(
        &mut self,
        event: &MouseUpEvent,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.divider.is_some() {
            if event.button != MouseButton::Left {
                return;
            }
            self.move_divider(event.position, true, cx);
            cx.stop_propagation();
            return;
        }
        if self.pointer_event(
            Action::Up,
            event.position,
            Some(event.button),
            event.modifiers,
            cx,
        ) {
            return;
        }
        self.update_drag(event.position, cx);
        if let Some(selection) = &mut self.selection {
            selection.dragging = false;
        }
        if self
            .selection
            .as_ref()
            .is_some_and(|selection| selection.empty())
        {
            self.clear_selection(cx);
        }
        cx.notify();
    }
}
