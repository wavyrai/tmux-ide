//! The popup shell: opening and dismissing it, keeping its input isolated from
//! the panes beneath, and painting the page the menu is currently on. Geometry
//! here is the same geometry used for hit testing and IME placement.

mod keys;

use super::{MENU_MARGIN, Page, WorkspaceAction};
use crate::{HerdrWindow, actions, fonts::StyledFont};
use gpui::{prelude::*, *};
use herdr_client::Method;

/// How far past its panel a popover counts as covering, for the native pages
/// that step aside for it.
const COVER_MARGIN: f32 = 8.;

impl HerdrWindow {
    pub(crate) fn show_install_modal(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.open_menu(window, cx) {
            return;
        }
        self.menu.page = Some(Page::Install);
    }

    pub(crate) fn open_menu(&mut self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        self.shift_taps.cancel();
        self.finish_font_size_edit(true, cx);
        if !self.cancel_theme_preview(cx) {
            return false;
        }
        self.menu.reset();
        self.apply_shared_theme(cx);
        self.menu.endpoint_target = (
            self.selection_epoch,
            self.endpoints[self.selected_endpoint].generation,
        );
        self.menu.page = Some(Page::Menu);
        self.discard_composition(cx);
        window.focus(&self.menu.focus, cx);
        cx.notify();
        true
    }

    pub(crate) fn dismiss_menu(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.finish_font_size_edit(true, cx);
        if !self.cancel_theme_preview(cx) {
            return;
        }
        // Whatever the pointer was resting on, this dismissal ends that intent.
        self.hover = None;
        self.hover_menu = None;
        self.update_preview = None;
        self.dismiss_release_notes();
        // Closing the offer without an answer is a "not now": it asks once.
        if self.menu.page == Some(Page::AgentSkill)
            && crate::agent_skill::AgentSkill::choice(cx).is_none()
        {
            crate::agent_skill::AgentSkill::choose(crate::agent_skill::Choice::Declined, cx);
        }
        self.menu.reset();
        self.apply_shared_theme(cx);
        window.focus(&self.focus, cx);
        cx.notify();
    }

    pub(crate) fn restore_menu_focus(&self, window: &mut Window, cx: &mut App) {
        if self.menu.page.is_none() && self.menu.focus.is_focused(window) {
            window.focus(&self.focus, cx);
        }
    }

    pub(crate) fn menu_target_current(&self) -> bool {
        self.menu.endpoint_target
            == (
                self.selection_epoch,
                self.endpoints[self.selected_endpoint].generation,
            )
    }

    /// Asks the selected daemon to reread its config file.
    pub(crate) fn reload_daemon_config(&mut self) {
        if let (Some(handle), Some(snapshot)) = (
            &self.endpoints[self.selected_endpoint].connection.handle,
            &self.live.snapshot,
        ) {
            self.local_error = handle
                .request(
                    &snapshot.boot_id,
                    Method::ServerReloadConfig,
                    serde_json::json!({}),
                )
                .err()
                .map(|error| format!("Reload config: {error}"));
        }
    }

    pub(super) fn menu_items(&self) -> Vec<&'static str> {
        let mut items = vec![
            "settings",
            "shortcuts",
            "themes",
            "increase font size",
            "decrease font size",
            "reset font size",
            "command palette",
            "workspaces",
            "reload GUI config",
            "app updates",
            "preview app update",
            "GitHub sign-in",
            "about",
        ];
        if self.live.status.is_connected() {
            items.push("reload daemon config");
        }
        items.extend(self.release_notes_item());
        items.push(
            if self.endpoints[self.selected_endpoint]
                .connection
                .handle
                .is_some()
            {
                "detach"
            } else {
                "reconnect"
            },
        );
        items
    }

    pub(super) fn activate_menu(
        &mut self,
        item: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match item {
            "GitHub sign-in" => self.menu.page = Some(Page::GitHub),
            "about" => self.open_about(window, cx),
            "settings" => self.open_preferences(window, cx),
            "shortcuts" => self.open_keybinds(window, cx),
            "themes" => self.open_theme_picker(window, cx),
            "increase font size" | "decrease font size" | "reset font size" => {
                use crate::config::FONT_SIZE_STEP;
                let size = match item {
                    "increase font size" => self.config.terminal.size + FONT_SIZE_STEP,
                    "decrease font size" => self.config.terminal.size - FONT_SIZE_STEP,
                    _ => self.configured_terminal_size,
                };
                // `command` refuses to act while a page is open, so apply here.
                self.set_terminal_font_size(size, cx);
                self.dismiss_menu(window, cx);
            }
            "command palette" => self.open_palette(crate::palette::Filter::All, window, cx),
            "workspaces" => self.open_palette(crate::palette::Filter::Navigation, window, cx),
            "update ready" | "what's new" => self.menu.page = Some(Page::Update),
            "app updates" => self.open_app_update(false, window, cx),
            "preview app update" => self.open_app_update(true, window, cx),
            "reload GUI config" => self.reload_gui_config(window, cx),
            "reload daemon config" => {
                self.reload_daemon_config();
                self.dismiss_menu(window, cx);
            }
            "detach" => {
                self.detach_endpoint(cx);
                self.dismiss_menu(window, cx);
            }
            "reconnect" => {
                self.reconnect(cx);
                self.dismiss_menu(window, cx);
            }
            _ => {}
        }
        cx.notify();
    }

    pub(crate) fn render_menu(&self, window: &Window, cx: &mut Context<Self>) -> Stateful<Div> {
        if self.menu.page == Some(Page::Sessions) && self.menu.session_edit.is_some() {
            let theme = &self.theme;
            let font = &self.config.ui;
            let picker = self
                .anchor_footer_panel(
                    div()
                        .id("session-picker-underlay")
                        .debug_selector(|| "session-picker-underlay".into()),
                    window.viewport_size(),
                    Page::Sessions,
                )
                .overflow_y_scroll()
                .p(px(6.))
                .rounded(px(crate::config::corners::PANEL))
                .border_1()
                .border_color(rgb(theme.active))
                .bg(rgb(theme.surface))
                .text_color(rgb(theme.foreground))
                .text_font(font)
                .text_size(px(font.size))
                .line_height(px(font.line_height()))
                .child(self.render_session_list(cx));
            // The picker remains visible in its original position beneath the
            // modal's dimmed, input-occluding layer. Only that top layer owns focus.
            return div()
                .id("session-menu-stack")
                .absolute()
                .inset_0()
                .child(picker)
                .child(self.render_menu_layer(window, cx));
        }
        self.render_menu_layer(window, cx)
    }

    fn anchor_footer_panel(
        &self,
        panel: Stateful<Div>,
        viewport: Size<Pixels>,
        page: Page,
    ) -> Stateful<Div> {
        let chrome = px(crate::titlebar::HEIGHT
            + crate::worktree_banner::reserved(env!("HERDR_BUILD_WORKTREE") == "1"));
        let band = (viewport.height - chrome - px(2. * MENU_MARGIN)).max(px(60.));
        let room = |side: Pixels| side.clamp(px(0.), band).max(px(60.)).min(band);
        let above = room(self.menu.anchor.y - px(12. + MENU_MARGIN) - chrome);
        let below = room(viewport.height - self.menu.anchor.y - px(12. + MENU_MARGIN));
        let list = matches!(page, Page::Devices | Page::Sessions);
        let width = if list {
            super::devices::MENU_WIDTH
        } else {
            180.
        };
        let left = match page {
            Page::Devices => self.menu.anchor.x,
            Page::Sessions => self
                .menu
                .anchor
                .x
                .min((viewport.width - px(width + MENU_MARGIN)).max(px(0.))),
            _ => px(56.),
        };
        let panel = panel
            .absolute()
            .left(left)
            .w(px(width).min((viewport.width - px(16.)).max(px(0.))));
        if above >= below {
            panel
                .bottom(
                    (viewport.height - self.menu.anchor.y
                        + px(if list { super::devices::MENU_GAP } else { 12. }))
                    .max(px(MENU_MARGIN)),
                )
                .max_h(above)
        } else {
            panel.top(self.menu.anchor.y + px(12.)).max_h(below)
        }
    }

    fn render_menu_layer(&self, window: &Window, cx: &mut Context<Self>) -> Stateful<Div> {
        let page = self.menu.page.unwrap_or(Page::Menu);
        let font = &self.config.ui;
        let theme = &self.theme;
        let viewport = window.viewport_size();
        let session_modal = page == Page::Sessions && self.menu.session_edit.is_some();
        let footer_anchored =
            matches!(page, Page::Menu | Page::Devices | Page::Sessions) && !session_modal;
        // A GitHub tab of the new worktree dialog is a picker, not a form.
        let listing =
            self.worktree_listing() || page == Page::Dialog(WorkspaceAction::OpenWorktree);
        // The new worktree dialog keeps a listing's size on every tab, form
        // included, so moving between tabs never resizes it.
        let settled = listing || page == Page::Dialog(WorkspaceAction::NewWorktree);
        // Context menus open where the pointer asked for them. A dialog is a
        // modal decision, not a continuation of the row it came from, so it
        // centres over a dimmed window the way the Herdr TUI's dialogs do.
        let pointer_anchored = matches!(
            page,
            Page::Workspace
                | Page::Tab
                | Page::RenameTab
                | Page::Group
                | Page::Pane
                | Page::RenamePane
                | Page::PaneProcesses
                | Page::KillProcesses
                | Page::Host
                | Page::RemoveDevice
                | Page::RemoveWsl
                | Page::Git
                | Page::GitCommit
                | Page::PrReview
                | Page::PrComment
                | Page::PrMerge
        );
        let mut panel = div()
            .id("menu-panel")
            .debug_selector(|| "menu-panel".into())
            .when(matches!(page, Page::Workspace | Page::Dialog(_)), |panel| {
                panel
                    .w(px(if page == Page::Workspace {
                        340.
                    } else if page == Page::Dialog(WorkspaceAction::DeleteWorktree) {
                        480.
                    } else if settled {
                        // A listing needs room for a title and its branch.
                        560.
                    } else {
                        420.
                    })
                    .min((viewport.width - px(24.)).max(px(0.))))
                    // Every dialog may use the window's height: a captioned form
                    // whose buttons need scrolling into view reads as clipped.
                    .max_h((viewport.height - px(24.)).max(px(0.)))
                    // A listing is a picker: it takes a settled height and
                    // scrolls inside it, as the theme and command pickers do.
                    .when(settled, |panel| {
                        panel
                            .flex()
                            .flex_col()
                            .h(px(560. * (font.size / 12.))
                                .min((viewport.height - px(24.)).max(px(0.))))
                            .overflow_hidden()
                    })
                    // Lift the popup off the terminal behind it, as the pickers do.
                    .shadow_lg()
            })
            .when(footer_anchored, |panel| {
                self.anchor_footer_panel(panel, viewport, page)
            })
            .when(matches!(page, Page::Usage(_)), |panel| {
                // Rises from the status bar segment that opened it, kept inside
                // the window and clear of the titlebar.
                let chrome = px(crate::titlebar::HEIGHT
                    + crate::worktree_banner::reserved(env!("HERDR_BUILD_WORKTREE") == "1"));
                let width = px(crate::usage::PANEL_WIDTH)
                    .min((viewport.width - px(2. * MENU_MARGIN)).max(px(0.)));
                panel
                    .absolute()
                    .left(
                        self.menu
                            .anchor
                            .x
                            .min(viewport.width - width - px(MENU_MARGIN))
                            .max(px(MENU_MARGIN)),
                    )
                    .bottom((viewport.height - self.menu.anchor.y).max(px(MENU_MARGIN)))
                    .w(width)
                    .max_h((self.menu.anchor.y - chrome - px(MENU_MARGIN)).max(px(60.)))
                    .flex()
                    .flex_col()
                    .overflow_hidden()
                    .shadow_lg()
            })
            .when(
                matches!(
                    page,
                    Page::Git | Page::GitCommit | Page::PrReview | Page::PrComment | Page::PrMerge
                ),
                |panel| {
                    panel
                        .w((viewport.width - px(24.))
                            .max(px(0.))
                            .min(px(if page == Page::Git { 340. } else { 420. })))
                        .max_h((viewport.height - px(24.)).max(px(0.)))
                        .when(page == Page::Git, |panel| {
                            let top = crate::titlebar::HEIGHT
                                + crate::worktree_banner::reserved(
                                    env!("HERDR_BUILD_WORKTREE") == "1",
                                )
                                + 6.;
                            panel
                                .max_h((viewport.height - px(top + 12.)).max(px(0.)))
                                .shadow_lg()
                        })
                        // Its lists scroll inside; the panel never outgrows the window.
                        .when(page == Page::PrReview, |panel| panel.overflow_hidden())
                },
            )
            .when(
                matches!(
                    page,
                    Page::Tab
                        | Page::RenameTab
                        | Page::Group
                        | Page::Pane
                        | Page::RenamePane
                        | Page::PaneProcesses
                        | Page::KillProcesses
                        | Page::Host
                        | Page::RemoveDevice
                        | Page::RemoveWsl
                ),
                |panel| {
                    let room = (viewport.width - px(24.)).max(px(0.));
                    // A list of actions takes its longest label's width, which
                    // the UI font and size decide, so no fixed width fits all.
                    let forwards = page == Page::Host && self.host_menu_lists_forwards();
                    if matches!(page, Page::Tab | Page::Pane | Page::Host) && !forwards {
                        return panel
                            .min_w(px(180.).min(room))
                            .max_w(room)
                            .max_h((viewport.height - px(24.)).max(px(0.)));
                    }
                    panel
                        .w(room.min(px(if forwards {
                            // Room for a forward's port, state, and actions.
                            260.
                        } else if page == Page::PaneProcesses {
                            // Name, command, pid, CPU and memory columns.
                            560.
                        } else if page == Page::Group {
                            240.
                        } else {
                            360.
                        })))
                        .max_h((viewport.height - px(24.)).max(px(0.)))
                },
            )
            .when(
                !footer_anchored
                    && !matches!(page, Page::Usage(_))
                    && !pointer_anchored
                    && !matches!(page, Page::Dialog(_)),
                |panel| {
                    panel
                        .w((viewport.width - px(32.)).max(px(0.)).min(px(
                            if page == Page::Preferences {
                                620. * (font.size / 12.)
                            } else {
                                480.
                            },
                        )))
                        .max_h((viewport.height - px(32.)).max(px(0.)))
                },
            )
            .when(
                !matches!(
                    page,
                    Page::Keybinds
                        | Page::Themes
                        | Page::Fonts
                        | Page::Palette
                        | Page::Preferences
                        | Page::AppUpdate
                        | Page::GitHub
                        | Page::AddDevice
                        | Page::AddWsl
                        | Page::Usage(_)
                        | Page::RenameDevice
                        | Page::ForwardPort
                ) && !self.cloud_dialog_open(),
                |panel| {
                    // Dialogs draw their own full-bleed header and footer rules,
                    // so the panel's own inset would cut those rules short.
                    // The device and session pickers scroll their own lists, so
                    // the panel around them stays put; a second scroller there
                    // still had its padding to move through. A session create or
                    // delete form has no inner scroller and keeps the panel's.
                    let lists = matches!(page, Page::Devices | Page::Sessions) && !session_modal;
                    panel
                        .when(!settled && !lists, |panel| panel.overflow_y_scroll())
                        .when(lists, |panel| panel.overflow_hidden())
                        .when(!matches!(page, Page::Dialog(_)), |panel| panel.p(px(6.)))
                },
            )
            .when(
                matches!(
                    page,
                    Page::Keybinds | Page::Themes | Page::Fonts | Page::Palette | Page::Preferences
                ),
                |panel| {
                    panel
                        .flex()
                        .flex_col()
                        .h(px(560. * (font.size / 12.))
                            .min((viewport.height - px(32.)).max(px(0.))))
                        .overflow_hidden()
                        .shadow_lg()
                },
            )
            .when(page == Page::GitHub, |panel| {
                panel
                    .w((viewport.width - px(32.)).max(px(0.)).min(px(400.)))
                    .flex()
                    .flex_col()
                    .overflow_hidden()
                    .shadow_lg()
            })
            .when(
                matches!(
                    page,
                    Page::Install | Page::AgentSkill | Page::VersionMismatch
                ),
                |panel| {
                    panel
                        .w((viewport.width - px(24.)).max(px(0.)).min(px(420.)))
                        .max_h((viewport.height - px(24.)).max(px(0.)))
                },
            )
            .when(
                matches!(
                    page,
                    Page::AppUpdate
                        | Page::AddDevice
                        | Page::AddWsl
                        | Page::RenameDevice
                        | Page::ForwardPort
                ) || self.cloud_dialog_open(),
                |panel| panel.flex().flex_col().overflow_hidden().shadow_lg(),
            )
            .when(page == Page::About, |panel| {
                panel.w((viewport.width - px(24.)).max(px(0.)).min(px(340.)))
            })
            .rounded(px(crate::config::corners::PANEL))
            .border_1()
            .border_color(rgb(theme.active))
            .bg(rgb(theme.surface))
            .text_color(rgb(theme.foreground))
            .text_font(font)
            .text_size(px(font.size))
            .line_height(px(font.line_height()))
            .occlude()
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .on_mouse_down(MouseButton::Right, |_, _, cx| cx.stop_propagation())
            .on_click(|_, _, cx| cx.stop_propagation())
            // A menu the pointer opened follows the pointer's own report of
            // whether it is over the popup, which occlusion and snapping make
            // impossible to infer from the anchor alone.
            .when(self.hover_menu.is_some(), |panel| {
                panel.on_hover(cx.listener(|this, hovered: &bool, _, _| {
                    if let Some(open) = &mut this.hover_menu {
                        open.inside = *hovered;
                    }
                }))
            });
        if page == Page::Menu {
            for (index, item) in self.menu_items().into_iter().enumerate() {
                panel = panel.child(
                    div()
                        .id(item)
                        .debug_selector(move || format!("menu-{item}"))
                        .min_h(px(font.line_height() + 12.))
                        .px(px(8.))
                        .flex()
                        .items_center()
                        .cursor_pointer()
                        .when(Some(index) == self.menu.selected, |row| {
                            row.bg(rgb(theme.active))
                        })
                        .on_hover(cx.listener(move |this, hovered, _, cx| {
                            if *hovered {
                                this.menu.selected = Some(index);
                            } else if this.menu.selected == Some(index) {
                                this.menu.selected = None;
                            }
                            cx.notify();
                        }))
                        .child(item)
                        .on_click(cx.listener(move |this, _, window, cx| {
                            cx.stop_propagation();
                            this.activate_menu(item, window, cx);
                        })),
                );
            }
        } else if page == Page::Devices {
            panel = panel.child(self.render_devices(cx));
        } else if page == Page::Sessions {
            panel = panel.child(self.render_sessions(cx));
        } else if let Page::Usage(provider) = page {
            panel = panel.child(self.render_usage_panel(provider, cx));
        } else if page == Page::AddDevice {
            panel = panel.child(self.render_add_device(cx));
        } else if let Some(dialog) = self.render_cloud_dialog(cx) {
            panel = panel.child(dialog);
        } else if page == Page::AddWsl {
            panel = panel.child(self.render_add_wsl(cx));
        } else if page == Page::RemoveWsl {
            panel = panel.child(self.render_remove_wsl(cx));
        } else if page == Page::GitHub {
            panel = panel.child(self.render_github_auth(cx));
        } else if page == Page::Workspace {
            // The PR card's text width: the panel's inset and border, and the
            // card's own margin, border, and padding.
            panel = panel.child(self.render_workspace_popover(
                (px(340.).min((viewport.width - px(24.)).max(px(0.))) - px(36.)).max(px(0.)),
                cx,
            ));
        } else if let Page::Dialog(action) = page {
            panel = panel.child(self.render_workspace_dialog(action, cx));
        } else if page == Page::Teleport {
            panel = panel.child(self.render_teleport(cx));
        } else if page == Page::Checkpoints {
            panel = panel.child(self.render_checkpoints(cx));
        } else if page == Page::FanOut {
            panel = panel.child(self.render_fan_out(cx));
        } else if page == Page::Git {
            panel = panel.child(self.render_git_menu(cx));
        } else if page == Page::GitCommit {
            panel = panel.child(self.render_git_commit(cx));
        } else if page == Page::PrReview {
            panel = panel.child(self.render_pr_review(cx));
        } else if page == Page::PrComment {
            panel = panel.child(self.render_pr_comment(cx));
        } else if page == Page::PrMerge {
            panel = panel.child(self.render_pr_merge(cx));
        } else if matches!(
            page,
            Page::Host | Page::RenameDevice | Page::ForwardPort | Page::RemoveDevice
        ) {
            panel = panel.child(self.render_host_menu(cx));
        } else if matches!(page, Page::Tab | Page::RenameTab) {
            panel = panel.child(self.render_tab_menu(cx));
        } else if page == Page::Group {
            panel = self.render_group_menu(panel, cx);
        } else if matches!(
            page,
            Page::Pane | Page::RenamePane | Page::PaneProcesses | Page::KillProcesses
        ) {
            panel = panel.child(self.render_pane_menu(cx));
        } else if page == Page::Keybinds {
            panel = panel.child(self.render_keybinds(cx));
        } else if page == Page::Themes {
            panel = panel.child(self.render_theme_picker(cx));
        } else if page == Page::Fonts {
            panel = panel.child(self.render_font_picker(cx));
        } else if page == Page::Palette {
            panel = panel.child(self.render_palette(cx));
        } else if page == Page::ConfirmClose {
            panel = panel.child(self.render_close_confirmation(cx));
        } else if page == Page::Preferences {
            panel = panel.child(self.render_preferences(cx));
        } else if page == Page::AppUpdate {
            panel = panel.child(self.render_app_update(window, cx));
        } else if page == Page::About {
            panel = panel.child(self.render_about(cx));
        } else if page == Page::AgentSkill {
            panel = panel.child(self.render_agent_skill_offer(cx));
        } else if page == Page::VersionMismatch {
            panel = panel.child(self.render_version_mismatch(cx));
        } else if page == Page::WorktreeScript {
            panel = panel.child(self.render_worktree_script(cx));
        } else if page == Page::Install {
            panel = panel
                .child(div().p(px(8.)).child("Herdr must be installed"))
                .child(div().p(px(8.)).child(
                    "Install Herdr first, then choose Terminal > Reconnect. The Install button opens the Herdr website; nothing is installed automatically.",
                ))
                .child(
                    div()
                        .flex()
                        .flex_wrap()
                        .gap(px(8.))
                        .p(px(8.))
                        .child(
                            div()
                                .id("menu-install")
                                .debug_selector(|| "menu-install".into())
                                .p(px(8.))
                                .rounded(px(crate::config::corners::CONTROL))
                                .bg(rgb(theme.active))
                                .cursor_pointer()
                                .child("Install")
                                .on_click(|_, _, cx| {
                                    cx.stop_propagation();
                                    cx.open_url(crate::about::WEBSITE);
                                }),
                        )
                        .child(
                            div()
                                .id("menu-dismiss")
                                .debug_selector(|| "menu-dismiss".into())
                                .p(px(8.))
                                .rounded(px(crate::config::corners::CONTROL))
                                .hover(|button| button.bg(rgb(theme.active)))
                                .cursor_pointer()
                                .child("Dismiss")
                                .on_click(cx.listener(|this, _, window, cx| {
                                    cx.stop_propagation();
                                    this.dismiss_menu(window, cx);
                                })),
                        ),
                );
        } else {
            panel = panel.child(self.render_release_notes(cx));
        }
        // Pages sit above everything GPUI draws, so the menu says what it
        // covers: a dimmed dialog covers the window, a popover its panel.
        let dims = !footer_anchored && !matches!(page, Page::Usage(_)) && !pointer_anchored;
        let cover = self.menu.cover.clone();
        if dims {
            cover.set(super::state::Cover::All);
        }
        let panel = panel.when(!dims, |panel| {
            panel.child(
                canvas(
                    // Laid out inside the panel's border; the margin takes in
                    // the border and the start of its shadow.
                    move |bounds, _, _| {
                        cover.set(super::state::Cover::Panel(bounds.dilate(px(COVER_MARGIN))))
                    },
                    |_, _, _, _| {},
                )
                .absolute()
                .inset_0(),
            )
        });
        div()
            .id("menu-overlay")
            .absolute()
            .inset_0()
            .when(dims, |overlay| {
                overlay
                    .flex()
                    .items_center()
                    .justify_center()
                    .bg(rgba((theme.background << 8) | 0xb0))
            })
            .occlude()
            .track_focus(&self.menu.focus)
            .on_action(
                cx.listener(|this, _: &actions::Cut, window, cx| this.menu_edit("x", window, cx)),
            )
            .on_action(
                cx.listener(|this, _: &actions::Copy, window, cx| this.menu_edit("c", window, cx)),
            )
            .on_action(
                cx.listener(|this, _: &actions::Paste, window, cx| this.menu_edit("v", window, cx)),
            )
            .on_action(cx.listener(|this, _: &actions::SelectAll, window, cx| {
                this.menu_edit("a", window, cx)
            }))
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, _, window, cx| {
                    cx.stop_propagation();
                    this.dismiss_menu(window, cx);
                }),
            )
            .on_scroll_wheel(|_, _, cx| cx.stop_propagation())
            .on_mouse_down(
                MouseButton::Right,
                cx.listener(|this, _, window, cx| {
                    if this.menu.opening_right_click {
                        cx.stop_propagation();
                        return;
                    }
                    // Only workspace rows may retarget this gesture. The overlay
                    // still occludes ordinary terminal and chrome handlers.
                    if this.menu.page != Some(Page::Workspace) {
                        cx.stop_propagation();
                    }
                    this.dismiss_menu(window, cx);
                }),
            )
            .on_key_down(cx.listener(Self::menu_key_down))
            .child(if pointer_anchored {
                anchored()
                    .position(if page == Page::Git {
                        point(
                            self.menu.anchor.x,
                            px(crate::titlebar::HEIGHT
                                + crate::worktree_banner::reserved(
                                    env!("HERDR_BUILD_WORKTREE") == "1",
                                )
                                + 6.),
                        )
                    } else {
                        self.menu.anchor
                    })
                    // The "…" button sits at a strip's right end, so its menu
                    // hangs leftward from it, as an editor's does.
                    .when(page == Page::Group, |menu| menu.anchor(Anchor::TopRight))
                    .snap_to_window_with_margin(Edges::all(px(12.)))
                    .child(panel)
                    .into_any_element()
            } else {
                panel.into_any_element()
            })
    }
}
