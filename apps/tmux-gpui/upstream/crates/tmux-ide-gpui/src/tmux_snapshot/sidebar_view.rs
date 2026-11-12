//! The sidebar (session list, Home row, status and footer) as its own view,
//! replayed from its last paint while what it shows is unchanged (GUI perf
//! plan, step 3). A terminal publication re-renders `SnapshotView`; before,
//! that laid out every sidebar row again, which with 30 sessions and 40
//! agents cost more than painting the terminal.
//!
//! GPUI re-renders every cached view below a cached view that re-renders, so
//! the sidebar cannot be a child of `SnapshotView`. It is a sibling at the
//! window root instead: `SnapshotView` lays out an empty slot where the
//! sidebar goes and records the slot's bounds; the root's [`Host`] then
//! prepaints [`SidebarView`] into those bounds, after `SnapshotView`, so it
//! sees this frame's state and slot. `SnapshotView` still builds the
//! sidebar's elements inside this view's render, so every handler and helper
//! is unchanged. Overlays that cover the sidebar are deferred, so they paint
//! over it as before.
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
    /// The key of what it last painted, and the `SnapshotView` render it
    /// was computed after.
    key: Option<(u64, u64)>,
}
impl SidebarView {
    pub(in crate::tmux_snapshot) fn new(parent: WeakEntity<SnapshotView>) -> Self {
        Self { parent, key: None }
    }
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
        self.parent
            .update(cx, |view, cx| {
                // The sidebar fades in when shown (#761), as its column does.
                bezel_motion::fade_quick("sidebar-in", view.sidebar_viewport(owner, cx))
                    .into_any_element()
            })
            .unwrap_or_else(|_| div().into_any_element())
    }
}

/// Where `SnapshotView` laid out the sidebar this frame, for the root's
/// [`Host`] to draw it in.
#[derive(Default)]
pub(in crate::tmux_snapshot) struct Slot {
    /// `None` while the sidebar is hidden.
    bounds: Rc<Cell<Option<Bounds<Pixels>>>>,
    /// Mounted under a window root with a [`Host`]. Views mounted on their
    /// own (tests) draw the sidebar inline, as before.
    hosted: Cell<bool>,
    /// `SnapshotView` renders so far: while it has not rendered, nothing the
    /// sidebar shows has changed, and the key need not be computed again.
    renders: Cell<u64>,
}
impl Slot {
    /// Called by the window root that draws the sidebar.
    pub(in crate::tmux_snapshot) fn host(&self) {
        self.hosted.set(true);
    }
}

impl SnapshotView {
    /// The sidebar's place in the window: an empty slot the root draws it
    /// into, or, with no root to draw it, the sidebar itself.
    pub(super) fn sidebar_placement(&mut self, cx: &mut Context<Self>) -> Stateful<Div> {
        self.sidebar_slot.bounds.set(None);
        let renders = &self.sidebar_slot.renders;
        renders.set(renders.get() + 1);
        if self.sidebar_slot.hosted.get() {
            self.sidebar_slot()
        } else {
            self.sidebar_viewport(cx.entity_id(), cx)
        }
    }

    /// The empty slot the sidebar is drawn into, recording its bounds.
    fn sidebar_slot(&self) -> Stateful<Div> {
        let slot = self.sidebar_slot.bounds.clone();
        div()
            .id("sidebar-slot")
            .w(px(SIDEBAR_WIDTH))
            .h_full()
            .min_h_0()
            .flex_shrink_0()
            .child(canvas(move |bounds, _, _| slot.set(Some(bounds)), |_, (), _, _| {}).size_full())
    }
}

/// The root's element that draws the sidebar into `SnapshotView`'s slot,
/// cached unless [`SnapshotView::sidebar_key`] changed.
pub(in crate::tmux_snapshot) struct Host {
    pub snapshot: Entity<SnapshotView>,
    pub sidebar: Entity<SidebarView>,
}
impl IntoElement for Host {
    type Element = Self;
    fn into_element(self) -> Self {
        self
    }
}
impl Element for Host {
    type RequestLayoutState = ();
    type PrepaintState = Option<AnyElement>;
    fn id(&self) -> Option<ElementId> {
        None
    }
    fn source_location(&self) -> Option<&'static std::panic::Location<'static>> {
        None
    }
    fn request_layout(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, ()) {
        let style = Style {
            position: Position::Absolute,
            ..Default::default()
        };
        (window.request_layout(style, None, cx), ())
    }
    fn prepaint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        _: Bounds<Pixels>,
        _: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) -> Option<AnyElement> {
        let snapshot = self.snapshot.read(cx);
        let bounds = snapshot.sidebar_slot.bounds.get()?;
        let renders = snapshot.sidebar_slot.renders.get();
        // A spinner tick, or a frame only the sidebar itself dirtied, leaves
        // `SnapshotView` unrendered: its state, and so the key, stand.
        let fresh = match self.sidebar.read(cx).key {
            Some((_, seen)) if seen == renders => false,
            _ => {
                let key = snapshot.sidebar_key(window, cx);
                self.sidebar
                    .update(cx, |view, _| view.key.replace((key, renders)))
                    .is_none_or(|(old, _)| old != key)
            }
        };
        // Tests read probes that only a fresh paint records.
        #[cfg(test)]
        let fresh = fresh
            || cx.has_global::<crate::tmux_snapshot::design::InkProbes>()
            || cx.has_global::<crate::tmux_snapshot::design::TextProbes>();
        let mut element = if fresh {
            AnyView::from(self.sidebar.clone()).into_any_element()
        } else {
            self.sidebar
                .clone()
                .cached(StyleRefinement::default().size_full())
                .into_any_element()
        };
        element.layout_as_root(bounds.size.into(), window, cx);
        element.prepaint_at(bounds.origin, window, cx);
        Some(element)
    }
    fn paint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        _: Bounds<Pixels>,
        _: &mut (),
        element: &mut Option<AnyElement>,
        window: &mut Window,
        cx: &mut App,
    ) {
        if let Some(element) = element {
            element.paint(window, cx);
        }
    }
}

impl SnapshotView {
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
    fn sidebar_viewport(&mut self, owner: EntityId, cx: &mut Context<Self>) -> Stateful<Div> {
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
        sidebar = sidebar.child(self.sidebar_home_row(cx));
        let request = self.browser_request;
        let painter = bezel_motion::Painter::of(cx);
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

fn agent_hash(agent: &browser::home_agents::Row, hash: &mut DefaultHasher) {
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
