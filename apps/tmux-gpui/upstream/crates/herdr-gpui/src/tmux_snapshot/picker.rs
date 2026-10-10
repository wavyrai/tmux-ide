//! Bounded catalog switcher. Labels are searchable display text, never command targets.
use super::{SnapshotView, browser, browser_ui::Selection};
use crate::search_input::{Changed, SearchInput};
use gpui::{prelude::*, *};
use nucleo_matcher::{
    Config, Matcher, Utf32String,
    pattern::{CaseMatching, Normalization, Pattern},
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum Target {
    Session(String),
    Pane(String),
    Theme(String),
}
#[derive(Clone)]
pub(super) struct Row {
    target: Target,
    label: String,
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    Navigation,
    Theme,
}
pub(super) struct Picker {
    mode: Mode,
    error: Option<&'static str>,
    search: Entity<SearchInput>,
    _changed: Subscription,
    rows: Vec<Row>,
    selected: usize,
    request: u64,
    scroll: ScrollHandle,
}
fn rows(state: &browser::State, query: &str) -> Vec<Row> {
    let query: String = query.chars().take(256).collect();
    let pattern = Pattern::parse(&query, CaseMatching::Ignore, Normalization::Smart);
    let mut matcher = Matcher::new(Config::DEFAULT);
    let mut matches = Vec::new();
    for (pane, choices) in [(false, &state.sessions), (true, &state.panes)] {
        for choice in choices.iter().take(512) {
            let label = format!(
                "{} · {}",
                if pane { "Pane" } else { "Session" },
                choice.label.chars().take(256).collect::<String>()
            );
            let text: Utf32String = label.as_str().into();
            if let Some(score) = pattern.score(text.slice(..), &mut matcher) {
                matches.push((
                    score,
                    Row {
                        target: if pane {
                            Target::Pane(choice.id.clone())
                        } else {
                            Target::Session(choice.id.clone())
                        },
                        label,
                    },
                ));
            }
        }
    }
    matches.sort_by_key(|item| std::cmp::Reverse(item.0));
    matches.into_iter().take(32).map(|(_, row)| row).collect()
}
fn theme_rows(state: &browser::State, query: &str) -> Vec<Row> {
    let query = query.to_lowercase();
    state.appearance.as_ref().map_or_else(Vec::new, |a| {
        a.options
            .iter()
            .filter(|o| {
                format!("{} {}", o.id, o.name)
                    .to_lowercase()
                    .contains(&query)
            })
            .map(|o| Row {
                target: Target::Theme(o.id.clone()),
                label: format!("{}{}", if o.id == a.selected { "✓ " } else { "" }, o.name),
            })
            .collect()
    })
}
fn current(state: &browser::State, target: &Target) -> bool {
    match target {
        Target::Session(id) => state.sessions.iter().any(|c| &c.id == id),
        Target::Pane(id) => state.panes.iter().any(|c| &c.id == id),
        Target::Theme(id) => state
            .appearance
            .as_ref()
            .is_some_and(|a| a.options.iter().any(|o| &o.id == id)),
    }
}
impl SnapshotView {
    pub(super) fn open_picker(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.open_picker_mode(Mode::Navigation, window, cx);
    }
    pub(super) fn open_theme_picker(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.browser_state.appearance.is_some() {
            self.open_picker_mode(Mode::Theme, window, cx);
        }
    }
    fn open_picker_mode(&mut self, mode: Mode, window: &mut Window, cx: &mut Context<Self>) {
        if self.browser_commands.is_none() {
            return;
        }
        self.pane_actions = None;
        self.new_session = None;
        self.divider = None;
        self.discard_composition(cx);
        self.clear_selection(cx);
        let search = cx.new(|cx| {
            let mut input = SearchInput::new(cx).with_max_bytes(1024);
            input.set_placeholder(
                if mode == Mode::Theme {
                    "Search themes…"
                } else {
                    "Search sessions and panes…"
                },
                cx,
            );
            input.set_appearance(crate::config::Config::default().ui, self.theme(), cx);
            input
        });
        let changed = cx.subscribe(&search, |view, _, _: &Changed, cx| {
            view.refresh_picker(cx);
            cx.notify();
        });
        search.read(cx).focus.clone().focus(window, cx);
        self.picker = Some(Picker {
            mode,
            error: None,
            search,
            _changed: changed,
            rows: if mode == Mode::Theme {
                theme_rows(&self.browser_state, "")
            } else {
                rows(&self.browser_state, "")
            },
            selected: 0,
            request: self.browser_request,
            scroll: ScrollHandle::new(),
        });
        cx.notify();
    }
    pub(super) fn refresh_picker(&mut self, cx: &mut Context<Self>) {
        let theme = self.theme();
        let Some(picker) = &mut self.picker else {
            return;
        };
        picker.search.update(cx, |input, cx| {
            input.set_appearance(crate::config::Config::default().ui, theme, cx)
        });
        if self.browser_commands.is_none()
            || (picker.mode == Mode::Navigation
                && (picker.request != self.browser_request
                    || (self.browser_state.sessions.is_empty()
                        && self.browser_state.panes.is_empty())))
        {
            self.picker = None;
            return;
        }
        picker.rows = if picker.mode == Mode::Theme {
            theme_rows(&self.browser_state, picker.search.read(cx).text())
        } else {
            rows(&self.browser_state, picker.search.read(cx).text())
        };
        picker.selected = picker.selected.min(picker.rows.len().saturating_sub(1));
    }
    fn close_picker(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.picker = None;
        self.terminal_focus.focus(window, cx);
        cx.notify();
    }
    fn choose_picker(&mut self, target: Target, window: &mut Window, cx: &mut Context<Self>) {
        if self
            .picker
            .as_ref()
            .is_none_or(|p| p.mode == Mode::Navigation && p.request != self.browser_request)
            || self.browser_commands.is_none()
            || !current(&self.browser_state, &target)
        {
            return;
        }
        if let Target::Theme(id) = target {
            // Queueing is not a save acknowledgement; only publications update selection.
            if let Some(sender) = &self.browser_commands {
                let error = sender
                    .try_send(browser::Command::Theme { id })
                    .err()
                    .map(|_| "Theme command queue unavailable — try again");
                if let Some(picker) = &mut self.picker {
                    picker.error = error;
                }
                cx.notify();
            }
            return;
        }
        self.close_picker(window, cx);
        self.select(
            match target {
                Target::Session(id) => Selection::Session(id),
                Target::Pane(id) => Selection::Pane(id),
                Target::Theme(_) => return,
            },
            window,
            cx,
        );
    }
    pub(super) fn picker_key(
        &mut self,
        event: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.new_session.is_some() {
            self.new_session_key(event, window, cx);
            return;
        }
        if self.pane_actions.is_some() {
            self.pane_actions_key(event, window, cx);
            return;
        }
        if self
            .picker
            .as_ref()
            .is_some_and(|p| p.search.read(cx).is_composing())
        {
            return;
        }
        let key = &event.keystroke;
        if key.modifiers.platform && !key.modifiers.control && !key.modifiers.alt && key.key == "k"
        {
            self.open_picker(window, cx);
            cx.stop_propagation();
            window.prevent_default();
            return;
        }
        let Some(picker) = &mut self.picker else {
            return;
        };
        if picker.search.read(cx).is_composing() {
            return;
        }
        match key.key.as_str() {
            "escape" => self.close_picker(window, cx),
            "up" => picker.selected = picker.selected.saturating_sub(1),
            "down" => {
                picker.selected = (picker.selected + 1).min(picker.rows.len().saturating_sub(1))
            }
            "enter" => {
                let target = picker
                    .rows
                    .get(picker.selected)
                    .map(|row| row.target.clone());
                if let Some(target) = target {
                    self.choose_picker(target, window, cx);
                }
            }
            _ => return,
        }
        if let Some(picker) = &self.picker {
            picker.scroll.scroll_to_item(picker.selected);
        }
        cx.stop_propagation();
        window.prevent_default();
        cx.notify();
    }
    pub(super) fn picker_render(&self, cx: &mut Context<Self>) -> AnyElement {
        let Some(picker) = &self.picker else {
            return div().into_any_element();
        };
        let theme = self.theme();
        let mut panel = div()
            .id("tmux-picker")
            .size_full()
            .flex()
            .flex_col()
            .gap_1()
            .child(picker.search.clone());
        if picker.mode == Mode::Theme
            && let Some(a) = &self.browser_state.appearance
        {
            panel = panel.child(div().child(format!(
                "Applied: {}{}",
                a.selected,
                if a.selected == "system" {
                    match a.system {
                        super::appearance::System::Dark => " (dark)",
                        super::appearance::System::Light => " (light)",
                    }
                } else {
                    ""
                }
            )));
            if let Some(error) = &a.error {
                panel = panel.child(div().id("theme-picker-error").child(error.clone()));
            }
        }
        if let Some(error) = picker.error {
            panel = panel.child(div().id("theme-command-error").child(error));
        }
        let mut list = div()
            .id("picker-results")
            .flex_1()
            .min_h_0()
            .overflow_y_scroll()
            .track_scroll(&picker.scroll);
        for (index, row) in picker.rows.iter().enumerate() {
            let target = row.target.clone();
            list = list.child(
                div()
                    .id(("picker-row", index))
                    .px_2()
                    .py_1()
                    .rounded(px(4.))
                    .truncate()
                    .cursor_pointer()
                    .bg(rgb(if index == picker.selected {
                        theme.active
                    } else {
                        theme.surface
                    }))
                    .child(row.label.clone())
                    .on_click(cx.listener(move |view, _, window, cx| {
                        view.choose_picker(target.clone(), window, cx)
                    })),
            );
        }
        panel = panel.child(list);
        panel.into_any_element()
    }
}
#[cfg(test)]
mod tests;
