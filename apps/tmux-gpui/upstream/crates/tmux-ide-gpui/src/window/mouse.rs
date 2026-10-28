//! Application mouse gestures take precedence over local selection and links.
//! Shift keeps a gesture local; a forwarded drag stays with its pressed target.
//! A pane's right-click reaches the application only when Herdr routes it there.

use super::HerdrWindow;
use crate::{
    connection::ConnectionBridge,
    navigation::NavigationTarget,
    terminal::{InputTarget, Scrollbar, WheelTarget, splits, wheel_target},
};
use gpui::{
    Context, CursorStyle, Modifiers, MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent,
    Pixels, Point, Window,
};
use herdr_client::{
    Method,
    protocol::{ClientMouseButton, ClientMouseKind, PaneSurfaceSplit},
};
use serde_json::json;

pub(crate) struct Gesture {
    hit: WheelTarget,
    button: MouseButton,
    boot: String,
    epoch: u64,
    generation: u64,
}

/// A drag of a pane's native scrollbar. `grab` keeps the pointer's place on
/// the thumb; `want` is the latest offset not yet sent to the daemon.
pub(crate) struct ScrollbarDrag {
    pane: String,
    boot: String,
    grab: f32,
    held: bool,
    want: Option<u64>,
}

/// A drag of the border between panes. The split is kept as pressed: its
/// area, which the ratio divides, does not move with its own border. `grab`
/// keeps the pointer's place on the border; `want` is the latest ratio not yet
/// sent to the daemon.
pub(crate) struct SplitDrag {
    split: PaneSurfaceSplit,
    boot: String,
    tab: String,
    topology: u64,
    grab: f32,
    held: bool,
    want: Option<f32>,
    sent: Option<f32>,
}

fn button(button: MouseButton) -> Option<ClientMouseButton> {
    match button {
        MouseButton::Left => Some(ClientMouseButton::Left),
        MouseButton::Right => Some(ClientMouseButton::Right),
        MouseButton::Middle => Some(ClientMouseButton::Middle),
        _ => None,
    }
}

impl HerdrWindow {
    pub(crate) fn mouse_focus_pending(&self) -> bool {
        self.terminal_mouse.as_ref().is_some_and(|gesture| {
            matches!(&gesture.hit.target, InputTarget::Pane(id)
                if self.live.snapshot.as_ref().and_then(|snapshot| snapshot.focused_pane_id.as_ref()) != Some(id))
        })
    }

    /// Retire only an input already sent to this connection. This is cleanup,
    /// not new input: a menu or resize must not leave the application dragging.
    pub(crate) fn cancel_terminal_mouse(&mut self, cx: &mut Context<Self>) {
        let Some(gesture) = self.terminal_mouse.take() else {
            return;
        };
        if gesture.epoch != self.selection_epoch
            || gesture.generation != self.selected_generation
            || self
                .live
                .snapshot
                .as_ref()
                .is_none_or(|snapshot| snapshot.boot_id != gesture.boot)
        {
            return;
        }
        if let Some(handle) = &self.endpoints[self.selected_endpoint].connection.handle
            && let Some(button) = button(gesture.button)
            && let Err(error) = ConnectionBridge::send_input(
                handle,
                &gesture.boot,
                &gesture.hit.target,
                gesture
                    .hit
                    .mouse_event(ClientMouseKind::Up(button), Modifiers::default()),
            )
        {
            self.local_error = Some(format!("Mouse release not sent: {error}"));
            cx.notify();
        }
    }

    pub(crate) fn terminal_mouse_at(&self, position: Point<Pixels>) -> Option<WheelTarget> {
        if self.menu.page.is_some()
            || !self.live.surface_ready()
            || !self.bounds.contains(&position)
        {
            return None;
        }
        wheel_target(
            self.live.surface.as_deref()?,
            f32::from(position.x - self.bounds.origin.x),
            f32::from(position.y - self.bounds.origin.y),
            self.cell_width,
            self.config.terminal.line_height(),
        )
    }

    fn send_mouse(
        &mut self,
        hit: &WheelTarget,
        kind: ClientMouseKind,
        modifiers: Modifiers,
        cx: &mut Context<Self>,
    ) -> bool {
        if self.menu.page.is_some() || !self.input_ready() {
            return false;
        }
        let (Some(handle), Some(snapshot)) = (
            &self.endpoints[self.selected_endpoint].connection.handle,
            &self.live.snapshot,
        ) else {
            return false;
        };
        match ConnectionBridge::send_input(
            handle,
            &snapshot.boot_id,
            &hit.target,
            hit.mouse_event(kind, modifiers),
        ) {
            Ok(()) => true,
            Err(error) => {
                self.local_error = Some(format!("Mouse input not sent: {error}"));
                cx.notify();
                false
            }
        }
    }

    /// A pane's right-click opens its menu unless Herdr routes that pane's
    /// right-clicks to the application, as every client of the daemon does. A
    /// modifier always reaches the menu, so a routed pane can be switched back.
    /// A popup has no menu, so a mouse-aware one keeps its right-clicks.
    fn right_click_to_application(&self, target: &InputTarget, modifiers: Modifiers) -> bool {
        let InputTarget::Pane(id) = target else {
            return true;
        };
        !modifiers.modified()
            && self.live.snapshot.as_ref().is_some_and(|snapshot| {
                snapshot
                    .panes
                    .iter()
                    .any(|pane| pane.pane_id == *id && pane.right_click_passthrough)
            })
    }

    /// Returns ownership, not queue success: an unavailable application must not
    /// turn a click into an unexpected clipboard write or browser launch.
    pub(crate) fn terminal_mouse_down(
        &mut self,
        event: &MouseDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        self.cancel_terminal_mouse(cx);
        let Some(hit) = self.terminal_mouse_at(event.position).filter(|hit| {
            hit.mouse_reporting
                && !self.link_modifier_held(event.position, event.modifiers)
                && (event.button != MouseButton::Right
                    || self.right_click_to_application(&hit.target, event.modifiers))
        }) else {
            return false;
        };
        self.pressed_terminal_link = None;
        self.selection = None;
        window.focus(&self.focus, cx);
        cx.stop_propagation();
        if let Some(button) = button(event.button)
            && !cx.has_active_drag()
            && self.send_mouse(&hit, ClientMouseKind::Down(button), event.modifiers, cx)
            && let Some(snapshot) = &self.live.snapshot
        {
            self.terminal_mouse = Some(Gesture {
                hit,
                button: event.button,
                boot: snapshot.boot_id.clone(),
                epoch: self.selection_epoch,
                generation: self.selected_generation,
            });
        }
        true
    }

    fn gesture_hit(&self, gesture: &Gesture, position: Point<Pixels>) -> Option<WheelTarget> {
        if self.menu.page.is_some()
            || !self.input_ready()
            || gesture.epoch != self.selection_epoch
            || gesture.generation != self.selected_generation
            || self.live.snapshot.as_ref()?.boot_id != gesture.boot
        {
            return None;
        }
        let bounds = gesture.hit.bounds;
        let local = position - self.bounds.origin;
        let x = f32::from(local.x).clamp(
            f32::from(bounds.left()),
            f32::from(bounds.right()).next_down(),
        );
        let y = f32::from(local.y).clamp(
            f32::from(bounds.top()),
            f32::from(bounds.bottom()).next_down(),
        );
        let hit = wheel_target(
            self.live.surface.as_deref()?,
            x,
            y,
            self.cell_width,
            self.config.terminal.line_height(),
        )?;
        (hit.target == gesture.hit.target && hit.bounds == bounds && hit.mouse_reporting)
            .then_some(hit)
    }

    pub(crate) fn terminal_mouse_move(
        &mut self,
        event: &MouseMoveEvent,
        cx: &mut Context<Self>,
    ) -> bool {
        if cx.has_active_drag() {
            self.cancel_terminal_mouse(cx);
            self.selection = None;
            self.pressed_terminal_link = None;
            return false;
        }
        if let Some(gesture) = &self.terminal_mouse {
            if event.pressed_button != Some(gesture.button) {
                self.cancel_terminal_mouse(cx);
                return false;
            }
            let hit = self.gesture_hit(gesture, event.position);
            let kind = button(gesture.button).map(ClientMouseKind::Drag);
            if let (Some(hit), Some(kind)) = (hit, kind) {
                if self.send_mouse(&hit, kind, event.modifiers, cx)
                    && let Some(gesture) = &mut self.terminal_mouse
                {
                    gesture.hit = hit;
                }
            } else {
                self.cancel_terminal_mouse(cx);
            }
            return true;
        }
        false
    }

    pub(crate) fn terminal_mouse_hover(&mut self, event: &MouseMoveEvent, cx: &mut Context<Self>) {
        // Hover belongs to the hit-tested element, unlike an owned drag.
        if event.pressed_button.is_none()
            && !cx.has_active_drag()
            && !event.modifiers.shift
            && let Some(hit) = self
                .terminal_mouse_at(event.position)
                .filter(|hit| hit.mouse_reporting)
        {
            self.send_mouse(&hit, ClientMouseKind::Moved, event.modifiers, cx);
        }
    }

    pub(crate) fn terminal_mouse_up(
        &mut self,
        event: &MouseUpEvent,
        cx: &mut Context<Self>,
    ) -> bool {
        if cx.has_active_drag() {
            self.cancel_terminal_mouse(cx);
            self.selection = None;
            self.pressed_terminal_link = None;
            return false;
        }
        if self
            .terminal_mouse
            .as_ref()
            .is_none_or(|gesture| gesture.button != event.button)
        {
            return false;
        }
        let hit = self
            .terminal_mouse
            .as_ref()
            .and_then(|gesture| self.gesture_hit(gesture, event.position));
        if hit.is_none() {
            self.cancel_terminal_mouse(cx);
            return true;
        }
        self.terminal_mouse = None;
        if let Some(hit) = hit
            && let Some(button) = button(event.button)
            && self.send_mouse(&hit, ClientMouseKind::Up(button), event.modifiers, cx)
            && let InputTarget::Pane(id) = &hit.target
        {
            // Finish targeted input before navigation fences the surface. This
            // also lets the first click in an inactive split reach its app.
            self.focus_clicked_pane(id, cx);
        }
        true
    }

    pub(crate) fn focus_clicked_pane(&mut self, id: &str, cx: &mut Context<Self>) {
        if self
            .live
            .snapshot
            .as_ref()
            .and_then(|snapshot| snapshot.focused_pane_id.as_deref())
            != Some(id)
        {
            self.navigate(NavigationTarget::Pane(id), cx);
        }
    }

    fn scrollbar(&self, pane: &str) -> Option<Scrollbar> {
        let pane = self
            .live
            .surface
            .as_deref()?
            .panes
            .iter()
            .find(|p| p.pane_id == pane)?;
        Scrollbar::new(pane, self.cell_width, self.config.terminal.line_height())
    }

    /// Grabs the thumb where pressed, or jumps it under the pointer when the
    /// press lands on the track.
    pub(crate) fn scrollbar_mouse_down(
        &mut self,
        event: &MouseDownEvent,
        cx: &mut Context<Self>,
    ) -> bool {
        if self.menu.page.is_some() || !self.input_ready() {
            return false;
        }
        let (Some(surface), Some(snapshot)) = (self.live.surface.as_deref(), &self.live.snapshot)
        else {
            return false;
        };
        if surface.popup.is_some() {
            return false;
        }
        let local = event.position - self.bounds.origin;
        let cell_height = self.config.terminal.line_height();
        let Some((pane, bar)) = surface.panes.iter().find_map(|pane| {
            Scrollbar::new(pane, self.cell_width, cell_height)
                .filter(|bar| bar.track.contains(&local))
                .map(|bar| (pane.pane_id.clone(), bar))
        }) else {
            return false;
        };
        let grab = if bar.thumb.contains(&local) {
            f32::from(local.y - bar.thumb.top())
        } else {
            f32::from(bar.thumb.size.height) / 2.
        };
        self.scrollbar_drag = Some(ScrollbarDrag {
            pane,
            boot: snapshot.boot_id.clone(),
            grab,
            held: true,
            want: None,
        });
        self.drag_scrollbar(event.position, cx);
        cx.stop_propagation();
        true
    }

    pub(crate) fn scrollbar_mouse_move(
        &mut self,
        event: &MouseMoveEvent,
        cx: &mut Context<Self>,
    ) -> bool {
        let Some(drag) = self.scrollbar_drag.as_mut().filter(|drag| drag.held) else {
            return false;
        };
        if event.pressed_button != Some(MouseButton::Left) {
            drag.held = false;
            return false;
        }
        self.drag_scrollbar(event.position, cx);
        true
    }

    pub(crate) fn scrollbar_mouse_up(
        &mut self,
        event: &MouseUpEvent,
        cx: &mut Context<Self>,
    ) -> bool {
        let Some(drag) = self
            .scrollbar_drag
            .as_mut()
            .filter(|drag| drag.held && event.button == MouseButton::Left)
        else {
            return false;
        };
        drag.held = false;
        self.flush_scrollbar(cx);
        true
    }

    fn drag_scrollbar(&mut self, position: Point<Pixels>, cx: &mut Context<Self>) {
        let Some(drag) = &self.scrollbar_drag else {
            return;
        };
        let Some(bar) = self.scrollbar(&drag.pane) else {
            self.scrollbar_drag = None;
            return;
        };
        let top = f32::from(position.y - self.bounds.origin.y) - drag.grab;
        if let Some(drag) = &mut self.scrollbar_drag {
            drag.want = Some(bar.offset_at(top));
        }
        self.flush_scrollbar(cx);
    }

    /// Sends the latest wanted offset once the previous request has answered,
    /// and retires a released drag when nothing is left to send.
    pub(crate) fn flush_scrollbar(&mut self, cx: &mut Context<Self>) {
        let Some(drag) = &mut self.scrollbar_drag else {
            return;
        };
        if self.live.drag_request.is_some() {
            return;
        }
        let Some(offset) = drag.want.take() else {
            if !drag.held {
                self.scrollbar_drag = None;
            }
            return;
        };
        let connection = &self.endpoints[self.selected_endpoint].connection;
        let (Some(handle), Some(snapshot)) = (&connection.handle, &self.live.snapshot) else {
            self.scrollbar_drag = None;
            return;
        };
        if snapshot.boot_id != drag.boot {
            self.scrollbar_drag = None;
            return;
        }
        // Registered under the inbox lock so the response cannot be applied
        // before the request is known, which would leave the drag waiting.
        // The UI thread never waits on the worker; a busy inbox retries next tick.
        let Ok(mut state) = connection.inbox.try_lock() else {
            drag.want = Some(offset);
            return;
        };
        match handle.request(
            &drag.boot,
            Method::PaneScroll,
            json!({"pane_id": drag.pane, "offset_from_bottom": offset}),
        ) {
            Ok(request) => {
                state.drag_request = Some(request.clone());
                self.live.drag_request = Some(request);
            }
            Err(error) => {
                drop(state);
                self.local_error = Some(format!("Scroll not sent: {error}"));
                cx.notify();
            }
        }
    }

    /// The resize cursor for a held split drag, or for the border under the
    /// pointer that a press would pick up.
    pub(crate) fn split_cursor_at(&self, position: Point<Pixels>) -> Option<CursorStyle> {
        if let Some(drag) = self.split_drag.as_ref().filter(|drag| drag.held) {
            return Some(splits::cursor(drag.split.direction));
        }
        self.split_at(position)
            .map(|split| splits::cursor(split.direction))
    }

    fn split_at(&self, position: Point<Pixels>) -> Option<&PaneSurfaceSplit> {
        if self.menu.page.is_some()
            || !self.input_ready()
            || !self.live.surface_ready()
            || !self.bounds.contains(&position)
        {
            return None;
        }
        let local = position - self.bounds.origin;
        splits::split_at(
            self.live.surface.as_deref()?,
            f32::from(local.x),
            f32::from(local.y),
            self.cell_width,
            self.config.terminal.line_height(),
        )
    }

    /// Picks up the border under the pointer. Nothing is sent until it moves,
    /// so a click on a border leaves the layout as it was.
    pub(crate) fn split_mouse_down(
        &mut self,
        event: &MouseDownEvent,
        cx: &mut Context<Self>,
    ) -> bool {
        let Some(split) = self.split_at(event.position).cloned() else {
            return false;
        };
        let (Some(snapshot), Some(surface)) = (&self.live.snapshot, self.live.surface.as_deref())
        else {
            return false;
        };
        let Some(tab) = snapshot.focused_tab_id.clone() else {
            return false;
        };
        let local = event.position - self.bounds.origin;
        let pointer = splits::along(split.direction, f32::from(local.x), f32::from(local.y));
        let grab =
            splits::edge(&split, self.cell_width, self.config.terminal.line_height()) - pointer;
        self.split_drag = Some(SplitDrag {
            boot: snapshot.boot_id.clone(),
            tab,
            topology: splits::topology(surface),
            split,
            grab,
            held: true,
            want: None,
            sent: None,
        });
        self.cancel_terminal_mouse(cx);
        self.selection = None;
        self.pressed_terminal_link = None;
        cx.stop_propagation();
        cx.notify();
        true
    }

    pub(crate) fn split_mouse_move(
        &mut self,
        event: &MouseMoveEvent,
        cx: &mut Context<Self>,
    ) -> bool {
        let cell_height = self.config.terminal.line_height();
        let Some(drag) = self.split_drag.as_mut().filter(|drag| drag.held) else {
            return false;
        };
        if event.pressed_button != Some(MouseButton::Left) {
            drag.held = false;
            cx.notify();
            return false;
        }
        let local = event.position - self.bounds.origin;
        let pointer = splits::along(drag.split.direction, f32::from(local.x), f32::from(local.y));
        let ratio = splits::ratio(
            &drag.split,
            pointer + drag.grab,
            self.cell_width,
            cell_height,
        );
        if let Some(ratio) = ratio.filter(|ratio| drag.sent != Some(*ratio)) {
            drag.want = Some(ratio);
        }
        self.flush_split(cx);
        true
    }

    pub(crate) fn split_mouse_up(&mut self, event: &MouseUpEvent, cx: &mut Context<Self>) -> bool {
        let Some(drag) = self
            .split_drag
            .as_mut()
            .filter(|drag| drag.held && event.button == MouseButton::Left)
        else {
            return false;
        };
        drag.held = false;
        self.flush_split(cx);
        cx.notify();
        true
    }

    /// Sends the latest wanted ratio once the previous drag request has
    /// answered, and retires a released drag when nothing is left to send.
    /// The drag ends once its tab or panes change: its path could then name a
    /// different border.
    pub(crate) fn flush_split(&mut self, cx: &mut Context<Self>) {
        let Some(drag) = &mut self.split_drag else {
            return;
        };
        if self.live.drag_request.is_some() {
            return;
        }
        let Some(ratio) = drag.want else {
            if !drag.held {
                self.split_drag = None;
            }
            return;
        };
        let connection = &self.endpoints[self.selected_endpoint].connection;
        let (Some(handle), Some(snapshot)) = (&connection.handle, &self.live.snapshot) else {
            self.split_drag = None;
            return;
        };
        if snapshot.boot_id != drag.boot {
            self.split_drag = None;
            return;
        }
        // A snapshot ahead of its surface is waited out, not taken as a change.
        let Some(surface) = self
            .live
            .surface
            .as_deref()
            .filter(|_| self.live.surface_ready())
        else {
            return;
        };
        if snapshot.focused_tab_id.as_deref() != Some(drag.tab.as_str())
            || splits::topology(surface) != drag.topology
        {
            self.split_drag = None;
            return;
        }
        // Registered under the inbox lock for the same reason as the scrollbar.
        let Ok(mut state) = connection.inbox.try_lock() else {
            return;
        };
        match handle.request(
            &drag.boot,
            Method::LayoutSetSplitRatio,
            json!({"tab_id": drag.tab, "path": drag.split.path, "ratio": ratio}),
        ) {
            Ok(request) => {
                drag.want = None;
                drag.sent = Some(ratio);
                state.drag_request = Some(request.clone());
                self.live.drag_request = Some(request);
            }
            Err(error) => {
                drop(state);
                self.split_drag = None;
                self.local_error = Some(format!("Pane resize not sent: {error}"));
                cx.notify();
            }
        }
    }
}
