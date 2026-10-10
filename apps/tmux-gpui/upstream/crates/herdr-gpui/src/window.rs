//! The window entity: the state one GPUI window owns for one client of one
//! daemon, and the poll task that folds worker results into it. Behavior is
//! split by responsibility across the submodules below; the fields live here
//! because every one of them describes this window's own presentation state.

mod announcement;
mod clipboard;
mod commands;
mod config_diagnostic;
mod copy_mode;
mod double_shift;
mod file_drop;
mod file_links;
mod find;
mod flash;
pub(crate) use commands::run_window_command;
pub(crate) use flash::Flash;
mod image_source;
mod images;
mod input;
mod lifecycle;
mod links;
pub(crate) use links::PressedLink;
mod mouse;
mod pending_input;
mod prefix;
mod reconnecting;
mod regions;
mod render;
mod selection;
mod server_keys;
mod status_bar;
pub(crate) mod system_notifications;
mod tab_drag;
mod tab_strip;
mod toasts;
mod transfers;
#[cfg(test)]
pub(crate) use transfers::tests::Peer as MockPeer;

#[cfg(test)]
mod font_size_tests;
#[cfg(test)]
mod key_action_tests;
#[cfg(all(test, feature = "integration-test"))]
mod resize_tests;
#[cfg(test)]
mod shortcut_tests;
#[cfg(test)]
mod status_bar_tests;
#[cfg(test)]
mod tests;

#[cfg(feature = "integration-test")]
use crate::smoke;
use crate::{
    WINDOW_TITLE, avatars, config, endpoint, git, log_window, menu,
    navigation::OwnedNavigationTarget,
    preferences,
    presentation::Presentation,
    sessions, sidebar,
    state::LiveState,
    terminal::{Selection, WheelAccumulator},
    terminal_painter, updater,
};
use gpui::{prelude::*, *};
use herdr_client::{ConnectOptions, ConnectTarget};
#[cfg(feature = "integration-test")]
use std::sync::Arc;
use std::time::Duration;

pub(crate) use server_keys::ActiveServerKeymap;

pub(crate) struct HerdrWindow {
    /// Shared by every window; see `app::shared_sound`.
    pub(crate) sound: std::rc::Rc<crate::sound::Service>,
    pub(crate) bell: crate::bell::Bell,
    pub(crate) updater: updater::Updater,
    pub(crate) update_preview: Option<updater::State>,
    /// Prepared daemon announcement and release notes text.
    pub(crate) daemon_text: crate::release_notes::DaemonText,
    pub(crate) config: config::Config,
    /// The terminal size the last loaded config asked for. Increase/decrease
    /// write straight to `config.terminal.size`, so this is what Reset Font
    /// Size restores; a session adjustment never reaches disk.
    pub(crate) configured_terminal_size: f32,
    /// Unknown keys in the GUI config, ignored but reported; follows `config`.
    pub(crate) gui_config_diagnostic: crate::config_diagnostic::ConfigDiagnostic,
    pub(crate) theme: config::Theme,
    /// The system appearance `theme` was loaded for, which is what Herdr is
    /// told. It trails the system while the theme for a new appearance
    /// loads, so Herdr never pairs the new appearance with the old colors.
    pub(crate) theme_light: bool,
    pub(crate) config_load: Option<Task<()>>,
    pub(crate) settings: crate::settings_panel::SettingsPanel,
    pub(crate) integrations: crate::integrations::Integrations,
    pub(crate) font_size_saves: crate::font_sizes::FontSizeSaves,
    pub(crate) config_watch: Option<Task<()>>,
    pub(crate) config_load_revision: u64,
    pub(crate) endpoints: Vec<endpoint::Endpoint>,
    pub(crate) selected_endpoint: usize,
    pub(crate) selection_epoch: u64,
    pub(crate) catalog: endpoint::Catalog,
    /// Local sessions on this machine, scanned on a worker while the popup is open.
    pub(crate) sessions: sessions::Sessions,
    /// Where the footer's sessions button last painted. The window owns it so a
    /// shortcut and a click anchor the list at the same place.
    pub(crate) sessions_anchor: std::rc::Rc<std::cell::Cell<Point<Pixels>>>,
    pub(crate) activation_deadline: Option<std::time::Instant>,
    pub(crate) pending_navigation: Option<OwnedNavigationTarget>,
    pub(crate) pending_toast: Option<u64>,
    pub(crate) toasts_hidden: bool,
    pub(crate) pending_releases: Vec<endpoint::Release>,
    pub(crate) selected_generation: u64,
    pub(crate) live: LiveState,
    pub(crate) focus: FocusHandle,
    pub(crate) options: ConnectOptions,
    pub(crate) last_queued_options: Option<ConnectOptions>,
    pub(crate) pending_resize: Option<(ConnectOptions, std::time::Instant)>,
    pub(crate) active: bool,
    pub(crate) sent_focus: Option<bool>,
    pub(crate) bounds: Bounds<Pixels>,
    /// Last title pushed to the OS, so the window is renamed only when it changes.
    pub(crate) title: String,
    pub(crate) cell_width: f32,
    pub(crate) hovered_terminal_link: bool,
    pub(crate) pressed_terminal_link: Option<PressedLink>,
    pub(crate) links: links::DaemonLinks,
    pub(crate) terminal_mouse: Option<mouse::Gesture>,
    pub(crate) scrollbar_drag: Option<mouse::ScrollbarDrag>,
    pub(crate) split_drag: Option<mouse::SplitDrag>,
    /// The resize cursor of the pane border under the pointer, if any.
    pub(crate) split_cursor: Option<CursorStyle>,
    pub(crate) pending_images: Vec<images::PendingImage>,
    pub(crate) pending_input: pending_input::PendingInput,
    pub(crate) held_keys: crate::terminal::HeldKeys,
    pub(crate) file_transfer: Option<transfers::FileTransfer>,
    /// The terminal cells the pointer is choosing. A release copies them and
    /// clears this, so a highlight only ever belongs to a drag in progress.
    pub(crate) selection: Option<Selection>,
    pub(crate) selection_follow: selection::Follow,
    /// The find bar, over the pane it searches.
    pub(crate) find: Option<find::FindBar>,
    /// How the find bar was left over each pane, to bring it back there.
    pub(crate) find_memory: crate::find::memory::Memory,
    /// Keyboard copy mode, when it holds the keyboard.
    pub(crate) copy_mode: Option<copy_mode::CopyModeState>,
    /// The brief message over the terminal, and when it stops showing.
    pub(crate) flash: Option<(Flash, std::time::Instant)>,
    /// The frame on screen, kept across the gap between two projections.
    pub(crate) presentation: Presentation,
    /// Tells a sleep from the clocks, so connections are checked on waking.
    pub(crate) wake: endpoint::WakeClock,
    pub(crate) painter: std::rc::Rc<std::cell::RefCell<terminal_painter::TerminalPainter>>,
    /// The terminal grid's cached regions; see `regions`.
    pub(crate) regions: Vec<regions::RegionLayers>,
    pub(crate) marked: String,
    /// Where the IME's caret or converted clause is within `marked`, in
    /// UTF-16; `None` puts the caret after it.
    pub(crate) marked_selection: Option<std::ops::Range<usize>>,
    /// The sidebar row the pointer is resting on, waiting to open its menu.
    pub(crate) hover: Option<sidebar::HoverRest>,
    /// The menu that resting opened, which the pointer closes by leaving it.
    pub(crate) hover_menu: Option<sidebar::HoverMenu>,
    pub(crate) local_error: Option<String>,
    pub(crate) menu: menu::MenuState,
    /// A `worktree.remove` queued after its dialog closed.
    pub(crate) removal: Option<menu::Removal>,
    /// The worktree script being located, read, trusted, or opened.
    pub(crate) worktree_script: Option<crate::worktree_scripts::Job>,
    /// A teleport being set up or under way; a move outlives its dialog.
    pub(crate) teleport: Option<crate::teleport::Teleport>,
    /// Checkouts this client teleported away from, marked in the sidebar.
    pub(crate) teleport_marks: crate::teleport::Marks,
    /// The workspace a finished teleport keeps steering to until focused.
    pub(crate) teleport_follow: Option<crate::teleport::Follow>,
    /// A worktree or workspace being created on another host.
    pub(crate) dispatch_job: Option<crate::dispatch::Job>,
    /// Dispatched worktrees' setup scripts, waiting for their hosts in order.
    pub(crate) dispatch_setups: std::collections::VecDeque<crate::dispatch::Setup>,
    /// A prompt fanned out to several agents; once launched it outlives its
    /// dialog so the lanes can be compared later.
    pub(crate) fan_out: Option<crate::fan_out::FanOut>,
    pub(crate) git: git::Git,
    /// Notes waiting for their agents to be ready for them.
    pub(crate) deliveries: crate::agent_notes::Deliveries,
    /// The notes panel beside a review or an annotated page; both share it.
    pub(crate) notes_width: crate::panel_resize::PanelWidth,
    /// The review's list of changed files.
    pub(crate) review_files_width: crate::panel_resize::PanelWidth,
    /// Each review tab's state, by its tab.
    pub(crate) reviews: std::collections::HashMap<crate::browser::TabId, crate::review::Review>,
    /// The window's width at its last render, which caps side panels.
    pub(crate) viewport_width: f32,
    /// Comment, merge, and review reads for the focused branch's open PR.
    pub(crate) pr_actions: crate::pr_actions::Actions,
    pub(crate) usage: crate::usage::Usage,
    pub(crate) system_load: crate::system_load::SystemLoad,
    /// Snapshots of checkouts taken at agent turns, and the dialog listing them.
    pub(crate) checkpoints: crate::checkpoint::Checkpoints,
    /// Remote ports forwarded to this machine; they end with the window.
    pub(crate) port_forwards: crate::port_forward::PortForwards,
    /// Cloud machines being added; see `cloud::Jobs`.
    #[cfg(feature = "cloud")]
    pub(crate) cloud_jobs: crate::cloud::Jobs,
    pub(crate) listening_ports: crate::listening_ports::ListeningPorts,
    /// SSH tunnels to remote ports that listen on their host's loopback only.
    pub(crate) tunnels: crate::listening_ports::Tunnels,
    pub(crate) install_warning_shown: bool,
    /// Whether the selected endpoint's refused handshake was announced. Reset
    /// once it has none, so a later refusal is announced again.
    pub(crate) version_notice_shown: bool,
    pub(crate) collapsed_repos: std::collections::HashSet<String>,
    /// Expanded; collapsed leaves the rail or nothing, as Herdr's
    /// `ui.sidebar_collapsed_mode` chooses (see `sidebar_mode`).
    pub(crate) sidebar_visible: bool,
    /// Herdr's `ui.sidebar_start_collapsed` still applies: no shared settings
    /// have loaded yet and the user has not toggled the sidebar since startup.
    pub(crate) sidebar_start_pending: bool,
    /// Starts as `config.status_bar.show`; Toggle Status Bar flips it for the
    /// session, and a reload that changes the setting applies it again.
    pub(crate) status_bar_visible: bool,
    pub(crate) device_filter: Option<String>,
    pub(crate) wheel: WheelAccumulator,
    pub(crate) sidebar_width: Option<f32>,
    pub(crate) sidebar_drag: Option<sidebar::SidebarDrag>,
    /// A press on a workspace row that may lift it for reordering.
    pub(crate) workspace_drag: Option<sidebar::WorkspaceDrag>,
    /// A press on a tab that may lift it for reordering.
    pub(crate) tab_drag: Option<tab_drag::TabDrag>,
    pub(crate) sidebar_split: Option<f32>,
    pub(crate) sidebar_split_modified: bool,
    pub(crate) sidebar_preferences: Option<preferences::Preferences>,
    pub(crate) sidebar_modified: bool,
    pub(crate) agent_sort: preferences::AgentSort,
    /// Whether the user chose the sort with the panel toggle, now or in a
    /// stored session. Until then the daemon's `ui.agent_panel_sort` decides,
    /// including after a config reload, as upstream's manual override does.
    pub(crate) agent_sort_modified: bool,
    pub(crate) avatars: Option<avatars::Avatars>,
    #[cfg(feature = "integration-test")]
    pub(crate) input_probe: smoke::InputProbe,
    /// Spaces and agents lists, in that order.
    pub(crate) sidebar_scroll: [ScrollHandle; 2],
    /// The row each list has scrolled into view, so a new selection is revealed
    /// while the user's own scrolling of an unchanged one is left alone.
    pub(crate) sidebar_revealed: [std::cell::Cell<Option<usize>>; 2],
    /// A spaces row revealed last frame, which the next render moves out from
    /// under the pinned host header if it landed there.
    pub(crate) sidebar_pin_reveal: std::cell::Cell<Option<usize>>,
    pub(crate) _poll: Task<()>,
    pub(crate) _activation: Subscription,
    pub(crate) _appearance: Subscription,
    /// The sidebar as a cached view; see `sidebar::SidebarView`.
    pub(crate) sidebar_view: Entity<sidebar::SidebarView>,
    /// Notified in place of this view by a surface-only update, which redraws
    /// the window while the cached sidebar keeps its layout.
    pub(crate) surface_signal: Entity<SurfaceSignal>,
    pub(crate) _sidebar_invalidation: Subscription,
    pub(crate) _host_theme: Subscription,
    /// Browser tabs this window shows, and its pages for them.
    pub(crate) browser: crate::browser::Browser,
    pub(crate) _browser_tabs: Subscription,
    /// Another window may edit a note this one shows.
    pub(crate) _worktree_notes: Subscription,
    /// The daemon's prefix was typed, so the next keystroke completes a chord.
    pub(crate) prefix_armed: bool,
    /// Herdr's resize mode: direction keys resize the focused pane until
    /// Escape, Enter, or the mode's own shortcut ends it.
    pub(crate) resize_mode: bool,
    /// The selected device's server keymap, when it opted into one.
    pub(crate) server_keys: Option<server_keys::ServerKeymap>,
    pub(super) shift_taps: double_shift::ShiftTaps,
    pub(crate) _prefix_interceptor: Subscription,
}

/// See `HerdrWindow::surface_signal`.
pub(crate) struct SurfaceSignal;

impl HerdrWindow {
    /// Redraws for a surface-only update. Notifying this view instead would
    /// also invalidate the cached sidebar, rebuilding every row for a frame
    /// whose rows did not change.
    pub(crate) fn redraw_terminal(&mut self, cx: &mut Context<Self>) {
        self.surface_signal.update(cx, |_, cx| cx.notify());
    }

    /// Every notification of this view reaches the cached sidebar, so it
    /// redraws exactly when it did as part of this view.
    pub(crate) fn invalidate_sidebar(cx: &mut Context<Self>) -> Subscription {
        cx.observe_self(|this, cx| {
            let indicators = sidebar::Indicators::new(
                this.settings.shared.as_ref(),
                matches!(
                    cx.window_appearance(),
                    WindowAppearance::Light | WindowAppearance::VibrantLight
                ),
                &this.theme,
            );
            this.sidebar_view.update(cx, |view, cx| {
                view.set_indicators(indicators, cx);
                cx.notify();
            });
        })
    }

    /// Another window may edit a note: redraw the sidebar, and rebuild an
    /// open palette's rows without waiting for the next tick.
    pub(crate) fn observe_worktree_notes(window: &Window, cx: &mut Context<Self>) -> Subscription {
        cx.observe_global_in::<crate::worktree_notes::Notes>(window, |this, window, cx| {
            this.refresh_palette(window, cx);
            cx.notify();
        })
    }

    /// Theme and appearance changes all notify this view, so each one reaches
    /// the daemon without every place that sets a theme having to report it.
    pub(crate) fn observe_host_theme(cx: &mut Context<Self>) -> Subscription {
        cx.observe_self(|this, _| this.sync_host_theme())
    }

    /// Tell every connection the terminal theme. Only queues, never waits:
    /// each handle skips a theme it already queued.
    pub(crate) fn sync_host_theme(&self) {
        let theme = crate::connection::host_theme(&self.theme, self.theme_light);
        for endpoint in &self.endpoints {
            endpoint.connection.sync_host_theme(&endpoint.live, &theme);
        }
        self.sync_group_host_theme(&theme);
    }

    /// Runs every display frame while the window draws, so a new surface is
    /// shown on the refresh it arrives for instead of on the next timer tick.
    fn poll_on_frame(this: WeakEntity<Self>, window: &mut Window) {
        window.on_next_frame(move |window, cx| {
            let alive = this.update(cx, |view, cx| {
                if view
                    .endpoints
                    .iter()
                    .any(|endpoint| endpoint.connection.has_update())
                    || view.group_terminals_updated()
                {
                    view.tick(window, cx);
                }
            });
            if alive.is_ok() {
                Self::poll_on_frame(this, window);
            }
        });
    }

    /// Stored chrome yields to anything changed before it arrived. A stored
    /// sort is a past toggle, so it overrides the daemon's from then on.
    pub(crate) fn apply_stored_chrome(&mut self, chrome: preferences::Chrome) {
        if !self.sidebar_modified {
            self.sidebar_width = chrome.sidebar_width;
        }
        if !self.sidebar_split_modified {
            self.sidebar_split = chrome.sidebar_split;
        }
        if self.notes_width.chosen().is_none() {
            self.notes_width.restore(chrome.notes_width);
        }
        if self.review_files_width.chosen().is_none() {
            self.review_files_width.restore(chrome.review_files_width);
        }
        if !self.agent_sort_modified
            && let Some(sort) = chrome.agent_sort
        {
            self.agent_sort = sort;
            self.agent_sort_modified = true;
        }
    }

    fn tick(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.updater.poll() {
            match self.updater.commit_restart() {
                Ok(true) => {
                    cx.quit();
                    return;
                }
                Ok(false) => {}
                Err(error) => eprintln!("App update restart failed: {error}"),
            }
            cx.notify();
        }
        if self.avatars.as_mut().is_some_and(|avatars| avatars.poll()) {
            cx.notify();
        }
        if let Some(chrome) = self.sidebar_preferences.as_mut().and_then(|p| p.loaded()) {
            self.apply_stored_chrome(chrome);
            cx.notify();
        }
        let old_pane = self
            .live
            .snapshot
            .as_ref()
            .and_then(|s| s.focused_pane_id.clone());
        let focused_tab = |live: &LiveState| {
            live.snapshot
                .as_ref()
                .map(|s| (s.focused_workspace_id.clone(), s.focused_tab_id.clone()))
        };
        let old_tab = focused_tab(&self.live);
        self.poll_endpoints(cx);
        self.post_system_notifications(window, cx);
        self.ring_bell(window);
        self.poll_integrations(cx);
        self.poll_links(window, cx);
        if self.settings.task.is_none() {
            let mut reload = false;
            for endpoint in &self.endpoints {
                reload |= endpoint.connection.take_settings_reload();
            }
            if reload {
                self.load_shared_settings(cx);
            }
        }
        // Switching Herdr tabs, from a shortcut, an agent, or the sidebar,
        // moves the group holding the window's connection to the new tab, or
        // brings the terminal back from behind a page. Arriving in another
        // workspace does the same for that workspace's group, so its tab is
        // the one just navigated to.
        if let (Some((old_workspace, old_tab)), Some((workspace, Some(tab)))) =
            (old_tab, focused_tab(&self.live))
            && (old_workspace != workspace || old_tab.as_ref() != Some(&tab))
        {
            self.terminal_focus_moved(&tab, old_workspace != workspace, cx);
        }
        // After the focus check: a swap replaces `live` with another
        // connection's, which is not a move of this one's focus.
        if self.poll_group_terminals() {
            self.redraw_terminal(cx);
        }
        self.reconcile_group_terminals(cx);
        // After polling: a connection that just got its first snapshot, or a
        // reconnect, is told the theme without waiting for it to change.
        self.sync_host_theme();
        self.save_group_layouts(cx);
        self.poll_browser(window, cx);
        self.offer_browser_skill(window, cx);
        self.poll_sessions(cx);
        self.flush_scrollbar(cx);
        self.flush_split(cx);
        self.poll_find(window, cx);
        self.follow_selection(cx);
        self.poll_copy_mode(cx);
        #[cfg(target_os = "macos")]
        crate::app_badge::sync(window.window_handle().window_id(), &self.endpoints, cx);
        self.cancel_stale_image();
        self.poll_file_transfer(cx);
        self.update_workspace_dialog(window, cx);
        self.poll_teleport(window, cx);
        self.poll_fan_out(window, cx);
        self.poll_dispatch(window, cx);
        self.poll_device_setup(window, cx);
        self.poll_worktree_script(window, cx);
        self.poll_worktree_source(cx);
        self.poll_hover_menu(std::time::Instant::now(), window, cx);
        if self.tick_flash(std::time::Instant::now()) {
            cx.notify();
        }
        self.poll_tab_rename(window, cx);
        self.poll_pane_rename(window, cx);
        self.poll_pane_processes(cx);
        if old_pane
            != self
                .live
                .snapshot
                .as_ref()
                .and_then(|s| s.focused_pane_id.clone())
        {
            self.discard_composition(cx);
        }
        self.poll_github(window, cx);
        if self.update_workspace_pr() {
            cx.notify();
        }
        if self.update_git() {
            cx.notify();
        }
        if self.update_usage(cx) {
            cx.notify();
        }
        if self.update_system_load() {
            cx.notify();
        }
        self.update_checkpoints(cx);
        self.update_port_forwards(cx);
        if self.update_listening_ports() {
            cx.notify();
        }
        if self.live.missing_installation && !self.install_warning_shown {
            self.install_warning_shown = true;
            self.show_install_modal(window, cx);
        }
        self.announce_version_mismatch(window, cx);
        self.resize();
        self.refresh_palette(window, cx);
        self.report_focus();
        self.sync_window_title(window);
    }

    /// Plan usage follows the selected host: a remote host reports its own
    /// agents' sign-ins, never this machine's.
    fn update_usage(&mut self, cx: &mut Context<Self>) -> bool {
        let host = self
            .config
            .usage
            .show
            .then(|| self.endpoints.get(self.selected_endpoint))
            .flatten()
            .and_then(|endpoint| crate::usage::Host::of(&endpoint.connection.target));
        let granted = crate::usage::KeychainGrants::granted(cx);
        let changed = self.usage.poll(
            host,
            &self.config.usage,
            &granted,
            self.config_load_revision,
            self.active,
            std::time::Instant::now(),
        );
        // A denied prompt takes the grant back, so a later launch does not
        // ask again in the background.
        for provider in self.usage.take_denied() {
            crate::usage::KeychainGrants::revoke(provider, cx);
        }
        changed
    }

    /// CPU and memory are sampled for every enabled host, while they are
    /// shown or a host picker ranks hosts by them.
    fn update_system_load(&mut self) -> bool {
        if !self.config.show_system_load && !self.dispatch_sampling() {
            return self.system_load.poll(Vec::new());
        }
        let hosts = self.watched_hosts();
        self.system_load.poll(hosts)
    }

    /// Listening ports are scanned on the same hosts as CPU and memory.
    fn update_listening_ports(&mut self) -> bool {
        if !self.config.show_listening_ports {
            self.tunnels = Default::default();
            return self.listening_ports.poll(Vec::new());
        }
        let hosts = self.watched_hosts();
        let changed = self.listening_ports.poll(hosts);
        // A tunnel lives as long as its remote port is listed.
        let ports = &self.listening_ports;
        self.tunnels
            .retain(|key| ports.listening(&crate::usage::Host::Ssh(key.target.clone()), key.port));
        changed
    }

    /// The machines background monitors watch: this one always, a remote
    /// host while it is connected, so a dropped host is not dialled every
    /// few seconds.
    fn watched_hosts(&self) -> Vec<crate::usage::Host> {
        self.endpoints
            .iter()
            .enumerate()
            .filter(|(index, endpoint)| {
                let live = if *index == self.selected_endpoint {
                    &self.live
                } else {
                    &endpoint.live
                };
                endpoint.enabled
                    && (live.status.is_connected() || !endpoint.connection.target.is_remote())
            })
            .filter_map(|(_, endpoint)| crate::usage::Host::of(&endpoint.connection.target))
            .collect()
    }

    /// Agent turns are watched on every enabled, connected host this client
    /// may run Git on, and finished restores are reported wherever the user is.
    fn update_checkpoints(&mut self, cx: &mut Context<Self>) {
        self.close_stale_checkpoints();
        let enabled = self.config.agent_checkpoints;
        let mut watched = Vec::new();
        for (index, endpoint) in self.endpoints.iter().enumerate() {
            let live = if index == self.selected_endpoint {
                &self.live
            } else {
                &endpoint.live
            };
            let (true, true, Some(host), Some(snapshot)) = (
                enabled,
                endpoint.enabled && live.status.is_connected(),
                crate::checkpoint::host_for(&endpoint.connection.target, live),
                live.snapshot.as_ref(),
            ) else {
                continue;
            };
            self.checkpoints.observe(&endpoint.id, &host, snapshot);
            watched.push(endpoint.id.as_str());
        }
        self.checkpoints
            .retain_endpoints(|endpoint| watched.contains(&endpoint));
        let (changed, restored) = self.checkpoints.poll();
        for restored in restored {
            let flash = match restored.result {
                Ok(()) => Flash::success(format!(
                    "Restored a checkpoint of {}",
                    restored.checkout.branch
                )),
                Err(error) => Flash::warning(format!(
                    "Checkpoint not restored: {}",
                    crate::checkpoint::describe(&error)
                )),
            };
            self.show_flash(flash, cx);
        }
        if changed {
            cx.notify();
        }
    }

    /// Forwards outlive a dropped connection, since SSH may still reach the
    /// host, but end once their host is removed or disabled. A report the
    /// user did not just ask for is flashed.
    pub(crate) fn update_port_forwards(&mut self, cx: &mut Context<Self>) {
        let endpoints = &self.endpoints;
        let mut changed = self.port_forwards.retain_hosts(|target| {
            endpoints.iter().any(|endpoint| {
                endpoint.enabled
                    && endpoint
                        .saved_ssh()
                        .is_some_and(|(saved, _)| saved == target)
            })
        });
        let notices = self.port_forwards.poll();
        if let Some(notice) = notices.last() {
            let flash = match notice {
                crate::port_forward::Notice::Listening { .. } => Flash::success(notice.text()),
                crate::port_forward::Notice::Ended { .. } => Flash::warning(notice.text()),
            };
            self.show_flash(flash, cx);
            changed = true;
        }
        if changed {
            cx.notify();
        }
    }

    /// The machine the selected endpoint runs on.
    pub(crate) fn selected_host(&self) -> Option<crate::usage::Host> {
        self.endpoints
            .get(self.selected_endpoint)
            .and_then(|endpoint| crate::usage::Host::of(&endpoint.connection.target))
    }

    pub(crate) fn new(
        target: ConnectTarget,
        window: &mut Window,
        cx: &mut Context<Self>,
        #[cfg(feature = "integration-test")] sidebar_test: bool,
    ) -> Self {
        #[cfg(feature = "integration-test")]
        let target = if sidebar_test {
            ConnectTarget::Socket("/unused-sidebar-fixture.sock".into())
        } else {
            target
        };
        let focus = cx.focus_handle();
        window.focus(&focus, cx);
        let weak = cx.weak_entity();
        let initial_theme = cx
            .try_global::<crate::app::InitialAppearance>()
            .map(|appearance| appearance.theme.clone())
            .unwrap_or_default();
        let indicators = sidebar::Indicators::new(
            None,
            matches!(
                cx.window_appearance(),
                WindowAppearance::Light | WindowAppearance::VibrantLight
            ),
            &initial_theme,
        );
        let sidebar_view = cx.new(|_| sidebar::SidebarView::new(weak, indicators));
        let timer = cx.background_executor().clone();
        let poll = cx.spawn_in(window, async move |this, cx| {
            loop {
                timer.timer(Duration::from_millis(16)).await;
                if this
                    .update_in(cx, |this, window, cx| this.tick(window, cx))
                    .is_err()
                {
                    break;
                }
            }
        });
        let appearance = cx
            .try_global::<crate::app::InitialAppearance>()
            .cloned()
            .unwrap_or_default();
        let crate::app::InitialAppearance {
            config,
            theme,
            error,
        } = appearance;
        let mut this = Self {
            sound: Default::default(),
            bell: crate::bell::Bell::default(),
            updater: updater::Updater::default(),
            update_preview: None,
            daemon_text: Default::default(),
            configured_terminal_size: config.terminal.size,
            status_bar_visible: config.status_bar.show,
            gui_config_diagnostic: {
                let mut diagnostic = crate::config_diagnostic::ConfigDiagnostic::default();
                diagnostic.sync(config.diagnostic().as_deref());
                diagnostic
            },
            config,
            theme,
            theme_light: crate::app::light_appearance(cx),
            config_load: None,
            settings: Default::default(),
            integrations: Default::default(),
            font_size_saves: Default::default(),
            config_watch: None,
            config_load_revision: 0,
            catalog: endpoint::Catalog::new(&target),
            sessions: sessions::Sessions::default(),
            sessions_anchor: Default::default(),
            endpoints: vec![endpoint::Endpoint::new(
                endpoint::LOCAL.into(),
                "Local".into(),
                target,
                true,
            )],
            selected_endpoint: 0,
            selection_epoch: 0,
            activation_deadline: None,
            pending_navigation: None,
            pending_toast: None,
            toasts_hidden: false,
            pending_releases: Vec::new(),
            selected_generation: 0,
            live: LiveState::default(),
            focus,
            options: ConnectOptions::default(),
            last_queued_options: None,
            pending_resize: None,
            active: window.is_window_active(),
            sent_focus: None,
            bounds: Bounds::default(),
            title: WINDOW_TITLE.to_owned(),
            cell_width: 9.,
            hovered_terminal_link: false,
            pressed_terminal_link: None,
            links: Default::default(),
            terminal_mouse: None,
            scrollbar_drag: None,
            split_drag: None,
            split_cursor: None,
            pending_images: Vec::new(),
            pending_input: Default::default(),
            held_keys: Default::default(),
            file_transfer: None,
            selection: None,
            selection_follow: Default::default(),
            find: None,
            copy_mode: None,
            find_memory: Default::default(),
            flash: None,
            presentation: Default::default(),
            wake: endpoint::WakeClock::new(std::time::Instant::now(), std::time::SystemTime::now()),
            painter: Default::default(),
            regions: Vec::new(),
            marked: String::new(),
            marked_selection: None,
            hover: None,
            hover_menu: None,
            local_error: error,
            menu: menu::MenuState::new(cx),
            removal: None,
            worktree_script: None,
            teleport: None,
            teleport_marks: crate::teleport::Marks::start(),
            teleport_follow: None,
            dispatch_job: None,
            dispatch_setups: Default::default(),
            fan_out: None,
            git: git::Git::default(),
            deliveries: Default::default(),
            notes_width: crate::panel_resize::NOTES,
            review_files_width: crate::panel_resize::REVIEW_FILES,
            reviews: Default::default(),
            viewport_width: 0.,
            pr_actions: Default::default(),
            usage: Default::default(),
            system_load: Default::default(),
            checkpoints: Default::default(),
            port_forwards: Default::default(),
            #[cfg(feature = "cloud")]
            cloud_jobs: Default::default(),
            listening_ports: Default::default(),
            tunnels: Default::default(),
            install_warning_shown: false,
            version_notice_shown: false,
            collapsed_repos: Default::default(),
            sidebar_visible: true,
            sidebar_start_pending: true,
            device_filter: None,
            wheel: WheelAccumulator::default(),
            sidebar_width: None,
            sidebar_drag: None,
            workspace_drag: None,
            tab_drag: None,
            sidebar_split: None,
            sidebar_split_modified: false,
            sidebar_preferences: None,
            sidebar_modified: false,
            agent_sort: preferences::AgentSort::default(),
            agent_sort_modified: false,
            avatars: None,
            #[cfg(feature = "integration-test")]
            input_probe: smoke::InputProbe::default(),
            sidebar_scroll: Default::default(),
            sidebar_revealed: Default::default(),
            sidebar_pin_reveal: Default::default(),
            _poll: poll,
            sidebar_view,
            surface_signal: cx.new(|_| SurfaceSignal),
            _sidebar_invalidation: Self::invalidate_sidebar(cx),
            _host_theme: Self::observe_host_theme(cx),
            browser: crate::browser::Browser::new(cx),
            // Another window, or an agent, may open or close a tab.
            _browser_tabs: cx.observe_global::<crate::browser::Store>(|_, cx| cx.notify()),
            _worktree_notes: Self::observe_worktree_notes(window, cx),
            prefix_armed: false,
            resize_mode: false,
            server_keys: None,
            shift_taps: Default::default(),
            _prefix_interceptor: Self::intercept_prefix(window, cx),
            _activation: cx.observe_window_activation(window, |this, window, cx| {
                this.active = window.is_window_active();
                if this.active {
                    this.publish_server_keymap(cx);
                } else {
                    this.shift_taps.cancel();
                    this.disarm_prefix();
                    this.cancel_terminal_mouse(cx);
                    // A drag cut short is dropped; a selection kept for an
                    // explicit copy outlives a trip to another window.
                    if this.selection.as_ref().is_some_and(Selection::dragging) {
                        this.selection = None;
                    }
                    this.pressed_terminal_link = None;
                }
                this.report_focus();
                cx.notify();
            }),
            _appearance: cx.observe_window_appearance(window, |this, _, cx| {
                this.apply_shared_theme(cx);
                this.apply_system_theme(cx);
                cx.notify();
            }),
        };
        // Quitting need not drop this window, so its SSH children are killed
        // here rather than left forwarding after the app is gone.
        cx.on_app_quit(|this, _| {
            this.port_forwards.stop_all();
            async {}
        })
        .detach();
        #[cfg(feature = "integration-test")]
        if sidebar_test {
            this._poll = Task::ready(());
            this.live.snapshot = Some(Arc::new(sidebar::layout_tests::snapshot(40)));
            this.endpoints[0].live = this.live.clone();
            if let Ok(mut inbox) = this.endpoints[0].connection.inbox.lock() {
                *inbox = this.live.clone();
            }
            return this;
        }
        Self::poll_on_frame(cx.entity().downgrade(), window);
        this.sidebar_preferences = this.endpoints[0]
            .connection
            .target
            .socket_path()
            .ok()
            .map(|path| preferences::Preferences::new(&path));
        this.avatars = Some(avatars::Avatars::new());
        this.reconnect(cx);
        log_window::set_appearance(&this.config, &this.theme, cx);
        this.load_gui_config(cx);
        this.load_shared_settings(cx);
        this.watch_gui_config(cx);
        this
    }
}
