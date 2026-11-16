//! Home's session table as its own view, replayed from its last paint while
//! what it shows is unchanged (GUI perf plan, finding 2). A publication
//! re-renders `SnapshotView`; before, each one laid out every table row
//! again, whether or not the fleet had changed.
//!
//! The pattern is the sidebar's (`sidebar_view`): the view stays in
//! `SnapshotView`'s tree at its old place, mounted with the vendored GPUI's
//! `cached_isolated` while [`SnapshotView::home_fleet_key`] is unchanged. On
//! the frame the key changes it is drawn uncached. While an assistive client
//! is connected GPUI renders it on every frame, since a replayed view adds
//! no accessibility nodes. `SnapshotView` still builds the table's elements,
//! inside this view's render, so every handler and helper is unchanged.
//!
//! One thing the sidebar doesn't need: the table is as tall as its rows,
//! and a cached view is a box of a given size. So every fresh frame
//! measures the table, and the replayed one is given that height. The key
//! covers everything the height depends on, the page's width included.
use super::rows_window::RowWindow;
use crate::tmux_snapshot::{SnapshotView, browser};
use gpui::{prelude::*, *};
use std::{
    cell::Cell,
    hash::{DefaultHasher, Hash, Hasher},
    rc::Rc,
};

/// The table's view. Its render asks `SnapshotView` for the elements.
pub(in crate::tmux_snapshot) struct HomeFleetView {
    parent: WeakEntity<SnapshotView>,
}

/// The table's view, the key of what it last showed, and how tall that was.
#[derive(Default)]
pub(in crate::tmux_snapshot) struct Cache {
    view: Option<Entity<HomeFleetView>>,
    key: Option<u64>,
    height: Rc<Cell<Option<Pixels>>>,
}

#[cfg(test)]
impl Cache {
    /// The next frame draws the table uncached, laid out by its content.
    pub(in crate::tmux_snapshot) fn forget(&mut self) {
        self.key = None;
    }
}

#[cfg(test)]
thread_local! {
    static RENDERS: Cell<usize> = const { Cell::new(0) };
}
/// How often a table rendered on this thread, for tests.
#[cfg(test)]
pub(in crate::tmux_snapshot) fn renders() -> usize {
    RENDERS.with(Cell::get)
}

impl Render for HomeFleetView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        #[cfg(test)]
        RENDERS.with(|renders| renders.set(renders.get() + 1));
        let owner = cx.entity_id();
        self.parent
            .update(cx, |view, cx| {
                view.agent_animation.begin_render(owner);
                view.fleet_cards(window, cx)
            })
            .ok()
            .flatten()
            .unwrap_or_else(|| div().into_any_element())
    }
}

impl SnapshotView {
    /// The session table: replayed from its last paint unless its key
    /// changed, and drawn uncached on the frame it changes, so it is never a
    /// frame stale. `settling`: a Home entrance is still moving. `None`
    /// without a fleet.
    pub(super) fn fleet_element(
        &mut self,
        settling: bool,
        window: &Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        if self.browser_state.fleet.is_none() {
            self.fleet_view_hidden();
            return None;
        }
        if self.home_filter.is_none() {
            return self.fleet_cards(window, cx);
        }
        let key = self.home_fleet_key(settling, window, cx);
        let parent = cx.entity().downgrade();
        let controls = self.home_filter.as_ref()?;
        let watch = controls.rows.watch(&controls.page_scroll, cx.entity_id());
        let cache = &mut self.home_fleet;
        let view = cache
            .view
            .get_or_insert_with(|| cx.new(|_| HomeFleetView { parent }))
            .clone();
        // With an assistive client connected the vendored GPUI renders an
        // isolated view on every frame (a replayed one adds no accessibility
        // nodes), so that case needs nothing here.
        let fresh = cache.key.replace(key) != Some(key);
        // Tests read probes that only a fresh paint records.
        #[cfg(test)]
        let fresh = fresh
            || cx.has_global::<crate::tmux_snapshot::design::InkProbes>()
            || cx.has_global::<crate::tmux_snapshot::design::TextProbes>();
        let measured = cache.height.clone();
        let host = div().relative().w_full().min_w_0().child(watch);
        let Some(height) = measured.get().filter(|_| !fresh) else {
            // Laid out by its content, and measured for the frames after.
            return Some(
                host.child(AnyView::from(view))
                    .child(
                        canvas(
                            move |bounds, _, _| measured.set(Some(bounds.size.height)),
                            |_, _, _, _| {},
                        )
                        .absolute()
                        .size_full(),
                    )
                    .into_any_element(),
            );
        };
        Some(
            host.h(height)
                .flex_none()
                .child(view.cached_isolated(StyleRefinement::default().size_full()))
                .into_any_element(),
        )
    }

    /// Home's table is not on screen: its next showing is drawn afresh, and
    /// its agents' spinners stop.
    pub(in crate::tmux_snapshot) fn fleet_view_hidden(&mut self) {
        if let Some(view) = &self.home_fleet.view
            && self.home_fleet.key.take().is_some()
        {
            self.agent_animation.begin_render(view.entity_id());
        }
    }

    /// The key the table's paint is kept under: its [`Inputs`], hashed.
    pub(in crate::tmux_snapshot) fn home_fleet_key(
        &self,
        settling: bool,
        window: &Window,
        cx: &App,
    ) -> u64 {
        let mut hash = DefaultHasher::new();
        self.home_fleet_inputs(settling, window, cx).hash(&mut hash);
        hash.finish()
    }

    /// Everything the session table's render reads, one field per input.
    /// `fleet_view_tests` has a case for each field, and for each field of
    /// the catalog behind `catalog`.
    pub(in crate::tmux_snapshot) fn home_fleet_inputs(
        &self,
        settling: bool,
        window: &Window,
        cx: &App,
    ) -> Inputs {
        let state = &self.browser_state;
        let digest = |feed: &dyn Fn(&mut DefaultHasher)| {
            let mut hash = DefaultHasher::new();
            feed(&mut hash);
            hash.finish()
        };
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_secs() as i64);
        let controls = self.home_filter.as_ref();
        let slots = &self.agent_animation;
        Inputs {
            catalog: digest(&|hash| {
                if let Some(fleet) = &state.fleet {
                    fleet_hash(fleet, hash);
                }
            }),
            last_active: state
                .fleet
                .iter()
                .flat_map(|fleet| &fleet.groups)
                .flat_map(|group| &group.sessions)
                .map(|session| {
                    session
                        .last_activity
                        .map(|then| super::fleet_rows::last_active_step(now, then))
                })
                .collect(),
            away: state
                .fleet
                .iter()
                .flat_map(|fleet| &fleet.groups)
                .map(|group| format!("{:?}", self.machine_away(group)))
                .collect(),
            selected_server: state.selected_server.as_ref().map(|selected| {
                let browser::fleet::SelectedServer {
                    machine_id,
                    machine_label,
                    server_id,
                    generation,
                    label,
                } = selected;
                digest(&|hash| (machine_id, machine_label, server_id, generation, label).hash(hash))
            }),
            roster: state.home_agents.as_ref().map(|roster| {
                let browser::home_agents::Roster {
                    // Not shown: a republished roster with the same rows
                    // replays.
                    revision: _,
                    phase,
                    rows: _,
                    observed_sessions,
                    total_sessions,
                    truncated_sessions,
                    truncated_rows,
                    note,
                } = roster;
                digest(&|hash| {
                    (std::mem::discriminant(phase), note).hash(hash);
                    (
                        observed_sessions,
                        total_sessions,
                        truncated_sessions,
                        truncated_rows,
                    )
                        .hash(hash);
                })
            }),
            agents: digest(&|hash| {
                for agent in state.home_agents.iter().flat_map(|roster| &roster.rows) {
                    crate::tmux_snapshot::browser_ui::sidebar_view::agent_hash(agent, hash);
                }
            }),
            agents_last_known: state
                .home_agents
                .iter()
                .flat_map(|roster| &roster.rows)
                .map(|agent| self.agent_last_known(agent))
                .collect(),
            local_last_known: self.agents_shown_last_known(),
            request: self.browser_request,
            state_request: state.request,
            presence_revision: state.presence_revision,
            home: state.surface == browser::Surface::Home,
            connected: self.browser_commands.is_some(),
            presence_ready: self.presence.ready(),
            picker_closed: self.picker.is_none(),
            new_session_closed: self.new_session.is_none(),
            pane_actions_closed: self.pane_actions.is_none(),
            composing: !self.marked.is_empty(),
            view: controls.map(|controls| format!("{:?}", controls.fleet_view)),
            waiting_only: controls.is_some_and(|controls| controls.waiting_only),
            cursor: controls.and_then(|controls| controls.table_cursor.clone()),
            preference_queued: controls.and_then(|controls| controls.preference_queued),
            preference_error: controls.is_some_and(|controls| controls.preference_error),
            table_focused: controls.is_some_and(|controls| controls.fleet_table.is_focused(window)),
            rows_window: controls.map(|controls| controls.rows.key(&controls.page_scroll)),
            theme: format!("{:?}", self.theme()),
            canvas: self.canvas(),
            reduce_motion: cx.reduce_motion(),
            agent_motion: self.agent_motion(),
            spinner_attached: slots.attached(),
            // Without the overlay the glyphs themselves animate.
            spinner_frame: (!slots.attached()).then(|| slots.frame()),
            // An entrance moves every frame until it settles.
            moving: settling.then(|| cx.background_executor().now()),
        }
    }
}

/// What the session table's render reads. Its hash is the key.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(in crate::tmux_snapshot) struct Inputs {
    /// The fleet catalog: machines, servers, sessions and preferences.
    pub catalog: u64,
    /// The words each session's "last active" shows now.
    pub last_active: Vec<Option<(u8, i64)>>,
    /// Each machine's away state, by the connection's clock.
    pub away: Vec<String>,
    /// The server new sessions go to.
    pub selected_server: Option<u64>,
    /// The agent roster's phase, note and counts.
    pub roster: Option<u64>,
    /// The agents on the rows.
    pub agents: u64,
    /// Whether each agent's state may be old.
    pub agents_last_known: Vec<bool>,
    /// Whether this Mac's agents are marked last known.
    pub local_last_known: bool,
    /// The view's request, which every row's action carries.
    pub request: u64,
    /// The request the state answers.
    pub state_request: u64,
    pub presence_revision: u64,
    /// Home is the surface.
    pub home: bool,
    /// There is a bridge to send a press over.
    pub connected: bool,
    pub presence_ready: bool,
    pub picker_closed: bool,
    pub new_session_closed: bool,
    pub pane_actions_closed: bool,
    /// An input method is composing.
    pub composing: bool,
    /// All sessions, Favourites or a machine.
    pub view: Option<String>,
    pub waiting_only: bool,
    /// The keyboard's row.
    pub cursor: Option<super::fleet_nav::RowKey>,
    pub preference_queued: Option<(u64, u64, u64)>,
    pub preference_error: bool,
    pub table_focused: bool,
    /// Where each run of rows sat, and the page's visible part and offset.
    pub rows_window: Option<u64>,
    pub theme: String,
    pub canvas: u32,
    pub reduce_motion: bool,
    pub agent_motion: bool,
    pub spinner_attached: bool,
    pub spinner_frame: Option<usize>,
    /// The clock, while an entrance is moving.
    pub moving: Option<std::time::Instant>,
}

impl RowWindow {
    /// What the window of built rows depends on: where each run sat, and the
    /// page's visible part and scroll offset.
    fn key(&self, page: &ScrollHandle) -> u64 {
        let mut hash = DefaultHasher::new();
        let bits = |pixels: Pixels| f32::from(pixels).to_bits();
        let mut tops = self.tops();
        tops.sort_unstable_by_key(|(run, _)| *run);
        for (run, top) in tops {
            (run, bits(top)).hash(&mut hash);
        }
        let view = page.bounds();
        (
            bits(view.left()),
            bits(view.top()),
            bits(view.size.width),
            bits(view.size.height),
            bits(page.offset().y),
        )
            .hash(&mut hash);
        hash.finish()
    }
}

fn fleet_hash(fleet: &browser::fleet::Fleet, hash: &mut DefaultHasher) {
    let browser::fleet::Fleet {
        groups,
        preferences,
        omitted_groups,
    } = fleet;
    omitted_groups.hash(hash);
    if let Some(preferences) = preferences {
        let browser::fleet::Preferences {
            revision,
            phase,
            error,
        } = preferences;
        (revision, *phase as u8, error).hash(hash);
    }
    groups.len().hash(hash);
    for group in groups {
        let browser::fleet::Group {
            collapsed,
            collapse_action,
            id,
            label,
            state,
            diagnostic,
            conflict,
            retry,
            disconnect,
            // Read through `machine_away`, with the clock.
            away: _,
            omitted_sessions,
            sessions,
            servers,
            omitted_servers,
        } = group;
        (collapsed, collapse_action, id, label, *state as u8).hash(hash);
        (
            conflict,
            retry,
            disconnect,
            omitted_sessions,
            omitted_servers,
        )
            .hash(hash);
        diagnostic
            .as_ref()
            .and_then(|diagnostic| serde_json::to_string(diagnostic).ok())
            .hash(hash);
        servers.len().hash(hash);
        for server in servers {
            let browser::fleet::Server {
                id,
                label,
                state,
                generation,
                selection,
            } = server;
            (id, label, *state as u8, generation, selection).hash(hash);
        }
        sessions.len().hash(hash);
        for session in sessions {
            let browser::fleet::Session {
                server_id,
                favorite,
                favorite_action,
                active,
                id,
                name,
                pane_count,
                window_count,
                // Read through `last_active_step`, with the clock.
                last_activity: _,
                favicon,
                session_id,
                selection,
            } = session;
            (server_id, favorite, favorite_action, active, id, name).hash(hash);
            (pane_count, window_count, session_id, selection).hash(hash);
            favicon.as_ref().map(std::sync::Arc::as_ptr).hash(hash);
        }
    }
}

#[cfg(test)]
#[path = "fleet_view_tests.rs"]
mod tests;
