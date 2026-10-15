//! Keyboard admission for Home's action row only, never terminal Tab input.
use super::*;

pub(super) fn focus_control(
    control: Stateful<Div>,
    focus: &FocusHandle,
    index: isize,
    color: u32,
) -> Stateful<Div> {
    control
        .track_focus(focus)
        .tab_index(index)
        .focus_visible(move |style| {
            style.shadow(vec![BoxShadow {
                color: rgb(color).into(),
                offset: point(px(0.), px(0.)),
                blur_radius: px(0.),
                spread_radius: px(2.),
                inset: false,
            }])
        })
}

impl SnapshotView {
    pub(in crate::tmux_snapshot) fn home_action_index(&self, window: &Window) -> Option<usize> {
        if self.browser_state.surface != browser::Surface::Home {
            return None;
        }
        self.home_filter
            .as_ref()?
            .actions
            .iter()
            .position(|focus| focus.is_focused(window))
    }

    pub(super) fn home_action_key(
        &mut self,
        event: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        if self.browser_state.surface != browser::Surface::Home
            || self.browser_commands.is_none()
            || self.picker.is_some()
            || self.new_session.is_some()
            || self.pane_actions.is_some()
            || event.keystroke.modifiers.platform
            || event.keystroke.modifiers.control
            || event.keystroke.modifiers.alt
        {
            return false;
        }
        let selected = self.home_action_index(window);
        match event.keystroke.key.as_str() {
            "tab" if selected.is_some() || self.terminal_focus.is_focused(window) => {
                self.prepare_home_filter(cx);
                if let Some(controls) = &self.home_filter {
                    let next = match (selected, event.keystroke.modifiers.shift) {
                        (None, false) => 0,
                        (None, true) => 2,
                        (Some(index), false) => (index + 1) % 3,
                        (Some(index), true) => (index + 2) % 3,
                    };
                    controls.actions[next].focus(window, cx);
                }
            }
            "escape" if selected.is_some() => self.terminal_focus.focus(window, cx),
            _ => return false,
        }
        cx.stop_propagation();
        window.prevent_default();
        cx.notify();
        true
    }
}
