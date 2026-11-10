//! Native pane commands; never synthesize terminal input for navigation.
use super::{SnapshotView, browser, browser_ui::Selection, hit_regions::Region, pane_actions};
use gpui::*;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Shortcut {
    Zoom,
    SplitRight,
    SplitDown,
    NewWindow,
    Close,
    Window(bool),
    Focus(usize),
}
pub(super) fn shortcut(key: &Keystroke) -> Option<Shortcut> {
    let m = key.modifiers;
    if !m.platform || m.control {
        return None;
    }
    if !m.alt {
        match (key.key.as_str(), m.shift) {
            ("d", false) => return Some(Shortcut::SplitRight),
            ("d", true) => return Some(Shortcut::SplitDown),
            ("t", false) => return Some(Shortcut::NewWindow),
            ("w", false) => return Some(Shortcut::Close),
            ("[", true) | ("{", _) => return Some(Shortcut::Window(false)),
            ("]", true) | ("}", _) => return Some(Shortcut::Window(true)),
            _ => {}
        }
    }
    if m.shift && !m.alt && key.key == "enter" {
        return Some(Shortcut::Zoom);
    }
    if m.alt && !m.shift {
        return ["left", "right", "up", "down"]
            .iter()
            .position(|k| *k == key.key)
            .map(Shortcut::Focus);
    }
    None
}
pub(super) fn neighbor<'a>(
    regions: &'a [Region],
    selected: &str,
    direction: usize,
) -> Option<&'a str> {
    let origin = regions.iter().find(|r| r.id == selected)?;
    let center = |r: &Region| {
        (
            i64::from(r.left) * 2 + i64::from(r.width),
            i64::from(r.top) * 2 + i64::from(r.height),
        )
    };
    let (x, y) = center(origin);
    regions
        .iter()
        .filter(|r| r.id != selected)
        .filter_map(|r| {
            let (rx, ry) = center(r);
            let (along, across, overlap) = match direction {
                0 | 1 => (
                    if direction == 0 { x - rx } else { rx - x },
                    (ry - y).abs(),
                    u32::from(r.top) < u32::from(origin.top) + u32::from(origin.height)
                        && u32::from(origin.top) < u32::from(r.top) + u32::from(r.height),
                ),
                2 | 3 => (
                    if direction == 2 { y - ry } else { ry - y },
                    (rx - x).abs(),
                    u32::from(r.left) < u32::from(origin.left) + u32::from(origin.width)
                        && u32::from(origin.left) < u32::from(r.left) + u32::from(r.width),
                ),
                _ => return None,
            };
            (along > 0 && overlap).then_some(((along, across, &r.id), r.id.as_str()))
        })
        .min_by_key(|(distance, _)| *distance)
        .map(|(_, id)| id)
}
impl SnapshotView {
    pub(super) fn focus_neighbor(
        &mut self,
        direction: usize,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.browser_state.surface != browser::Surface::Workspace
            || !self.presence.ready()
            || !self.browser_state.input_ready
            || self.browser_state.retained_preview
        {
            return;
        }
        let Some(selected) = self.browser_state.selected_pane.as_deref() else {
            return;
        };
        let Some(id) =
            neighbor(&self.browser_state.regions, selected, direction).map(str::to_owned)
        else {
            return;
        };
        self.select(Selection::Pane(id), window, cx);
    }
    pub(super) fn pane_shortcut_key(
        &mut self,
        event: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        if self.browser_shortcut_key(event, window, cx) {
            return true;
        }
        let Some(shortcut) = shortcut(&event.keystroke) else {
            return false;
        };
        if self.browser_address.is_some() || self.pane_actions.is_some() || !self.marked.is_empty()
        {
            return false;
        }
        cx.stop_propagation();
        window.prevent_default();
        if !event.is_held && self.picker_pane_shortcut(shortcut, window, cx) {
            return true;
        }
        if self.picker.is_some()
            || self.new_session.is_some()
            || !self.terminal_focus.is_focused(window)
            || event.is_held
            || self.divider.is_some()
            || self.resize_gesture.busy()
        {
            return true;
        }
        match shortcut {
            Shortcut::Window(forward) => {
                let choices = super::navigation::windows(
                    &self.browser_state.panes,
                    self.browser_state.selected_pane.as_deref(),
                );
                let Some(index) = choices.iter().position(|choice| choice.selected) else {
                    return true;
                };
                let next = if forward {
                    (index + 1) % choices.len()
                } else {
                    (index + choices.len() - 1) % choices.len()
                };
                if let Some(session) = self.browser_state.selected_session.clone() {
                    self.select_window(self.browser_request, &session, &choices[next], window, cx);
                }
            }
            Shortcut::SplitRight | Shortcut::SplitDown | Shortcut::NewWindow | Shortcut::Close => {
                let Some(target) = pane_actions::Target::capture(&self.browser_state) else {
                    return true;
                };
                if shortcut == Shortcut::Close {
                    self.open_header_actions(window, cx);
                    self.picker_pane_shortcut(Shortcut::Close, window, cx);
                } else {
                    let action = match shortcut {
                        Shortcut::SplitRight => pane_actions::Action::Split {
                            direction: pane_actions::SplitDirection::Right,
                        },
                        Shortcut::SplitDown => pane_actions::Action::Split {
                            direction: pane_actions::SplitDirection::Down,
                        },
                        _ => pane_actions::Action::NewWindow,
                    };
                    self.dispatch_captured_pane_action(&target, action, window, cx);
                }
            }
            Shortcut::Focus(direction) => self.focus_neighbor(direction, window, cx),
            Shortcut::Zoom => {
                let Some(target) = pane_actions::Target::capture(&self.browser_state) else {
                    return true;
                };
                let desired = if self
                    .browser_state
                    .pane_actions
                    .as_ref()
                    .is_some_and(|a| a.zoomed)
                {
                    pane_actions::Zoom::Unzoomed
                } else {
                    pane_actions::Zoom::Zoomed
                };
                self.dispatch_captured_pane_action(
                    &target,
                    pane_actions::Action::Zoom { desired },
                    window,
                    cx,
                );
            }
        }
        true
    }
}
#[cfg(test)]
mod tests;
