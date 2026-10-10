//! A client connection per editor group that shows a terminal.
//!
//! The daemon keeps a focused tab and projects a surface per client, so each
//! group showing a Herdr tab needs its own connection to the daemon. The
//! group in use holds the window's own connection, the selected endpoint's
//! `ConnectionBridge`, so keys, IME, the mouse, paste, drops, and navigation
//! keep their one path and its fences. Every other terminal group holds a
//! parked connection: it only displays its tab, reports itself unfocused so
//! it never becomes the daemon's foreground client, drops the notifications
//! every connection receives, and focuses its own tab again when something
//! moves it. Using a parked group swaps its connection with the window's.
//!
//! Parked connections belong to the focused workspace of the selected
//! endpoint. Leaving either, or closing the group, drops them; dropping a
//! bridge only asks its worker to stop, so the UI thread never waits on it.

use crate::{
    HerdrWindow,
    browser::{GroupId, Pick, Scope, Shown, Slot},
    connection::ConnectionBridge,
    presentation::{Picture, Presentation},
    state::{ConnectionStatus, LiveState},
    terminal::{popup_origin, viewport},
    terminal_painter::{ImageTarget, PlacedImages},
};
use gpui::{prelude::*, *};
use herdr_client::{ConnectOptions, Method};
use serde_json::json;
use std::time::{Duration, Instant};

/// How long a parked connection waits for its tab before asking again.
const REFOCUS_AFTER: Duration = Duration::from_secs(1);
/// How long a group whose connection failed waits before another attempt.
const RETRY_AFTER: Duration = Duration::from_secs(2);
/// Resizes settle for as long as the window's own do.
const RESIZE_SETTLE: Duration = Duration::from_millis(150);
/// A frame another client took is re-claimed more slowly than a settled
/// resize, so the request is not resent while the daemon answers it.
const RESIZE_REASSERT: Duration = Duration::from_secs(1);

/// A terminal group's connection while another group has the keyboard.
struct Parked {
    group: GroupId,
    workspace: (Scope, String),
    connection: ConnectionBridge,
    live: LiveState,
    presentation: Presentation,
    options: ConnectOptions,
    last_queued_options: Option<ConnectOptions>,
    pending_resize: Option<(ConnectOptions, Instant)>,
    bounds: Bounds<Pixels>,
    /// Whether the daemon was told this client is unfocused.
    unfocused: bool,
    /// The tab last asked for, and when.
    asked: Option<(String, Instant)>,
}

impl Parked {
    fn connected(&self) -> bool {
        self.connection.handle.is_some()
            && self.live.status.is_connected()
            && self.live.snapshot.is_some()
    }

    /// Whether the daemon's frame is the size this connection asked for.
    /// Another client resizing the tab leaves the request stale even when
    /// the connection's own options did not change.
    fn surface_size_stale(&self) -> bool {
        self.live.surface.as_ref().is_some_and(|surface| {
            surface.frame.width != self.options.surface_size.cols
                || surface.frame.height != self.options.surface_size.rows
        })
    }

    /// The tab this connection focuses, when it is in `workspace`.
    fn focused_tab(&self) -> Option<&str> {
        let snapshot = self.live.snapshot.as_ref()?;
        (snapshot.focused_workspace_id.as_deref() == Some(self.workspace.1.as_str()))
            .then_some(snapshot.focused_tab_id.as_deref())
            .flatten()
    }

    /// Moves this connection toward `tab` and keeps the daemon's view of it
    /// in step. Returns whether its state changed.
    fn steer(&mut self, tab: &str, now: Instant) {
        let (Some(handle), Some(snapshot)) = (&self.connection.handle, &self.live.snapshot) else {
            return;
        };
        let boot = snapshot.boot_id.clone();
        if !self.unfocused && handle.set_focus(&boot, false).is_ok() {
            self.unfocused = true;
        }
        let on_tab = self.focused_tab() == Some(tab);
        let asked_recently = self
            .asked
            .as_ref()
            .is_some_and(|(asked, at)| asked == tab && now.duration_since(*at) < REFOCUS_AFTER);
        if !on_tab
            && !asked_recently
            && handle
                .request(&boot, Method::TabFocus, json!({"tab_id": tab}))
                .is_ok()
        {
            self.asked = Some((tab.to_owned(), now));
        }
        let changed = self.last_queued_options != Some(self.options);
        if self.last_queued_options == Some(self.options) && !self.surface_size_stale() {
            self.pending_resize = None;
            return;
        }
        match self.pending_resize {
            Some((options, since)) if options == self.options => {
                let wait = if changed {
                    RESIZE_SETTLE
                } else {
                    RESIZE_REASSERT
                };
                if now.duration_since(since) >= wait && handle.resize(&boot, self.options).is_ok() {
                    self.last_queued_options = Some(self.options);
                    self.pending_resize = None;
                }
            }
            _ => self.pending_resize = Some((self.options, now)),
        }
    }
}

/// One window's terminal groups and their connections.
#[derive(Default)]
pub(crate) struct GroupTerminals {
    /// The group holding the window's own connection.
    primary: Option<GroupId>,
    parked: Vec<Parked>,
    /// Groups whose connection failed, and when they may try again.
    retry: Vec<(GroupId, Instant)>,
}

impl HerdrWindow {
    /// The group holding the window's own connection: the one keys go to
    /// while it shows a terminal.
    pub(crate) fn primary_group(&self) -> Option<GroupId> {
        let slots = self.group_slots();
        self.browser
            .terminals
            .primary
            .filter(|group| slots.iter().any(|slot| slot.id == *group))
            .or_else(|| self.active_group())
    }

    /// The tab `group`'s own connection focuses.
    pub(crate) fn group_focused_tab(&self, group: GroupId) -> Option<String> {
        if Some(group) == self.primary_group() {
            return self.focused_herdr_tab().map(str::to_owned);
        }
        let key = self.browser_key()?;
        self.browser
            .terminals
            .parked
            .iter()
            .find(|parked| parked.group == group && parked.workspace == key)
            .and_then(Parked::focused_tab)
            .map(str::to_owned)
    }

    /// Whether a parked connection already shows `tab`.
    pub(crate) fn parked_focuses(&self, tab: &str) -> bool {
        self.browser
            .terminals
            .parked
            .iter()
            .any(|parked| parked.focused_tab() == Some(tab))
    }

    /// Whether `group` has a connection of its own on its way to its tab.
    pub(crate) fn group_connecting(&self, group: GroupId) -> bool {
        self.browser
            .terminals
            .parked
            .iter()
            .any(|parked| parked.group == group)
    }

    /// Parked connections are clients of their own, each told the theme.
    pub(crate) fn sync_group_host_theme(&self, theme: &herdr_client::HostTheme) {
        for parked in &self.browser.terminals.parked {
            parked.connection.sync_host_theme(&parked.live, theme);
        }
    }

    /// Cheap enough for every display frame.
    pub(crate) fn group_terminals_updated(&self) -> bool {
        self.browser
            .terminals
            .parked
            .iter()
            .any(|parked| parked.connection.has_update())
    }

    /// Settles which group holds the window's connection and which hold
    /// parked ones, after a tick or a group being used.
    pub(crate) fn reconcile_group_terminals(&mut self, cx: &mut Context<Self>) {
        let Some(key) = self.browser_key() else {
            self.drop_group_terminals();
            return;
        };
        let slots = self.group_slots();
        let focused = self.focused_herdr_tab().map(str::to_owned);
        let active = self.active_group();
        let pick = |this: &Self, group| this.group_pick(group);
        // The group in use takes the window's connection: at once when that
        // connection already shows its tab, as after a split, and by swapping
        // when the group has a parked connection of its own.
        if let Some(active) = active {
            let wants = pick(self, active);
            let primary = self.browser.terminals.primary;
            if focused.is_some() && wants == focused.clone().map(Pick::Herdr) {
                self.browser.terminals.primary = Some(active);
            } else if primary != Some(active)
                && matches!(wants, Some(Pick::Herdr(_)))
                && self.browser.terminals.parked.iter().any(|parked| {
                    parked.group == active && parked.workspace == key && parked.connected()
                })
            {
                self.swap_primary(active, &key, cx);
                // The connection may still be on its way to the group's tab;
                // the window's navigation takes it the rest of the way.
                if let Some(Pick::Herdr(tab)) = wants
                    && self.focused_herdr_tab() != Some(tab.as_str())
                {
                    if self.navigation_ready() {
                        self.navigate(crate::NavigationTarget::Tab(&tab), cx);
                    } else {
                        self.pending_navigation = Some(crate::NavigationTarget::Tab(tab));
                    }
                }
                cx.notify();
            }
        }
        if self
            .browser
            .terminals
            .primary
            .is_none_or(|group| !slots.iter().any(|slot| slot.id == group))
        {
            self.browser.terminals.primary = active;
        }
        self.steer_restored(&key, cx);
        let primary = self.browser.terminals.primary;
        let focused = self.focused_herdr_tab().map(str::to_owned);
        // Every other group holding a Herdr tab needs a connection of its own.
        // The tab the window's connection shows is left to it: two clients on
        // one tab would fight over its size.
        let needed: Vec<(GroupId, String)> = self
            .ensure_layout()
            .map(|layout| layout.terminal_holders())
            .unwrap_or_default()
            .into_iter()
            .filter(|(group, tab)| Some(*group) != primary && Some(tab) != focused.as_ref())
            .collect();
        let now = Instant::now();
        let terminals = &mut self.browser.terminals;
        terminals.parked.retain(|parked| {
            parked.workspace == key && needed.iter().any(|(group, _)| *group == parked.group)
        });
        terminals.retry.retain(|(_, at)| now < *at);
        let target = self.endpoints[self.selected_endpoint]
            .connection
            .target
            .clone();
        for (group, tab) in &needed {
            let existing = terminals
                .parked
                .iter_mut()
                .find(|parked| parked.group == *group);
            match existing {
                Some(parked) => parked.steer(tab, now),
                None if terminals.retry.iter().any(|(waiting, _)| waiting == group) => {}
                None => {
                    let mut connection = ConnectionBridge::new(target.clone());
                    connection.reconnect(self.options, false, true);
                    terminals.parked.push(Parked {
                        group: *group,
                        workspace: key.clone(),
                        connection,
                        live: LiveState::default(),
                        presentation: Presentation::default(),
                        options: self.options,
                        last_queued_options: Some(self.options),
                        pending_resize: None,
                        bounds: Bounds::default(),
                        unfocused: false,
                        asked: None,
                    });
                }
            }
        }
    }

    /// Takes the window's connection to the Herdr tab the group in use of a
    /// just-restored layout showed, once, when the daemon's focus was left
    /// on another. The other groups reach theirs through their own
    /// connections.
    fn steer_restored(&mut self, key: &(Scope, String), cx: &mut Context<Self>) {
        let Some(restored) = &self.browser.restored else {
            return;
        };
        if restored != key {
            self.browser.restored = None;
            return;
        }
        let pick = self
            .primary_group()
            .and_then(|group| self.group_pick(group));
        let Some(Pick::Herdr(tab)) = pick else {
            self.browser.restored = None;
            return;
        };
        if self.focused_herdr_tab() == Some(tab.as_str()) {
            self.browser.restored = None;
            return;
        }
        if !self.navigation_ready() || self.pending_navigation.is_some() {
            return;
        }
        self.browser.restored = None;
        let open = self.live.snapshot.as_ref().is_some_and(|snapshot| {
            snapshot
                .tabs
                .iter()
                .any(|candidate| candidate.tab_id == tab && candidate.workspace_id == key.1)
        });
        if open {
            self.navigate(crate::NavigationTarget::Tab(&tab), cx);
        }
    }

    /// Takes each parked connection's latest projection. Notifications and
    /// sounds reach every client, so only the window's own connection
    /// delivers them. Returns whether a parked group needs a redraw.
    pub(crate) fn poll_group_terminals(&mut self) -> bool {
        let mut changed = false;
        let now = Instant::now();
        let terminals = &mut self.browser.terminals;
        for parked in &mut terminals.parked {
            if let Some(mut update) = parked.connection.take_update() {
                update.notifications.clear();
                update.notifications_lost = false;
                update.sound_events.clear();
                update.reload_sound = false;
                update.clipboard_writes.clear();
                // A parked client never holds the presentation, so a bell or
                // title it saw belongs to no window.
                update.bells = 0;
                update.window_title = None;
                update.dialog_response = None;
                parked.live = update;
                changed = true;
            }
        }
        // A connection that went down tries again later rather than on
        // every tick.
        let failed: Vec<GroupId> = terminals
            .parked
            .iter()
            .filter(|parked| {
                matches!(
                    parked.live.status,
                    ConnectionStatus::Disconnected | ConnectionStatus::Detached
                )
            })
            .map(|parked| parked.group)
            .collect();
        for group in failed {
            terminals.parked.retain(|parked| parked.group != group);
            terminals.retry.push((group, now + RETRY_AFTER));
            changed = true;
        }
        changed
    }

    /// Gives the window's connection to `group`, parking the one it held
    /// under the group that had it. Everything a gesture, an IME
    /// composition, or held input aimed at the old connection is dropped,
    /// as a switch of endpoint drops it.
    fn swap_primary(&mut self, group: GroupId, key: &(Scope, String), cx: &mut Context<Self>) {
        let Some(index) = self
            .browser
            .terminals
            .parked
            .iter()
            .position(|parked| parked.group == group)
        else {
            return;
        };
        let mut parked = self.browser.terminals.parked.swap_remove(index);
        let old = self.browser.terminals.primary.replace(group);
        self.endpoints[self.selected_endpoint]
            .trade_connection(&mut parked.connection, &mut parked.live);
        std::mem::swap(&mut self.presentation, &mut parked.presentation);
        std::mem::swap(&mut self.options, &mut parked.options);
        std::mem::swap(
            &mut self.last_queued_options,
            &mut parked.last_queued_options,
        );
        std::mem::swap(&mut self.pending_resize, &mut parked.pending_resize);
        std::mem::swap(&mut self.bounds, &mut parked.bounds);
        if let Some(old) = old {
            parked.group = old;
            parked.workspace = key.clone();
            parked.unfocused = false;
            parked.asked = None;
            self.browser.terminals.parked.push(parked);
        }
        self.live = self.endpoints[self.selected_endpoint].live.clone();
        if let Some(transfer) = &self.file_transfer {
            transfer.cancel();
        }
        for image in &self.pending_images {
            image.cancel();
        }
        self.clear_pending_input();
        self.selection_epoch += 1;
        self.selection = None;
        self.terminal_mouse = None;
        self.scrollbar_drag = None;
        self.split_drag = None;
        self.pressed_terminal_link = None;
        self.discard_composition(cx);
        self.wheel = Default::default();
        self.sent_focus = None;
        self.activation_deadline = None;
        self.pending_navigation = None;
    }

    /// Records where a parked group's terminal is drawn, so its connection
    /// is sized to it. Runs from the canvas's prepaint.
    pub(crate) fn place_parked_terminal(
        &mut self,
        group: GroupId,
        bounds: Bounds<Pixels>,
        cell_height: f32,
    ) {
        let cell_width = self.cell_width;
        let Some(parked) = self
            .browser
            .terminals
            .parked
            .iter_mut()
            .find(|parked| parked.group == group)
        else {
            return;
        };
        parked.bounds = bounds;
        parked.options = ConnectOptions {
            surface_size: viewport(
                f32::from(bounds.size.width),
                f32::from(bounds.size.height),
                cell_width,
                cell_height,
            ),
            cell_width_px: cell_width.round().max(1.) as u32,
            cell_height_px: cell_height.round().max(1.) as u32,
        };
    }

    /// The frame a parked group paints.
    pub(crate) fn parked_frame(&mut self, group: GroupId) -> Option<Picture> {
        let parked = self
            .browser
            .terminals
            .parked
            .iter_mut()
            .find(|parked| parked.group == group)?;
        parked.presentation.picture(&parked.live)
    }

    /// Whether `group` shows a terminal through a parked connection.
    pub(crate) fn shows_parked_terminal(&self, group: GroupId, cx: &App) -> bool {
        Some(group) != self.primary_group()
            && self.group_shown(group, cx) == Shown::Terminal
            && self.group_connecting(group)
    }

    /// Hands the window's connection to `group` without moving it: the
    /// connection already shows the tab the group asked for.
    pub(crate) fn set_primary_group(&mut self, group: GroupId) {
        self.browser.terminals.primary = Some(group);
    }

    /// A parked group's terminal: its connection's frame, painted without
    /// input. Pressing the group makes it the group in use, which gives it
    /// the window's connection and its input.
    pub(crate) fn render_parked_terminal(
        &mut self,
        slot: Slot,
        gap: f32,
        font: Font,
        cell_height: f32,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let surface = self.parked_frame(slot.id);
        self.render_terminal_picture(
            slot,
            "parked-terminal",
            gap,
            surface,
            true,
            font,
            cell_height,
            cx,
        )
    }

    /// The live frame of `tab` in whichever group holds it: the window's
    /// own, or a parked connection's.
    pub(crate) fn live_frame_of(
        &mut self,
        tab: &str,
        window_frame: Option<Picture>,
    ) -> Option<Picture> {
        if self.focused_herdr_tab() == Some(tab) {
            return window_frame;
        }
        let parked = self
            .browser
            .terminals
            .parked
            .iter_mut()
            .find(|parked| parked.focused_tab() == Some(tab))?;
        parked.presentation.picture(&parked.live)
    }

    /// A group picking a tab another group shows paints a picture of it,
    /// as an editor shows one file in two groups. The daemon sizes the tab
    /// for the group that holds it, so a narrower or wider group shows it
    /// clipped or padded; pressing the group brings the live tab here.
    pub(crate) fn render_terminal_mirror(
        &mut self,
        slot: Slot,
        gap: f32,
        surface: Option<Picture>,
        font: Font,
        cell_height: f32,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        self.render_terminal_picture(
            slot,
            "mirror-terminal",
            gap,
            surface,
            false,
            font,
            cell_height,
            cx,
        )
    }

    /// A terminal frame painted without input. `place` sizes the group's
    /// parked connection to where it is drawn.
    #[allow(clippy::too_many_arguments)]
    fn render_terminal_picture(
        &mut self,
        slot: Slot,
        name: &'static str,
        gap: f32,
        surface: Option<Picture>,
        place: bool,
        font: Font,
        cell_height: f32,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let group = slot.id;
        let entity = cx.entity();
        let painter = self.painter.clone();
        let cell_width = self.cell_width;
        div()
            .id(SharedString::from(slot.selector(name)))
            .debug_selector(move || slot.selector(name))
            .flex_1()
            .min_h_0()
            .min_w_0()
            .pl(px(gap))
            .overflow_hidden()
            .bg(rgb(self.theme.background))
            .child(
                canvas(
                    move |bounds, _, cx| {
                        if place {
                            entity.update(cx, |this, _| {
                                this.place_parked_terminal(group, bounds, cell_height);
                            });
                        }
                    },
                    move |bounds, _, window, cx| {
                        let Some(Picture {
                            frame: surface,
                            images,
                        }) = &surface
                        else {
                            return;
                        };
                        // A frame wider than the group stays inside it.
                        window.with_content_mask(Some(ContentMask { bounds }), |window| {
                            painter.borrow_mut().paint_frame(
                                &surface.frame,
                                bounds.origin,
                                Some(bounds.size),
                                cell_width,
                                &font,
                                &[],
                                &surface.panes,
                                None,
                                Some(PlacedImages {
                                    placements: &surface.graphics.placements,
                                    images,
                                    target: ImageTarget::Main,
                                }),
                                window,
                                cx,
                            );
                            if let Some(popup) = &surface.popup {
                                let offset = popup_origin(
                                    &surface.frame,
                                    &popup.frame,
                                    cell_width,
                                    cell_height,
                                );
                                painter.borrow_mut().paint_frame(
                                    &popup.frame,
                                    bounds.origin + offset,
                                    None,
                                    cell_width,
                                    &font,
                                    &[],
                                    &[],
                                    None,
                                    Some(PlacedImages {
                                        placements: &surface.graphics.placements,
                                        images,
                                        target: ImageTarget::Popup(&popup.terminal_id),
                                    }),
                                    window,
                                    cx,
                                );
                            }
                        });
                    },
                )
                .size_full(),
            )
            .into_any_element()
    }

    /// Drops every parked connection: the window left their workspace or
    /// endpoint.
    pub(crate) fn drop_group_terminals(&mut self) {
        let terminals = &mut self.browser.terminals;
        terminals.parked.clear();
        terminals.primary = None;
    }

    /// Forgets `group`'s parked connection; the group closed.
    pub(crate) fn forget_group_terminal(&mut self, group: GroupId) {
        let terminals = &mut self.browser.terminals;
        terminals.parked.retain(|parked| parked.group != group);
        terminals.retry.retain(|(waiting, _)| *waiting != group);
        if terminals.primary == Some(group) {
            terminals.primary = None;
        }
    }
}

#[cfg(test)]
pub(crate) mod tests;

#[cfg(test)]
mod mirror_tests {
    #![allow(clippy::unwrap_used)]
    use super::tests::{fixture_window_on_t0, surface};
    use crate::{controls::Command, sidebar::layout_tests::full_draw};
    use gpui::TestAppContext;

    #[gpui::test]
    fn a_split_shows_the_same_terminal_in_both_groups(cx: &mut TestAppContext) {
        let (view, cx) = fixture_window_on_t0(cx);
        cx.update(|_, cx| {
            view.update(cx, |view, _| {
                let snapshot = view.live.snapshot.clone().unwrap();
                view.live.surface = Some(surface(&snapshot, "p0"));
                view.endpoints[0].live = view.live.clone();
            })
        });
        cx.update(|window, cx| full_draw(window, cx).clear(cx));
        assert!(cx.debug_bounds("terminal").is_some());
        cx.update(|window, cx| {
            view.update(cx, |view, cx| {
                view.command(Command::SplitEditor, window, cx)
            })
        });
        cx.update(|window, cx| full_draw(window, cx).clear(cx));
        // The new group holds the live terminal; the one it split from
        // paints the same frame rather than standing empty.
        let mirror = cx.debug_bounds("mirror-terminal").unwrap();
        let terminal = cx.debug_bounds("terminal").unwrap();
        assert!(mirror.right() <= terminal.left());
        assert!(cx.debug_bounds("stand-in").is_none());
        // Pressing the mirror brings the live terminal to it.
        cx.simulate_click(mirror.center(), gpui::Modifiers::none());
        cx.update(|window, cx| full_draw(window, cx).clear(cx));
        let terminal = cx.debug_bounds("terminal").unwrap();
        let mirror = cx.debug_bounds("g1-mirror-terminal").unwrap();
        assert!(terminal.right() <= mirror.left());
    }
}
