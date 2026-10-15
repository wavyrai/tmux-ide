//! Presentation-only filters over the bounded published agent roster.
use super::*;
use crate::search_input::{Changed, SearchInput};
use browser::home_agents::{Phase, Roster, Row, Status};

#[derive(Clone, Copy, Default, PartialEq, Eq)]
pub(in crate::tmux_snapshot) enum Filter {
    #[default]
    All,
    Working,
    Attention,
}
impl Filter {
    fn label(self) -> &'static str {
        match self {
            Self::All => "All",
            Self::Working => "Working",
            Self::Attention => "Needs attention",
        }
    }
    pub(super) fn matches(self, roster: &Roster, row: &Row, query: &str) -> bool {
        row.matches_query(query)
            && match self {
                Self::All => true,
                Self::Working => {
                    matches!(roster.phase, Phase::Live | Phase::Partial)
                        && row.available
                        && matches!(row.status, Status::Working)
                }
                Self::Attention => {
                    row.attention || matches!(row.status, Status::Blocked | Status::Failed)
                }
            }
    }
}
pub(in crate::tmux_snapshot) struct Controls {
    pub(super) search: Entity<SearchInput>,
    pub(super) actions: [FocusHandle; 3],
    pub(super) filter: Filter,
    pub(super) selected: Option<String>,
    pub(super) recovery_queued: Option<(u64, u64)>,
    pub(super) recovery_error: bool,
    pub(super) preference_queued: Option<(u64, u64, u64)>,
    pub(super) preference_error: bool,
    pub(super) machine_queued: Option<(u64, u64)>,
    pub(super) machine_error: bool,
    pub(super) rendered_revision: Option<u64>,
    pub(super) visible: Vec<(String, bool)>,
    pub(super) scroll: ScrollHandle,
    pub(super) page_scroll: ScrollHandle,
    _changed: Subscription,
    theme: crate::config::Theme,
}
impl SnapshotView {
    pub(in crate::tmux_snapshot) fn prepare_home_filter(&mut self, cx: &mut Context<Self>) {
        let theme = self.theme();
        if self.home_filter.is_none() {
            let search = cx.new(|cx| {
                let mut input = SearchInput::new(cx).with_max_bytes(1024);
                input.set_placeholder("Search loaded agents…", cx);
                input.set_appearance(crate::config::Config::default().ui, theme.clone(), cx);
                input
            });
            let changed = cx.subscribe(&search, |_, _, _: &Changed, cx| cx.notify());
            self.home_filter = Some(Controls {
                search,
                actions: std::array::from_fn(|_| cx.focus_handle()),
                filter: Filter::All,
                selected: None,
                recovery_queued: None,
                recovery_error: false,
                preference_queued: None,
                preference_error: false,
                machine_queued: None,
                machine_error: false,
                rendered_revision: None,
                visible: Vec::new(),
                scroll: ScrollHandle::new(),
                page_scroll: ScrollHandle::new(),
                _changed: changed,
                theme: theme.clone(),
            });
        }
        if let Some(controls) = &mut self.home_filter
            && controls.theme != theme
        {
            controls.theme = theme.clone();
            controls.search.update(cx, |input, cx| {
                input.set_appearance(crate::config::Config::default().ui, theme, cx)
            });
        }
    }
    pub(in crate::tmux_snapshot) fn home_search_composing(
        &self,
        window: &Window,
        cx: &Context<Self>,
    ) -> bool {
        self.browser_state.surface == browser::Surface::Home
            && self.home_filter.as_ref().is_some_and(|c| {
                let input = c.search.read(cx);
                input.focus.is_focused(window) && input.is_composing()
            })
    }
    pub(in crate::tmux_snapshot) fn home_filter_key(
        &mut self,
        event: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        if self.home_action_key(event, window, cx) {
            return true;
        }
        // Enter/Space belong to GPUI's focused-button key-up activation. Other
        // Home agent shortcuts must not navigate behind a focused action either.
        if self.home_action_index(window).is_some() {
            return false;
        }
        let key = &event.keystroke;
        if self.browser_state.surface != browser::Surface::Home
            || self.browser_state.home_agents.is_none()
            || self.picker.is_some()
            || self.new_session.is_some()
            || self.pane_actions.is_some()
            || key.modifiers.platform
            || key.modifiers.control
            || key.modifiers.alt
            || key.modifiers.shift
        {
            return false;
        }
        self.prepare_home_filter(cx);
        if self.home_agent_key(event, window, cx) {
            return true;
        }
        if key.key == "f"
            && self.home_filter.as_ref().is_some_and(|c| {
                let input = c.search.read(cx);
                !input.focus.is_focused(window) && !input.is_composing()
            })
        {
            if !event.is_held
                && let Some(capability) = &self.browser_state.home_agent_filter
            {
                self.cycle_home_machine(self.browser_request, capability.revision, cx);
            }
            cx.stop_propagation();
            window.prevent_default();
            return true;
        }
        if matches!(key.key.as_str(), "r" | "m")
            && self.home_filter.as_ref().is_some_and(|c| {
                let input = c.search.read(cx);
                !input.focus.is_focused(window) && !input.is_composing()
            })
        {
            if !event.is_held
                && let Some(capability) = &self.browser_state.home_agent_recovery
            {
                let action = if key.key == "r" {
                    recovery::Action::Retry
                } else {
                    recovery::Action::LoadMore
                };
                self.recover_home_agents(self.browser_request, capability.revision, action, cx);
            }
            cx.stop_propagation();
            window.prevent_default();
            return true;
        }
        let Some(controls) = &mut self.home_filter else {
            return false;
        };
        let input = controls.search.read(cx);
        if input.focus.is_focused(window) {
            if key.key != "escape" || input.is_composing() {
                return false;
            }
            controls
                .search
                .update(cx, |input, cx| input.set_text_selected("", cx));
            self.terminal_focus.focus(window, cx);
        } else {
            match key.key.as_str() {
                "/" => controls.search.read(cx).focus.clone().focus(window, cx),
                "0" => controls.filter = Filter::All,
                "w" => controls.filter = Filter::Working,
                "a" if !event.is_held => {
                    controls.filter = if controls.filter == Filter::Attention {
                        Filter::All
                    } else {
                        Filter::Attention
                    }
                }
                "a" => {}
                _ => return false,
            }
        }
        cx.stop_propagation();
        window.prevent_default();
        cx.notify();
        true
    }
    pub(super) fn home_filter_controls(&self, cx: &mut Context<Self>) -> AnyElement {
        let Some(controls) = &self.home_filter else {
            return div().into_any_element();
        };
        let theme = self.theme();
        let mut tabs = div()
            .flex()
            .flex_wrap()
            .gap_2()
            .child(self.home_machine_control(cx));
        for filter in [Filter::All, Filter::Working, Filter::Attention] {
            tabs = tabs.child(
                div()
                    .id(filter.label())
                    .debug_selector(move || format!("home-filter-{}", filter.label()))
                    .px_3()
                    .py_1()
                    .rounded(px(4.))
                    .cursor_pointer()
                    .bg(rgb(if controls.filter == filter {
                        theme.active
                    } else {
                        theme.surface
                    }))
                    .child(filter.label())
                    .on_click(cx.listener(move |view, _, _, cx| {
                        if view.browser_state.surface == browser::Surface::Home
                            && let Some(controls) = &mut view.home_filter
                        {
                            controls.filter = filter;
                            cx.notify();
                        }
                    })),
            );
        }
        div()
            .w_full()
            .min_w_0()
            .flex()
            .flex_col()
            .gap_2()
            .child(controls.search.clone())
            .child(tabs)
            .child(
                div()
                    .text_sm()
                    .text_color(rgb(theme.muted))
                    .child("↑↓ Select · Enter Open · / Search · 0 All · W Working · A Attention · Esc Clear search"),
            )
            .into_any_element()
    }
}
