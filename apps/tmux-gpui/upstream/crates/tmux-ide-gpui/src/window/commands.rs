//! Command dispatch and focus changes. A focus change is fenced behind an
//! ordered surface barrier so input cannot reach the previous pane while the
//! navigation and its projection are still in flight.

use super::{Flash, HerdrWindow};
use crate::{
    app::InitialAppearance,
    config::{Config, FONT_SIZE_RANGE, FONT_SIZE_STEP, LayoutMode},
    controls::{self, Command},
    log_window,
    menu::WorkspaceAction,
    navigation::{NavigationTarget, OwnedNavigationTarget},
    open_additional_window, state,
};
use gpui::{Context, Window};
use std::time::Duration;

impl HerdrWindow {
    /// Switches the sidebar layout here at once, then keeps it: the choice is
    /// saved to the local overrides off the UI thread, and the config watcher
    /// brings every other window along.
    pub(crate) fn set_layout(&mut self, mode: LayoutMode, cx: &mut Context<Self>) {
        self.set_layout_with(mode, Config::save_layout, cx);
    }

    /// `save` persists the choice; tests pass one that leaves the real
    /// config alone.
    pub(crate) fn set_layout_with(
        &mut self,
        mode: LayoutMode,
        save: impl FnOnce(LayoutMode) -> crate::Result<()> + Send + 'static,
        cx: &mut Context<Self>,
    ) {
        if self.config.layout.mode == mode {
            return;
        }
        self.config.layout.mode = mode;
        // The menu reads its checkmark from the latest config.
        if cx.has_global::<InitialAppearance>() {
            cx.global_mut::<InitialAppearance>().config.layout.mode = mode;
        }
        crate::menus::install(cx);
        cx.notify();
        let save = cx.background_executor().spawn(async move { save(mode) });
        cx.spawn(async move |_, _| {
            if let Err(error) = save.await {
                tracing::warn!(%error, "Could not save the sidebar layout");
            }
        })
        .detach();
    }

    pub(crate) fn navigate(
        &mut self,
        target: NavigationTarget<&str>,
        cx: &mut Context<Self>,
    ) -> bool {
        if self.menu.page.is_some() {
            return false;
        }
        self.dispatch_navigation(target, cx)
    }

    /// Complete an accepted navigation even if its context menu has since opened.
    pub(crate) fn dispatch_navigation(
        &mut self,
        target: NavigationTarget<&str>,
        cx: &mut Context<Self>,
    ) -> bool {
        if !self.input_ready() {
            return false;
        }
        let queued =
            self.request_focus_change("Navigate", Some((&target).into()), |handle, boot| {
                match target {
                    NavigationTarget::Workspace(id) => handle.focus_workspace(boot, id),
                    NavigationTarget::Tab(id) => handle.focus_tab(boot, id),
                    NavigationTarget::Pane(id) => handle.focus_pane(boot, id),
                }
            });
        self.discard_composition(cx);
        cx.notify();
        queued
    }

    /// `label` is what a failure is reported as, not a method name: navigation
    /// picks its method from the target, so it reports itself by name.
    pub(crate) fn request_focus_change(
        &mut self,
        label: &str,
        focus: Option<OwnedNavigationTarget>,
        enqueue: impl FnOnce(
            &herdr_client::ClientHandle,
            &str,
        ) -> Result<String, herdr_client::SendError>,
    ) -> bool {
        if let (Some(handle), Some(snapshot)) = (
            &self.endpoints[self.selected_endpoint].connection.handle,
            &self.live.snapshot,
        ) {
            if let Err(error) = enqueue(handle, &snapshot.boot_id) {
                self.local_error = Some(format!("{label}: {error}"));
            } else {
                self.fence_focus_change(focus);
                return true;
            }
        }
        false
    }

    pub(crate) fn fence_focus_change(&mut self, focus: Option<OwnedNavigationTarget>) {
        if !self.live.supports_surface {
            return;
        }
        if let (Some(handle), Some(snapshot)) = (
            &self.endpoints[self.selected_endpoint].connection.handle,
            &self.live.snapshot,
        ) && let Ok(mut state) = self.endpoints[self.selected_endpoint]
            .connection
            .inbox
            .lock()
        {
            // An ordered surface barrier prevents input hitting the previous
            // pane while navigation/creation and its projection are in flight.
            // Register the barrier under the inbox lock before input can resume.
            let (request, failed) = match handle.set_surface_active(&snapshot.boot_id, true) {
                Ok(request) => (request, false),
                Err(error) => {
                    self.local_error = Some(error.to_string());
                    (String::new(), true)
                }
            };
            state.activation = Some(state::SurfaceActivation {
                request,
                boot: snapshot.boot_id.clone(),
                revision: None,
                failed,
                focus,
                active: true,
            });
            state.surface = None;
            state.dirty = true;
            self.live = state.clone();
            self.activation_deadline = Some(
                std::time::Instant::now()
                    + if failed {
                        Duration::ZERO
                    } else {
                        Duration::from_secs(5)
                    },
            );
        }
    }

    /// Applies a session terminal size. Painting, hit testing, and IME
    /// placement all read `config.terminal.size` and its derived line height,
    /// so writing that one field keeps the three in agreement; render
    /// re-measures the cell and the canvas resends the geometry.
    ///
    /// A pending config load is deliberately left alone. Cancelling it the way
    /// the theme picker does would strand the very first load, which has no
    /// retry, on default fonts; a landing reload merely discards the
    /// adjustment, which is what reloading is for.
    pub(crate) fn set_terminal_font_size(&mut self, size: f32, cx: &mut Context<Self>) {
        let size = size.clamp(*FONT_SIZE_RANGE.start(), *FONT_SIZE_RANGE.end());
        if size == self.config.terminal.size {
            return;
        }
        self.config.terminal.size = size;
        // The console follows the rendered terminal face, as a reload makes it.
        log_window::set_appearance(&self.config, &self.theme, cx);
        cx.notify();
    }

    pub(crate) fn command(
        &mut self,
        command: Command,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.menu.page.is_some() {
            return;
        }
        #[cfg(feature = "integration-test")]
        {
            self.input_probe.actions += 1;
        }
        match command {
            Command::OpenNotificationTarget => {
                if let Some((endpoint, id)) = self.endpoints.iter().find_map(|e| {
                    e.toasts
                        .entries
                        .iter()
                        .find(|(_, n)| n.visible)
                        .map(|(id, _)| (e, *id))
                }) {
                    let (origin, generation, inbox) = (
                        endpoint.id.clone(),
                        endpoint.generation,
                        endpoint.connection.inbox.clone(),
                    );
                    self.click_toast(&origin, generation, &inbox, id, cx);
                }
                return;
            }
            Command::Logs => {
                log_window::open(cx);
                return;
            }
            Command::NewWindow => {
                // Another client of the same launch target, not another daemon.
                open_additional_window(self.endpoints[0].connection.target.clone(), cx);
                return;
            }
            // A page has no panes, so either close closes its tab, as in
            // a web browser; nothing runs in it that needs confirming. A group
            // standing in for a tab closes that tab, and an empty group of a
            // split closes, as an editor group does.
            Command::ClosePane | Command::CloseTab => {
                let Some(group) = self.active_group() else {
                    self.open_close_confirmation(command, window, cx);
                    return;
                };
                match self.group_shown(group, cx) {
                    crate::browser::Shown::Terminal => {
                        self.open_close_confirmation(command, window, cx)
                    }
                    crate::browser::Shown::Page(_) | crate::browser::Shown::Elsewhere(_) => {
                        self.close_group_tab(group, window, cx)
                    }
                    crate::browser::Shown::Empty => self.close_group(group, window, cx),
                }
                return;
            }
            Command::NewBrowserTab => {
                self.open_browser_tab(None, window, cx);
                return;
            }
            Command::SplitEditor => {
                self.split_active_group(window, cx);
                return;
            }
            Command::InstallBrowserSkill => {
                self.install_browser_skill(window, cx);
                return;
            }
            Command::Palette | Command::WorkspacePicker => {
                self.open_palette(
                    if command == Command::WorkspacePicker {
                        crate::palette::Filter::Navigation
                    } else {
                        crate::palette::Filter::All
                    },
                    window,
                    cx,
                );
                return;
            }
            Command::NewWorktree => {
                self.open_new_worktree(window, cx);
                return;
            }
            Command::WorktreeNotes => {
                self.open_palette(crate::palette::Filter::Notes, window, cx);
                return;
            }
            Command::EditWorktreeNote => {
                self.edit_focused_worktree_note(window, cx);
                return;
            }
            // Every interactive creation path ends here, so Herdr's name prompt
            // covers buttons, menus, shortcuts, and the palette alike.
            Command::Tab | Command::Workspace if self.open_name_prompt(command, window, cx) => {
                return;
            }
            Command::Keybinds => {
                self.open_keybinds(window, cx);
                return;
            }
            Command::Sessions => {
                // The button's own position, so the shortcut opens the list where
                // clicking the button does.
                self.open_sessions(self.sessions_anchor.get(), window, cx);
                return;
            }
            Command::Themes => {
                self.open_theme_picker(window, cx);
                return;
            }
            Command::Settings => {
                self.open_preferences(window, cx);
                return;
            }
            Command::About => {
                self.open_about(window, cx);
                return;
            }
            Command::Find => {
                // In a review, Find searches its changes.
                match self.focused_review(window, cx) {
                    Some(id) => self.open_review_search(id, window, cx),
                    None => self.open_find(window, cx),
                }
                return;
            }
            // Repeats the search in use: the review's, else the pane's find
            // bar, opening the bar when nothing is being searched yet.
            Command::FindNext | Command::FindPrevious => {
                let back = command == Command::FindPrevious;
                if let Some(id) = self.focused_review(window, cx) {
                    self.review_find_again(id, back, window, cx);
                } else if self.find.is_some() {
                    // The bar's next match is the next older one, as Enter.
                    let step = if back {
                        crate::find::Step::Newer
                    } else {
                        crate::find::Step::Older
                    };
                    self.find_step(step, cx);
                } else {
                    self.open_find(window, cx);
                }
                return;
            }
            Command::ToggleFullScreen | Command::CycleWindows => {
                run_window_command(command, window, cx);
                return;
            }
            Command::CopyMode => {
                self.enter_copy_mode(window, cx);
                return;
            }
            Command::EditScrollback if !self.live.supports_edit_scrollback => {
                self.show_flash(
                    Flash::warning("Opening scrollback needs a newer Herdr daemon"),
                    cx,
                );
                return;
            }
            Command::ToggleSidebar => self.toggle_sidebar(),
            // Window chrome only, so it runs while the daemon is still away.
            Command::ToggleStatusBar => {
                self.status_bar_visible = !self.status_bar_visible;
                window.focus(&self.focus, cx);
                cx.notify();
                return;
            }
            Command::IncreaseFontSize | Command::DecreaseFontSize => {
                let step = if command == Command::IncreaseFontSize {
                    FONT_SIZE_STEP
                } else {
                    -FONT_SIZE_STEP
                };
                self.set_terminal_font_size(self.config.terminal.size + step, cx);
            }
            Command::ResetFontSize => {
                self.set_terminal_font_size(self.configured_terminal_size, cx);
            }
            Command::ClearPane if !self.live.supports_pane_clear => {
                // Older daemons do not advertise `pane.clear`. Say so rather than
                // typing `clear` into the pane, which could reach a running program.
                self.local_error = Some("Clear Pane needs a newer Herdr daemon.".into());
                cx.notify();
                return;
            }
            Command::Reconnect => self.reconnect(cx),
            Command::Quit => {
                cx.quit();
                return;
            }
            Command::RenameTab => {
                self.rename_focused_tab(window, cx);
                return;
            }
            Command::RenamePane => {
                self.rename_focused_pane(window, cx);
                return;
            }
            Command::RenameWorkspace | Command::CloseWorkspace => {
                let action = if command == Command::RenameWorkspace {
                    WorkspaceAction::Rename
                } else {
                    WorkspaceAction::Close
                };
                self.open_focused_workspace_dialog(action, window, cx);
                return;
            }
            // As Herdr's binding does: the daemon rereads its file, and this
            // client its own, which holds the daemon's `[keys]` too.
            Command::ReloadConfig => {
                self.reload_daemon_config();
                self.load_gui_config(cx);
                cx.notify();
                return;
            }
            Command::ResizeMode => {
                self.prefix_armed = false;
                self.resize_mode = true;
                cx.notify();
                return;
            }
            Command::LastPane => {
                // Herdr's check: the pane must still exist and not be focused.
                if let Some(snapshot) = &self.live.snapshot
                    && let Some(pane) = self.live.previous_pane.clone().filter(|pane| {
                        snapshot.focused_pane_id.as_ref() != Some(pane)
                            && snapshot.panes.iter().any(|p| p.pane_id == *pane)
                    })
                {
                    self.navigate(NavigationTarget::Pane(&pane), cx);
                }
                window.focus(&self.focus, cx);
                return;
            }
            Command::PreviousWorkspace
            | Command::NextWorkspace
            | Command::WorkspaceNumber(_)
            | Command::PreviousAgent
            | Command::NextAgent
            | Command::AgentNumber(_) => {
                self.step_sidebar(command, cx);
                window.focus(&self.focus, cx);
                return;
            }
            Command::MoveTabPrevious | Command::MoveTabNext if !self.live.supports_tab_move => {
                self.local_error = Some("Moving tabs needs a newer Herdr daemon.".into());
                cx.notify();
                return;
            }
            _ => {}
        }
        if self.activation_deadline.is_some()
            || !self.endpoints[self.selected_endpoint].surface_requested()
        {
            return;
        }
        if let Some(snapshot) = &self.live.snapshot
            && let Some((method, params)) = controls::request(command, snapshot)
        {
            self.request_focus_change(method.as_str(), None, |handle, boot| {
                handle.request(boot, method, params)
            });
            self.discard_composition(cx);
        }
        window.focus(&self.focus, cx);
        cx.notify();
    }

    /// Focuses the workspace or agent a sidebar step lands on, selecting its
    /// host first when that is another one.
    fn step_sidebar(&mut self, command: Command, cx: &mut Context<Self>) {
        let agents = matches!(
            command,
            Command::PreviousAgent | Command::NextAgent | Command::AgentNumber(_)
        );
        let rows = if agents {
            self.sidebar_agents()
        } else {
            self.sidebar_workspaces()
        };
        let selected = self.selected_endpoint;
        let focused = self.live.snapshot.as_ref().and_then(|snapshot| {
            if agents {
                snapshot.focused_pane_id.as_deref()
            } else {
                snapshot.focused_workspace_id.as_deref()
            }
        });
        let current = rows
            .iter()
            .position(|&(host, id)| host == selected && Some(id) == focused);
        let Some(&(host, id)) = crate::sidebar::sidebar_step(&rows, current, selected, command)
            .and_then(|index| rows.get(index))
        else {
            return;
        };
        let id = id.to_owned();
        let target = if agents {
            NavigationTarget::Pane(id.as_str())
        } else {
            NavigationTarget::Workspace(id.as_str())
        };
        if host == selected {
            self.navigate(target, cx);
        } else {
            let endpoint = self.endpoints[host].id.clone();
            self.navigate_endpoint(&endpoint, target, cx);
        }
    }

    /// Installs the agent skill for browser tabs where Claude Code and other
    /// agents look for skills, and keeps it current from now on. Only on
    /// request: the one-time offer, the palette, or Preferences.
    pub(crate) fn install_browser_skill(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        use crate::agent_skill::{AgentSkill, Choice};
        let home = match crate::config::home() {
            Ok(home) => home,
            Err(error) => {
                self.show_flash(Flash::warning(error.to_string()), cx);
                return;
            }
        };
        AgentSkill::choose(Choice::Installed, cx);
        if self.menu.page == Some(crate::menu::Page::AgentSkill) {
            self.dismiss_menu(window, cx);
        }
        let install = cx.background_executor().spawn(async move {
            let text = crate::agent_skill::text(std::env::current_exe().ok().as_deref());
            crate::agent_skill::install(&home, &text)
        });
        cx.spawn(async move |this, cx| {
            let result = install.await;
            this.update(cx, |this, cx| {
                let flash = match result {
                    Ok(paths) => Flash::success(match paths.as_slice() {
                        [path] => format!("Installed the browser skill at {}", path.display()),
                        _ => format!("Installed the browser skill in {} places", paths.len()),
                    }),
                    Err(error) => Flash::warning(error.to_string()),
                };
                this.show_flash(flash, cx);
            })
            .ok();
        })
        .detach();
    }

    /// Removes the skill files the app wrote and stops keeping them current.
    pub(crate) fn remove_browser_skill(&mut self, cx: &mut Context<Self>) {
        use crate::agent_skill::{AgentSkill, Choice};
        let Ok(home) = crate::config::home() else {
            return;
        };
        AgentSkill::choose(Choice::Declined, cx);
        let remove = cx
            .background_executor()
            .spawn(async move { crate::agent_skill::remove(&home) });
        cx.spawn(async move |this, cx| {
            let result = remove.await;
            this.update(cx, |this, cx| {
                let flash = match result {
                    Ok(paths) if paths.is_empty() => Flash::success("No browser skill to remove"),
                    Ok(_) => Flash::success("Removed the browser skill"),
                    Err(error) => Flash::warning(error.to_string()),
                };
                this.show_flash(flash, cx);
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// Offers the agent skill once, when this is the first window ready to
    /// show a dialog. Runs every tick; asking claims the question app-wide.
    pub(crate) fn offer_browser_skill(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let ready = self.menu.page.is_none() && self.active && self.live.snapshot.is_some();
        if !ready || !crate::agent_skill::AgentSkill::take_ask(cx) {
            return;
        }
        if self.open_menu(window, cx) {
            self.menu.page = Some(crate::menu::Page::AgentSkill);
            cx.notify();
        }
    }

    pub(crate) fn render_agent_skill_offer(&self, cx: &mut Context<Self>) -> gpui::Div {
        use gpui::{prelude::*, *};
        let theme = &self.theme;
        let button = |id: &'static str, label: &'static str, primary: bool| {
            div()
                .id(id)
                .debug_selector(move || id.into())
                .p(px(8.))
                .rounded(px(crate::config::corners::CONTROL))
                .when(primary, |button| button.bg(rgb(theme.active)))
                .when(!primary, |button| button.hover(|s| s.bg(rgb(theme.active))))
                .cursor_pointer()
                .child(label)
        };
        div()
            .debug_selector(|| "agent-skill-offer".into())
            .child(div().p(px(8.)).child("Let agents show you pages?"))
            .child(div().p(px(8.)).child(
                "Agents in your panes can open pages and HTML drafts in browser tabs here, and read the notes you pin on them. A skill teaches them how.",
            ))
            .child(div().p(px(8.)).text_color(rgb(theme.muted)).child(
                "Install writes herdr-gpui-browser/SKILL.md into ~/.claude/skills and ~/.agents/skills, whichever exist, and keeps it up to date. A skill of that name you wrote yourself is left alone. Remove it any time in Preferences.",
            ))
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .gap(px(8.))
                    .p(px(8.))
                    .child(button("agent-skill-install", "Install", true).on_click(cx.listener(
                        |this, _, window, cx| {
                            cx.stop_propagation();
                            this.install_browser_skill(window, cx);
                        },
                    )))
                    .child(button("agent-skill-decline", "Not now", false).on_click(cx.listener(
                        |this, _, window, cx| {
                            cx.stop_propagation();
                            this.dismiss_menu(window, cx);
                        },
                    ))),
            )
    }
}

/// Runs a command that acts on the window itself rather than its content,
/// for every kind of window, so the Settings and Log windows do not swallow
/// it; whether `command` was one.
pub(crate) fn run_window_command(
    command: Command,
    window: &mut Window,
    cx: &mut gpui::App,
) -> bool {
    match command {
        Command::ToggleFullScreen => window.toggle_fullscreen(),
        Command::CycleWindows => cycle_windows(window, cx),
        _ => return false,
    }
    true
}

/// Brings the app's next window forward, in the stable order the app lists
/// its windows, as macOS's Cmd-` does: a front-to-back order would only ever
/// swap the two most recent. Deferred, since activating a window updates it.
fn cycle_windows(window: &Window, cx: &mut gpui::App) {
    let Some(next) = next_window(&cx.windows(), window.window_handle()) else {
        return;
    };
    cx.defer(move |cx| {
        next.update(cx, |_, window, _| window.activate_window())
            .ok();
    });
}

/// The window after `current` in `windows`, wrapping; none when `current`
/// is alone or unknown.
pub(super) fn next_window<T: Copy + PartialEq>(windows: &[T], current: T) -> Option<T> {
    let at = windows.iter().position(|window| *window == current)?;
    let next = windows[(at + 1) % windows.len()];
    (next != current).then_some(next)
}
