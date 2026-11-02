//! Presentation-only filters over the bounded published agent roster.
use super::*;
use crate::search_input::{Changed, SearchInput};
use bezel_ui::widgets::Controls as BezelControls;
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
    pub(super) actions: [FocusHandle; 5],
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
    /// What the session table shows: the left list's entry.
    pub(in crate::tmux_snapshot) fleet_view: fleet_nav::View,
    /// The left list's focus, for its arrow keys.
    pub(super) fleet_nav: FocusHandle,
    /// The session table's focus, for its arrow keys and Enter.
    pub(in crate::tmux_snapshot) fleet_table: FocusHandle,
    /// The table row the keyboard is on.
    pub(in crate::tmux_snapshot) table_cursor: Option<fleet_nav::RowKey>,
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
                fleet_view: fleet_nav::View::All,
                fleet_nav: cx.focus_handle(),
                fleet_table: cx.focus_handle(),
                table_cursor: None,
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
        if self.home_fleet_nav_key(event, window, cx) {
            return true;
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
    /// `[` and `]` anywhere on Home move the left list's selection, as do the
    /// arrows, Home and End while the list has focus; there → or Enter moves
    /// into the session table and Esc leaves the list. In the table the same
    /// keys move its cursor, Enter opens the cursor's session, F and D act on
    /// its row, and ← or Esc goes back to the list.
    fn home_fleet_nav_key(
        &mut self,
        event: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        let key = &event.keystroke;
        if self.browser_state.surface != browser::Surface::Home
            || self.browser_state.fleet.is_none()
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
        let Some(controls) = &mut self.home_filter else {
            return false;
        };
        let search = controls.search.read(cx);
        if search.focus.is_focused(window) || search.is_composing() {
            return false;
        }
        let list_focused = controls.fleet_nav.is_focused(window);
        let table_focused = controls.fleet_table.is_focused(window);
        let fleet = self.browser_state.fleet.as_ref();
        let current = fleet_nav::reconcile(&controls.fleet_view, fleet);
        let key = key.key.as_str();
        if table_focused && !matches!(key, "[" | "]") {
            match key {
                "left" | "escape" => controls.fleet_nav.clone().focus(window, cx),
                "enter" | "f" | "d" => {
                    if event.is_held {
                        return true;
                    }
                    let cursor =
                        fleet_nav::step_row(&current, fleet, controls.table_cursor.as_ref(), "");
                    let row = cursor.as_ref().and_then(|(group, session)| {
                        let group = fleet?.groups.iter().find(|g| &g.id == group)?;
                        Some((group, group.sessions.iter().find(|s| &s.id == session)?))
                    });
                    let request = self.browser_request;
                    // Enter opens the row's session, F toggles its favourite and
                    // D sends new sessions to its server: the row's buttons.
                    let act = row.and_then(|(group, session)| match key {
                        "enter" => session.selection.clone().map(RowAct::Open),
                        "f" => Some(RowAct::Favourite {
                            action: session.favorite_action.clone()?,
                            revision: fleet?.preferences.as_ref()?.revision,
                            favourite: !session.favorite,
                        }),
                        _ => group
                            .servers
                            .iter()
                            .find(|s| Some(&s.id) == session.server_id.as_ref())?
                            .selection
                            .clone()
                            .map(RowAct::UseServer),
                    });
                    controls.table_cursor = cursor;
                    match act {
                        Some(RowAct::Open(token)) => {
                            self.open_fleet_session(request, &token, window, cx)
                        }
                        Some(RowAct::Favourite {
                            action,
                            revision,
                            favourite,
                        }) => {
                            self.change_fleet_preference(request, revision, &action, favourite, cx)
                        }
                        Some(RowAct::UseServer(token)) => {
                            self.open_fleet_server(request, &token, window, cx)
                        }
                        None => {}
                    }
                }
                _ => {
                    let Some(next) =
                        fleet_nav::step_row(&current, fleet, controls.table_cursor.as_ref(), key)
                    else {
                        return false;
                    };
                    controls.table_cursor = Some(next);
                }
            }
        } else if list_focused && matches!(key, "right" | "enter") {
            // An empty table keeps the keyboard on the list; Enter here is
            // never the agent list's Enter.
            if !event.is_held
                && let Some(cursor) =
                    fleet_nav::step_row(&current, fleet, controls.table_cursor.as_ref(), "")
            {
                controls.table_cursor = Some(cursor);
                controls.fleet_table.clone().focus(window, cx);
            } else if key == "right" && !event.is_held {
                return false;
            }
        } else if list_focused && key == "escape" {
            self.terminal_focus.focus(window, cx);
        } else {
            if !matches!(key, "[" | "]") && !list_focused {
                return false;
            }
            let Some(next) = fleet_nav::step(&current, fleet, key) else {
                return false;
            };
            controls.fleet_view = next;
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
        let bezel = self.home_palette();
        let mut tabs = bezel.toggle_group().flex_wrap();
        for filter in [Filter::All, Filter::Working, Filter::Attention] {
            tabs = tabs.child(
                bezel
                    .toggle_group_item(filter.label(), controls.filter == filter)
                    .id(filter.label())
                    .debug_selector(move || format!("home-filter-{}", filter.label()))
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
            .gap(px(SPACE))
            .child(controls.search.clone())
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .items_center()
                    .gap(px(SPACE))
                    .child(self.home_machine_control(cx))
                    .child(tabs),
            )
            .child(
                div()
                    .debug_selector(|| "home-filter-hints".into())
                    .flex()
                    .flex_wrap()
                    .items_center()
                    .gap_x(px(SPACE * 1.5))
                    .gap_y(px(SPACE / 2.))
                    .text_color(bezel.text_muted)
                    .children(design::ink_probe(|| "home-filter-hints".into()))
                    .children(
                        HINTS
                            .iter()
                            .map(|&(cap, label)| key_hint(&bezel, cap, label)),
                    ),
            )
            .into_any_element()
    }
}

/// What a table key does to the cursor's row: the row's own controls.
enum RowAct {
    Open(String),
    Favourite {
        action: String,
        revision: u64,
        favourite: bool,
    },
    UseServer(String),
}

const HINTS: [(&str, &str); 7] = [
    ("↑↓", "Select"),
    ("Enter", "Open"),
    ("/", "Search"),
    ("0", "All"),
    ("W", "Working"),
    ("A", "Attention"),
    ("Esc", "Clear search"),
];

/// Bezel's `key_hint_text` (a keycap and its label), with both in Home's
/// inked muted; Bezel paints the cap at 70% and the label at 45% of muted.
fn key_hint(bezel: &bezel_theme::Theme, cap: &'static str, label: &'static str) -> Div {
    div()
        .flex()
        .flex_row()
        .items_center()
        .gap(px(5.))
        .child(
            bezel_ui::popover::key_cap(bezel)
                .text_style(TextStyle::Subheadline)
                .font_family(bezel.font_mono.clone())
                .text_color(bezel.text_muted)
                .children(design::ink_probe(move || format!("home-key-cap-{cap}")))
                .child(cap),
        )
        .child(
            div()
                .text_style(TextStyle::Caption)
                .text_color(bezel.text_muted)
                .children(design::ink_probe(move || format!("home-key-label-{label}")))
                .child(label),
        )
}
