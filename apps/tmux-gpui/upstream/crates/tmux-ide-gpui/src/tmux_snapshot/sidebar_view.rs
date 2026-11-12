//! The sidebar (session list, Home row, status and footer) as its own view,
//! replayed from its last paint while what it shows is unchanged (GUI perf
//! plan, step 3). A terminal publication re-renders `SnapshotView`; before,
//! that laid out every sidebar row again, which with 30 sessions and 40
//! agents cost more than painting the terminal.
//!
//! A plain cached view is rendered again whenever a cached ancestor
//! re-renders, so the sidebar is mounted with the vendored GPUI's
//! `cached_isolated`: it stays in `SnapshotView`'s tree at its old place (so
//! paint order and the accessibility tree are as before), and is replayed
//! while [`SnapshotView::sidebar_key`] is unchanged. On the frame the key
//! changes it is drawn uncached. While an assistive client is connected an
//! isolated view renders on every frame, so the client reads the whole tree. `SnapshotView` still builds the sidebar's
//! elements, inside this view's render, so every handler and helper is
//! unchanged.
use super::{SIDEBAR_WIDTH, focus_ring, sidebar};
use crate::tmux_snapshot::{SnapshotView, browser};
use bezel_theme::{TextStyle, Typeset};
use gpui::{prelude::*, *};
use std::{
    cell::Cell,
    hash::{DefaultHasher, Hash, Hasher},
    rc::Rc,
};

/// The sidebar's view. Its render asks `SnapshotView` for the elements.
pub(in crate::tmux_snapshot) struct SidebarView {
    parent: WeakEntity<SnapshotView>,
}

/// The sidebar view and the key of what it last showed.
#[derive(Default)]
pub(in crate::tmux_snapshot) struct Cache {
    view: Option<Entity<SidebarView>>,
    key: Option<u64>,
    /// Whether the fade that shows the sidebar has ended. A paint carries the
    /// opacity of the frame that drew it, so the sidebar is drawn, not
    /// replayed, until then.
    faded_in: Rc<Cell<bool>>,
}

#[cfg(test)]
thread_local! {
    static RENDERS: Cell<usize> = const { Cell::new(0) };
}
/// How often a sidebar rendered on this thread, for tests.
#[cfg(test)]
pub(in crate::tmux_snapshot) fn renders(_: &App) -> usize {
    RENDERS.with(Cell::get)
}
impl Render for SidebarView {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        #[cfg(test)]
        RENDERS.with(|renders| renders.set(renders.get() + 1));
        let owner = cx.entity_id();
        // Hover washes ask their painter for the frames of their fade: that
        // must be this view, or those frames would replay it.
        let painter = bezel_motion::Painter::of(cx);
        self.parent
            .update(cx, |view, cx| {
                view.sidebar_viewport(owner, painter, cx).into_any_element()
            })
            .unwrap_or_else(|_| div().into_any_element())
    }
}

impl SnapshotView {
    /// The sidebar: replayed from its last paint unless its key changed, and
    /// drawn uncached on the frame it changes, so it is never a frame stale.
    pub(super) fn sidebar_element(
        &mut self,
        window: &Window,
        cx: &mut Context<Self>,
    ) -> Stateful<Div> {
        let key = self.sidebar_key(window, cx);
        let view = match &self.sidebar_view.view {
            Some(view) => view.clone(),
            None => {
                let parent = cx.entity().downgrade();
                let view = cx.new(|_| SidebarView { parent });
                self.sidebar_view.view = Some(view.clone());
                view
            }
        };
        let fresh =
            self.sidebar_view.key.replace(key) != Some(key) || !self.sidebar_view.faded_in.get();
        // Tests read probes that only a fresh paint records.
        #[cfg(test)]
        let fresh = fresh
            || cx.has_global::<crate::tmux_snapshot::design::InkProbes>()
            || cx.has_global::<crate::tmux_snapshot::design::TextProbes>();
        let content = if fresh {
            AnyView::from(view).into_any_element()
        } else {
            view.cached_isolated(StyleRefinement::default().size_full())
                .into_any_element()
        };
        div()
            .id("sidebar-host")
            .w(px(SIDEBAR_WIDTH))
            .h_full()
            .min_h_0()
            .flex_shrink_0()
            .child(content)
    }
}

impl SnapshotView {
    /// The sidebar is not in this frame. Its last paint is gone, and so are
    /// the spinner slots that paint reserved: only a render of the sidebar's
    /// own view would drop them, and none is coming.
    pub(super) fn sidebar_unmounted(&mut self) {
        self.sidebar_view.key = None;
        self.sidebar_view.faded_in.set(false);
        if let Some(view) = &self.sidebar_view.view {
            self.agent_animation.begin_render(view.entity_id());
        }
    }

    /// Fades the sidebar's column in when it is shown (#761), and records
    /// when the fade has ended.
    pub(super) fn sidebar_fade_in(&self, column: Stateful<Div>) -> impl IntoElement + use<> {
        let faded_in = self.sidebar_view.faded_in.clone();
        column.with_animation(
            "sidebar-in",
            bezel_motion::FADE_QUICK.animation(),
            move |column, t| {
                faded_in.set(t >= 1.);
                column.opacity(t)
            },
        )
    }

    /// Everything the sidebar shows, hashed. Each input the sidebar's render
    /// reads must be here; `sidebar_view_tests` pins that a change to each one
    /// redraws it, and that a cached frame paints what a fresh one would.
    pub(in crate::tmux_snapshot) fn sidebar_key(&self, window: &Window, cx: &App) -> u64 {
        let mut hash = DefaultHasher::new();
        let state = &self.browser_state;
        let now = (self.connection.clock)().0;
        // The rows, as the render resolves them.
        let local_last_known = self.agents_shown_last_known();
        for row in sidebar::rows_at(state, now) {
            row_hash(&row, &mut hash);
            if let Some((action, favorite)) = &row.favorite {
                self.preference_button_enabled(action.as_deref(), !*favorite)
                    .hash(&mut hash);
            }
            let agent = row
                .agent
                .as_ref()
                .and_then(|key| sidebar::activity::row_agent(state, key));
            let pane = row
                .pane
                .as_deref()
                .and_then(|pane| sidebar::panes::pane_agent(state, pane));
            for (agent, unavailable) in [agent, pane].into_iter().flatten() {
                agent_hash(agent, &mut hash);
                unavailable.hash(&mut hash);
                self.agent_last_known(agent).hash(&mut hash);
            }
        }
        local_last_known.hash(&mut hash);
        // The Home row.
        (state.surface == browser::Surface::Home).hash(&mut hash);
        for agent in sidebar::pane_row::waiting_rows(state) {
            agent_hash(agent, &mut hash);
            self.agent_last_known(agent).hash(&mut hash);
        }
        // Keyboard navigation, focus and the controls' availability.
        let keyboard = &self.sidebar_keyboard;
        (keyboard.active, &keyboard.selected, keyboard.request).hash(&mut hash);
        self.sidebar_keyboard_allowed().hash(&mut hash);
        self.sidebar_control_index(window).hash(&mut hash);
        keyboard
            .focus
            .as_ref()
            .map(|focus| focus.is_focused(window))
            .hash(&mut hash);
        self.sidebar_footer_current(self.browser_request)
            .hash(&mut hash);
        (self.browser_request, state.appearance.is_some()).hash(&mut hash);
        self.local_session_available().hash(&mut hash);
        // The preference status line.
        self.fleet_preference_status()
            .map(|status| status.message().to_owned())
            .hash(&mut hash);
        // The footer's connection slot, which reads the watch's clock.
        self.connection_stage().hash(&mut hash);
        self.connection_words().hash(&mut hash);
        crate::tmux_snapshot::connection::card(state, self.browser_commands.is_some())
            .hash(&mut hash);
        // A reveal moves the list by its scroll handle, outside any render.
        let offset = self.sidebar_keyboard.scroll.offset();
        (f32::from(offset.x).to_bits(), f32::from(offset.y).to_bits()).hash(&mut hash);
        // Theme, translucency, motion and the agent spinner.
        format!("{:?}", self.theme()).hash(&mut hash);
        self.chrome.allowed().hash(&mut hash);
        cx.reduce_motion().hash(&mut hash);
        self.agent_motion().hash(&mut hash);
        let slots = &self.agent_animation;
        slots.attached().hash(&mut hash);
        // Without the overlay the glyphs themselves animate.
        if !slots.attached() {
            slots.frame().hash(&mut hash);
        }
        hash.finish()
    }

    /// The sidebar's elements, built inside [`SidebarView`]'s render.
    fn sidebar_viewport(
        &mut self,
        owner: EntityId,
        painter: bezel_motion::Painter,
        cx: &mut Context<Self>,
    ) -> Stateful<Div> {
        self.agent_animation.begin_render(owner);
        let theme = self.theme();
        let bezel = bezel_theme::Theme::of(cx).clone();
        let mut sidebar = div()
            .id("session-list")
            .debug_selector(|| "session-list".into())
            .when_some(self.sidebar_keyboard.focus.as_ref(), |list, focus| {
                list.track_focus(focus)
            })
            .w_full()
            .flex_1()
            .min_h_0()
            .p(px(bezel_theme::Theme::SPACE))
            .flex()
            .flex_col()
            // Rows sit 2 pt apart, as in the mockup (#746 v3).
            .gap(px(2.));
        sidebar = sidebar.child(self.sidebar_home_row(painter, cx));
        let request = self.browser_request;
        let now = (self.connection.clock)().0;
        let local_last_known = self.agents_shown_last_known();
        for (index, mut row) in sidebar::rows_at(&self.browser_state, now)
            .into_iter()
            .enumerate()
        {
            // #362: agent state on this row may be old: this Mac's lane is
            // marked, or the row's machine (or its agent's) is away.
            row.last_known = local_last_known
                || row.away
                || row.agent.as_ref().is_some_and(|key| {
                    sidebar::activity::row_agent(&self.browser_state, key)
                        .is_some_and(|(agent, _)| self.agent_last_known(agent))
                })
                || row.pane.as_deref().is_some_and(|pane| {
                    sidebar::panes::pane_agent(&self.browser_state, pane)
                        .is_some_and(|(agent, _)| self.agent_last_known(agent))
                });
            let mut element = sidebar::render_row(
                index,
                &row,
                &theme,
                &bezel,
                painter,
                self.sidebar_keyboard.active,
            )
            .map(|element| {
                focus_ring(
                    element,
                    self.sidebar_keyboard.active
                        && row.target.as_ref().is_some_and(|target| {
                            Some(target) == self.sidebar_keyboard.selected.as_ref()
                        }),
                    &bezel,
                )
            });
            // What a screen reader says: the row and its agent's state.
            let state = row
                .pane
                .as_deref()
                .and_then(|pane| sidebar::panes::pane_agent(&self.browser_state, pane))
                .or_else(|| sidebar::activity::row_agent(&self.browser_state, row.agent.as_ref()?))
                .map(|(agent, unavailable)| {
                    crate::tmux_snapshot::agent_indicator::state_label(agent, unavailable)
                });
            element = sidebar::pane_row::spoken(element, &row, state);
            if let Some((agent, unavailable)) = row
                .agent
                .as_ref()
                .and_then(|key| sidebar::activity::row_agent(&self.browser_state, key))
            {
                element = element.children(self.agent_state(
                    agent,
                    unavailable,
                    crate::tmux_snapshot::agent_indicator::Plate::Sidebar,
                    row.last_known,
                ));
            }
            if let Some(pane) = &row.pane {
                element = self.sidebar_pane_row(element, index, pane, cx);
            }
            if let Some((action, favorite)) = &row.favorite {
                element = element.child(
                    div()
                        .when(!*favorite && !self.sidebar_keyboard.active, |d| {
                            d.opacity(0.)
                                .group_hover("session-sidebar-row", |s| s.opacity(1.))
                        })
                        .child(self.fleet_preference_button(
                            ("sidebar-favorite", index),
                            action.as_deref(),
                            !*favorite,
                            if *favorite {
                                "Remove favorite"
                            } else {
                                "Add favorite"
                            },
                            if *favorite {
                                "icons/fleet-star-filled.svg"
                            } else {
                                "icons/fleet-star.svg"
                            },
                            cx,
                        )),
                );
            }
            if let Some(target) = row.target {
                element =
                    element
                        .cursor_pointer()
                        .on_click(cx.listener(move |view, _, window, cx| {
                            view.select_sidebar(request, &target, window, cx);
                        }));
            }
            sidebar = sidebar.child(element);
        }
        if let Some(status) = self.fleet_preference_status() {
            sidebar = sidebar.child(
                div()
                    .text_style(TextStyle::Callout)
                    .text_color(bezel.text_muted)
                    .children(crate::tmux_snapshot::design::ink_probe(|| {
                        "sidebar-status".into()
                    }))
                    .child(status.message().to_owned()),
            );
        }
        div()
            .id("sidebar-viewport")
            .debug_selector(|| "tmux-sidebar-viewport".into())
            .relative()
            .w(px(SIDEBAR_WIDTH))
            .h_full()
            .min_h_0()
            .flex_shrink_0()
            .overflow_hidden()
            .flex()
            .flex_col()
            .child(
                bezel_ui::scroll::Viewport::new("session-list", sidebar, Axis::Vertical)
                    .track_scroll(&self.sidebar_keyboard.scroll)
                    .fill(),
            )
            .child(self.sidebar_footer(cx))
    }
}

fn row_hash(row: &sidebar::Row, hash: &mut DefaultHasher) {
    let sidebar::Row {
        label,
        pane_count,
        selected,
        target,
        depth,
        machine,
        agent,
        icon,
        favorite,
        summary,
        attention,
        kind,
        favicon,
        aside,
        pane,
        away,
        last_known,
    } = row;
    (
        label, pane_count, selected, target, depth, machine, agent, icon,
    )
        .hash(hash);
    (
        favorite, summary, attention, kind, aside, pane, away, last_known,
    )
        .hash(hash);
    favicon.as_ref().map(std::sync::Arc::as_ptr).hash(hash);
}

pub(in crate::tmux_snapshot) fn agent_hash(
    agent: &browser::home_agents::Row,
    hash: &mut DefaultHasher,
) {
    let browser::home_agents::Row {
        key,
        session_id,
        pane_id,
        name,
        session_label,
        machine_label,
        machine,
        server_label,
        project_name,
        harness,
        team_name,
        status,
        attention,
        available,
    } = agent;
    (
        key,
        session_id,
        pane_id,
        name,
        session_label,
        machine_label,
        machine,
    )
        .hash(hash);
    (
        server_label,
        project_name,
        harness,
        team_name,
        attention,
        available,
    )
        .hash(hash);
    status.hash(hash);
}

#[cfg(test)]
#[path = "sidebar_view_tests.rs"]
mod tests;
