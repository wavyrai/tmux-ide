//! Two clean modifier taps, without delaying or consuming ordinary input.

use super::HerdrWindow;
use gpui::{Capslock, Context, Modifiers, ModifiersChangedEvent, Window};
use std::time::{Duration, Instant};

const TAP_DURATION: Duration = Duration::from_millis(250);
const DOUBLE_TAP: Duration = Duration::from_millis(400);

#[derive(Default)]
pub(crate) struct ShiftTaps {
    modifiers: Modifiers,
    capslock: Capslock,
    pressed: Option<Instant>,
    first: Option<Instant>,
}

impl ShiftTaps {
    pub(crate) fn cancel(&mut self) {
        self.pressed = None;
        self.first = None;
    }

    fn changed(&mut self, event: &ModifiersChangedEvent, eligible: bool, now: Instant) -> bool {
        let previous = self.modifiers;
        self.modifiers = event.modifiers;
        let caps_changed = self.capslock != event.capslock;
        self.capslock = event.capslock;
        let shift = Modifiers {
            shift: true,
            ..Modifiers::default()
        };
        if !eligible
            || caps_changed
            || (event.modifiers != shift && event.modifiers != Modifiers::default())
        {
            self.cancel();
            return false;
        }
        if previous == event.modifiers {
            return false;
        }
        if event.modifiers == shift && previous == Modifiers::default() {
            self.pressed = Some(now);
            return false;
        }
        if previous != shift {
            self.cancel();
            return false;
        }
        let Some(pressed) = self.pressed.take() else {
            return false;
        };
        if now.saturating_duration_since(pressed) > TAP_DURATION {
            self.cancel();
            return false;
        }
        if self
            .first
            .take()
            .is_some_and(|first| now.saturating_duration_since(first) <= DOUBLE_TAP)
        {
            return true;
        }
        self.first = Some(now);
        false
    }
}

impl HerdrWindow {
    pub(super) fn double_shift_modifiers(
        &mut self,
        event: &ModifiersChangedEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let eligible = self.config.palette.double_shift
            && self.active
            && self.menu.page.is_none()
            && self.marked.is_empty()
            && !self.prefix_armed
            && !cx.has_active_drag()
            && self.terminal_mouse.is_none()
            && self.selection.is_none()
            && self.workspace_drag.is_none()
            && self.tab_drag.is_none()
            && self.sidebar_drag.is_none()
            && self.split_drag.is_none()
            && self.scrollbar_drag.is_none();
        if self.shift_taps.changed(event, eligible, Instant::now()) {
            self.open_palette(crate::palette::Filter::All, window, cx);
        }
    }
}

#[cfg(test)]
mod tests;
