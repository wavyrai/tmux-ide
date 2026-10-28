//! F5 projects the existing pane-action capability without adding a transport verb.
use super::{Mode, Row, Target, browser};
use crate::tmux_snapshot::pane_actions;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(in crate::tmux_snapshot) enum Action {
    Rename,
    Focus(usize),
    NewWindow,
    NewAgent,
    Close,
    Zoom(bool),
    SplitRight,
    SplitDown,
}
impl Action {
    pub(super) fn wire(self) -> Option<pane_actions::Action> {
        Some(match self {
            Self::Rename | Self::NewAgent | Self::Focus(_) => return None,
            Self::Close => pane_actions::Action::Close,
            Self::NewWindow => pane_actions::Action::NewWindow,
            Self::Zoom(true) => pane_actions::Action::Zoom {
                desired: pane_actions::Zoom::Zoomed,
            },
            Self::Zoom(false) => pane_actions::Action::Zoom {
                desired: pane_actions::Zoom::Unzoomed,
            },
            Self::SplitRight => pane_actions::Action::Split {
                direction: pane_actions::SplitDirection::Right,
            },
            Self::SplitDown => pane_actions::Action::Split {
                direction: pane_actions::SplitDirection::Down,
            },
        })
    }
}
pub(super) fn rows(state: &browser::State, query: &str) -> Vec<Row> {
    if state.surface != browser::Surface::Workspace {
        return Vec::new();
    }
    let captured = pane_actions::Target::capture(state);
    let zoomed = state
        .pane_actions
        .as_ref()
        .is_some_and(|actions| actions.zoomed);
    [
        (Action::Rename, "Rename pane…"),
        (Action::NewWindow, "New terminal window"),
        (Action::NewAgent, "New agent…"),
        (Action::Close, "Close pane…"),
        (
            Action::Zoom(!zoomed),
            if zoomed { "Unzoom pane" } else { "Zoom pane" },
        ),
        (Action::SplitRight, "Split right"),
        (Action::SplitDown, "Split down"),
        (Action::Focus(0), crate::tmux_snapshot::kbd::FOCUS[0].0),
        (Action::Focus(1), crate::tmux_snapshot::kbd::FOCUS[1].0),
        (Action::Focus(2), crate::tmux_snapshot::kbd::FOCUS[2].0),
        (Action::Focus(3), crate::tmux_snapshot::kbd::FOCUS[3].0),
    ]
    .into_iter()
    .filter(|(action, label)| {
        if let Action::Focus(direction) = action
            && !state.selected_pane.as_deref().is_some_and(|id| {
                crate::tmux_snapshot::pane_shortcuts::neighbor(&state.regions, id, *direction)
                    .is_some()
            })
        {
            return false;
        }
        query
            .split_whitespace()
            .all(|term| label.to_lowercase().contains(term))
    })
    .map(|(action, label)| Row {
        target: Target::PaneAction {
            captured: captured.clone(),
            action,
        },
        label: label.into(),
    })
    .collect()
}

use super::SnapshotView;
use gpui::*;
impl SnapshotView {
    pub(super) fn choose_pane_command(
        &mut self,
        captured: Option<&pane_actions::Target>,
        action: Action,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.picker.as_ref().is_none_or(|picker| {
            picker.mode != Mode::Commands || picker.closing.is_some() || picker.agent.is_some()
        }) || self.new_session.is_some()
            || self.pane_actions.is_some()
        {
            return;
        }
        if let Some(captured) = captured {
            if let Action::Focus(direction) = action {
                if captured.current(&self.browser_state) {
                    self.close_picker(window, cx);
                    self.focus_neighbor(direction, window, cx);
                }
                return;
            }
            if matches!(action, Action::Rename) {
                if captured.current(&self.browser_state) {
                    self.close_picker(window, cx);
                    self.open_pane_actions(window, cx);
                    self.edit_pane_name(window, cx);
                }
                return;
            }
            if matches!(action, Action::NewAgent) {
                self.begin_new_agent(captured.clone(), window, cx);
                return;
            }
            if matches!(action, Action::Close) {
                self.begin_pane_close(captured.clone(), window, cx);
                return;
            }
            let Some(action) = action.wire() else {
                return;
            };
            if self.dispatch_captured_pane_action(captured, action, window, cx) {
                self.close_picker(window, cx);
            } else if let Some(picker) = &mut self.picker {
                picker.error = Some("Action queue unavailable — cancel and reselect the pane.");
                cx.notify();
            }
        }
    }
    pub(in crate::tmux_snapshot) fn picker_pane_shortcut(
        &mut self,
        shortcut: crate::tmux_snapshot::pane_shortcuts::Shortcut,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        let Some(picker) = self.picker.as_ref() else {
            return false;
        };
        let Some(captured) = picker.pane_scope.clone() else {
            return false;
        };
        if picker.search.read(cx).is_composing()
            || picker.closing.is_some()
            || picker.agent.is_some()
        {
            return true;
        }
        let action = match shortcut {
            crate::tmux_snapshot::pane_shortcuts::Shortcut::SplitRight => Action::SplitRight,
            crate::tmux_snapshot::pane_shortcuts::Shortcut::SplitDown => Action::SplitDown,
            crate::tmux_snapshot::pane_shortcuts::Shortcut::NewWindow => Action::NewWindow,
            crate::tmux_snapshot::pane_shortcuts::Shortcut::Close => Action::Close,
            crate::tmux_snapshot::pane_shortcuts::Shortcut::Window(_) => return true,
            crate::tmux_snapshot::pane_shortcuts::Shortcut::Focus(direction) => {
                Action::Focus(direction)
            }
            crate::tmux_snapshot::pane_shortcuts::Shortcut::Zoom => Action::Zoom(
                !self
                    .browser_state
                    .pane_actions
                    .as_ref()
                    .is_some_and(|a| a.zoomed),
            ),
        };
        self.choose_picker(
            Target::PaneAction {
                captured: Some(captured),
                action,
            },
            window,
            cx,
        );
        true
    }
}
