//! Resident opaque-key selection follows the TUI Home selection owner. Rendering
//! reconciles observations; activation still revalidates the current roster.
use super::*;

impl filters::Controls {
    pub(super) fn reconcile(&mut self, rows: Vec<(String, bool)>) {
        let previous = self
            .visible
            .iter()
            .position(|(key, _)| Some(key) == self.selected.as_ref())
            .unwrap_or(0);
        let retained = rows
            .iter()
            .any(|(key, available)| *available && Some(key) == self.selected.as_ref());
        let previous_key = self.selected.clone();
        self.visible = rows;
        if !retained {
            let start = previous.min(self.visible.len().saturating_sub(1));
            self.selected = self
                .visible
                .iter()
                .skip(start)
                .find(|(_, available)| *available)
                .or_else(|| {
                    self.visible
                        .iter()
                        .take(start)
                        .rev()
                        .find(|(_, available)| *available)
                })
                .map(|(key, _)| key.clone());
        }
        let next = self
            .visible
            .iter()
            .position(|(key, _)| Some(key) == self.selected.as_ref())
            .unwrap_or(0);
        if previous_key != self.selected || previous != next {
            self.reveal(false);
        }
    }
    fn reveal(&self, reveal_page: bool) {
        if let Some(index) = self
            .visible
            .iter()
            .position(|(key, _)| Some(key) == self.selected.as_ref())
        {
            self.scroll.scroll_to_item(index);
            if reveal_page {
                let viewport = self.page_scroll.bounds();
                let list = self.scroll.bounds();
                let mut offset = self.page_scroll.offset();
                if list.top() < viewport.top() {
                    offset.y += viewport.top() - list.top();
                } else if list.bottom() > viewport.bottom() {
                    offset.y -= list.bottom() - viewport.bottom();
                }
                self.page_scroll.set_offset(offset);
            }
        }
    }
    fn navigate(&mut self, key: &str) {
        let available: Vec<_> = self
            .visible
            .iter()
            .filter(|(_, available)| *available)
            .map(|(key, _)| key)
            .collect();
        if available.is_empty() {
            self.selected = None;
            return;
        }
        let current = available
            .iter()
            .position(|key| Some(*key) == self.selected.as_ref())
            .unwrap_or(0);
        let page = self
            .scroll
            .bottom_item()
            .saturating_sub(self.scroll.top_item())
            .max(1);
        let index = match key {
            "up" => current.saturating_sub(1),
            "down" => (current + 1).min(available.len() - 1),
            "pageup" => current.saturating_sub(page),
            "pagedown" => (current + page).min(available.len() - 1),
            "home" => 0,
            "end" => available.len() - 1,
            _ => return,
        };
        self.selected = Some(available[index].clone());
        self.reveal(true);
    }
}
impl SnapshotView {
    pub(super) fn reconcile_home_selection(&mut self, cx: &Context<Self>) {
        let Some(controls) = &mut self.home_filter else {
            return;
        };
        let rows = self
            .browser_state
            .home_agents
            .as_ref()
            .map_or_else(Vec::new, |roster| {
                let query = controls.search.read(cx).text();
                roster
                    .rows
                    .iter()
                    .filter(|row| controls.filter.matches(roster, row, query))
                    .map(|row| {
                        (
                            row.key.clone(),
                            self.browser_commands.is_some() && roster.available(&row.key),
                        )
                    })
                    .collect()
            });
        controls.reconcile(rows);
    }
    pub(super) fn home_agent_key(
        &mut self,
        event: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        let key = event.keystroke.key.as_str();
        if !matches!(
            key,
            "up" | "down" | "pageup" | "pagedown" | "home" | "end" | "enter"
        ) {
            return false;
        }
        let Some(controls) = &self.home_filter else {
            return false;
        };
        let search = controls.search.read(cx);
        if search.focus.is_focused(window)
            && (search.is_composing() || matches!(key, "home" | "end"))
        {
            return false;
        }
        let captured = (controls.selected.clone(), controls.rendered_revision);
        self.reconcile_home_selection(cx);
        if key == "enter" {
            let target = self.home_filter.as_ref().and_then(|c| c.selected.clone());
            if !event.is_held
                && captured.0 == target
                && let (Some(key), Some(roster)) = (target, self.browser_state.home_agents.as_ref())
                && captured.1 == Some(roster.revision)
            {
                self.home_agent_select(self.browser_request, roster.revision, &key, window, cx);
            }
        } else if let Some(controls) = &mut self.home_filter {
            controls.navigate(key);
        }
        cx.stop_propagation();
        window.prevent_default();
        cx.notify();
        true
    }
}
