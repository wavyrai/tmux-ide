//! Keyboard input typed while a newer snapshot waits for its matching surface.
//!
//! The daemon publishes a snapshot before the surface of the same projection
//! revision, and an agent's title spinner bumps that revision several times a
//! second. Without a coherent surface the popup target is unknown, so input
//! waits here instead of being discarded, and leaves only for the target that
//! was focused when the gap opened.

use super::{Flash, HerdrWindow};
use crate::{connection::ConnectionBridge, terminal::InputTarget};
use gpui::Context;
use herdr_client::protocol::ClientPaneInputEvent;
use std::collections::VecDeque;

/// Gaps normally close within a render tick; this bounds a stalled one.
const MAX_PENDING_EVENTS: usize = 256;

#[derive(Clone, Debug, PartialEq, Eq)]
struct Target {
    boot: String,
    input: InputTarget,
}

#[derive(Default)]
pub(crate) struct PendingInput {
    /// Where input went at the last coherent projection.
    target: Option<Target>,
    events: VecDeque<ClientPaneInputEvent>,
}

impl PendingInput {
    // Only the Unix socket lifecycle tests inspect the queue.
    #[cfg(all(test, unix))]
    pub(crate) fn len(&self) -> usize {
        self.events.len()
    }
}

impl HerdrWindow {
    pub(crate) fn send(&mut self, event: ClientPaneInputEvent, cx: &mut Context<Self>) {
        if self.menu.page.is_some() || self.mouse_focus_pending() {
            return;
        }
        if !self.input_ready() {
            if self.disconnected() {
                // Nothing typed into a lost connection is replayed into the
                // next one: the user sees that it went nowhere.
                self.show_flash(Flash::warning("Not connected: input not sent"), cx);
                return;
            }
            self.hold_input(event, cx);
            return;
        }
        if !self.flush_pending_input(cx) {
            return;
        }
        let Some(target) = &self.pending_input.target else {
            return;
        };
        let handle = &self.endpoints[self.selected_endpoint].connection.handle;
        if let Some(handle) = handle
            && let Err(error) =
                ConnectionBridge::send_input(handle, &target.boot, &target.input, event)
        {
            self.local_error = Some(format!("Input not sent: {error}"));
            cx.notify();
        }
    }

    /// Whether the selected endpoint is down or reconnecting after a drop.
    fn disconnected(&self) -> bool {
        !self.live.status.is_connected()
            || self.endpoints[self.selected_endpoint].outage().is_some()
    }

    /// Hold input only across a projection gap on an unchanged connection.
    /// Toasts, navigation, and activation choose a new target on purpose, so
    /// input during them is still ignored as before.
    fn hold_input(&mut self, event: ClientPaneInputEvent, cx: &mut Context<Self>) {
        let gap = self.pending_toast.is_none()
            && self.pending_navigation.is_none()
            && self.live.status.is_connected()
            && !self.live.activation_pending()
            && self.endpoints[self.selected_endpoint]
                .connection
                .handle
                .is_some()
            && self
                .pending_input
                .target
                .as_ref()
                .zip(self.live.snapshot.as_ref())
                .is_some_and(|(target, snapshot)| target.boot == snapshot.boot_id);
        if !gap {
            return;
        }
        if self.pending_input.events.len() >= MAX_PENDING_EVENTS {
            self.local_error = Some("Input not sent: the terminal stopped updating".into());
            cx.notify();
            return;
        }
        self.pending_input.events.push_back(event);
    }

    /// Record the current target and deliver held input to it in order, or
    /// discard it if focus moved during the gap. Returns whether the
    /// projection is coherent, so the caller may send after held input.
    pub(crate) fn flush_pending_input(&mut self, cx: &mut Context<Self>) -> bool {
        if !self.input_ready() {
            return false;
        }
        let target = self
            .live
            .snapshot
            .as_ref()
            .zip(self.focused_input_target())
            .map(|(snapshot, input)| Target {
                boot: snapshot.boot_id.clone(),
                input,
            });
        let previous = std::mem::replace(&mut self.pending_input.target, target);
        if self.pending_input.events.is_empty() {
            return true;
        }
        let events = std::mem::take(&mut self.pending_input.events);
        let (Some(target), Some(handle)) = (
            self.pending_input
                .target
                .as_ref()
                .filter(|t| previous.as_ref() == Some(*t)),
            &self.endpoints[self.selected_endpoint].connection.handle,
        ) else {
            self.local_error = Some("Input not sent: focus changed before it arrived".into());
            cx.notify();
            return true;
        };
        for event in events {
            if let Err(error) =
                ConnectionBridge::send_input(handle, &target.boot, &target.input, event)
            {
                self.local_error = Some(format!("Input not sent: {error}"));
                cx.notify();
                break;
            }
        }
        true
    }

    /// A reconnect, detach, or endpoint switch starts with no target and
    /// nothing held for the old one.
    pub(crate) fn clear_pending_input(&mut self) {
        self.pending_input = PendingInput::default();
    }
}
