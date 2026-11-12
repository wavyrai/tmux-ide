//! Home's session table as its own view, replayed from its last paint while
//! what it shows is unchanged (GUI perf plan, finding 2). A publication
//! re-renders `SnapshotView`; before, each one laid out every table row
//! again, whether or not the fleet had changed.
//!
//! The pattern is the sidebar's (`sidebar_view`): the view stays in
//! `SnapshotView`'s tree at its old place, mounted with the vendored GPUI's
//! `cached_isolated` while [`SnapshotView::home_fleet_key`] is unchanged. On
//! the frame the key changes it is drawn uncached, and so it is on every
//! frame while an assistive client is connected (a replayed view adds no
//! accessibility nodes). `SnapshotView` still builds the table's elements,
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
        // A replayed view prepaints no elements, and the accessibility tree
        // is built from those: with a client connected, draw every frame.
        let fresh = cache.key.replace(key) != Some(key) || window.is_a11y_active();
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

    /// Everything the session table shows, hashed. Each input its render
    /// reads must be here; `fleet_view_tests` pins that a change to each one
    /// redraws it, and that a replayed frame paints what a fresh one would.
    pub(in crate::tmux_snapshot) fn home_fleet_key(
        &self,
        settling: bool,
        window: &Window,
        cx: &App,
    ) -> u64 {
        let mut hash = DefaultHasher::new();
        let state = &self.browser_state;
        // The catalog, and what the clocks make of it: "last active" by the
        // minute, and a machine that has been away for a while.
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_secs() as i64);
        if let Some(fleet) = &state.fleet {
            fleet_hash(fleet, now, &mut hash);
            for group in &fleet.groups {
                format!("{:?}", self.machine_away(group)).hash(&mut hash);
            }
        }
        if let Some(selected) = &state.selected_server {
            let browser::fleet::SelectedServer {
                machine_id,
                machine_label,
                server_id,
                generation,
                label,
            } = selected;
            (machine_id, machine_label, server_id, generation, label).hash(&mut hash);
        }
        // The agents on the rows, and whether their state may be old.
        self.agents_shown_last_known().hash(&mut hash);
        if let Some(roster) = &state.home_agents {
            let browser::home_agents::Roster {
                // Not shown: a republished roster with the same rows replays.
                revision: _,
                phase,
                rows,
                observed_sessions,
                total_sessions,
                truncated_sessions,
                truncated_rows,
                note,
            } = roster;
            (std::mem::discriminant(phase), note).hash(&mut hash);
            (
                observed_sessions,
                total_sessions,
                truncated_sessions,
                truncated_rows,
            )
                .hash(&mut hash);
            for agent in rows {
                crate::tmux_snapshot::browser_ui::sidebar_view::agent_hash(agent, &mut hash);
                self.agent_last_known(agent).hash(&mut hash);
            }
        }
        // What decides whether a row or a preference button takes a press.
        (self.browser_request, state.request, state.presence_revision).hash(&mut hash);
        (state.surface == browser::Surface::Home).hash(&mut hash);
        (self.browser_commands.is_some(), self.presence.ready()).hash(&mut hash);
        (
            self.picker.is_none(),
            self.new_session.is_none(),
            self.pane_actions.is_none(),
            self.marked.is_empty(),
        )
            .hash(&mut hash);
        // Home's own controls: the view, the filter, the keyboard row, the
        // queued preference, and where the page shows the table.
        if let Some(controls) = &self.home_filter {
            format!("{:?}", controls.fleet_view).hash(&mut hash);
            (controls.waiting_only, &controls.table_cursor).hash(&mut hash);
            (controls.preference_queued, controls.preference_error).hash(&mut hash);
            controls.fleet_table.is_focused(window).hash(&mut hash);
            controls.rows.key(&controls.page_scroll, &mut hash);
        }
        // Theme, motion and the agent spinner.
        format!("{:?}", self.theme()).hash(&mut hash);
        self.canvas().hash(&mut hash);
        cx.reduce_motion().hash(&mut hash);
        self.agent_motion().hash(&mut hash);
        let slots = &self.agent_animation;
        slots.attached().hash(&mut hash);
        // Without the overlay the glyphs themselves animate.
        if !slots.attached() {
            slots.frame().hash(&mut hash);
        }
        // An entrance moves every frame until it settles.
        settling.hash(&mut hash);
        if settling {
            cx.background_executor().now().hash(&mut hash);
        }
        hash.finish()
    }
}

impl RowWindow {
    /// What the window of built rows depends on: where each run sat, and the
    /// page's visible part and scroll offset.
    fn key(&self, page: &ScrollHandle, hash: &mut DefaultHasher) {
        let bits = |pixels: Pixels| f32::from(pixels).to_bits();
        let mut tops = self.tops();
        tops.sort_unstable_by_key(|(run, _)| *run);
        for (run, top) in tops {
            (run, bits(top)).hash(hash);
        }
        let view = page.bounds();
        (
            bits(view.left()),
            bits(view.top()),
            bits(view.size.width),
            bits(view.size.height),
            bits(page.offset().y),
        )
            .hash(hash);
    }
}

fn fleet_hash(fleet: &browser::fleet::Fleet, now: i64, hash: &mut DefaultHasher) {
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
                last_activity,
                favicon,
                session_id,
                selection,
            } = session;
            (server_id, favorite, favorite_action, active, id, name).hash(hash);
            (pane_count, window_count, session_id, selection).hash(hash);
            // "Last active" reads in whole minutes at its finest.
            last_activity
                .map(|then| (now - then).max(0) / 60)
                .hash(hash);
            favicon.as_ref().map(std::sync::Arc::as_ptr).hash(hash);
        }
    }
}

#[cfg(test)]
#[path = "fleet_view_tests.rs"]
mod tests;
