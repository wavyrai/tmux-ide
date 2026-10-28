//! Laying out the sidebar: the two lists, their headings, and the drag handle
//! that resizes the panel. Render works from prepared state and the bounded
//! caches only.

use super::{
    DEVICE_FOOTER_HEIGHT, STATUS_WIDTH, SidebarDrag,
    agents::Indicators,
    agents_sort,
    cell::{Cell, Fold, RowContext, RowData, WorkspaceRow, layout_for},
    label_text,
    layout::{self, SidebarLook},
    line_height,
    reorder::{self, Plan},
    row::{RowIcon, RowLift, RowTree},
    sidebar_width, sticky,
    tokens::{self, SpaceContext},
    visible_workspace_entries, wash,
    workspaces::{displayed_workspace_status, workspace_badge, workspace_label, workspace_note},
};
use crate::{
    Command, HerdrWindow, NavigationTarget,
    config::{FontConfig, Theme},
    fonts::StyledFont,
};
use gpui::{prelude::*, *};

mod agent_rows;

impl HerdrWindow {
    pub(crate) fn render_sidebar(
        &self,
        indicators: Indicators,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Stateful<Div> {
        let width = sidebar_width(self.sidebar_width, f32::from(window.viewport_size().width));
        let split = self.sidebar_split.unwrap_or(0.5).clamp(0.1, 0.9);
        let look = layout::for_config(&self.config);
        let rows = layout_for(self.config.layout.mode);
        // The row a workspace menu was opened for keeps looking hovered while
        // the pointer is over the menu.
        let menu_target = self.workspace_menu_target();
        let layout = look.density;
        let content_x = look.content_x();
        let view = cx.entity().downgrade();
        let font = &self.config.sidebar;
        let spaces_custom = self.config.usage.inline
            && self.config.sidebar_layout.spaces != crate::config::SpaceLayout::default();
        let theme = &self.theme;
        let mut spaces = div()
            .id("spaces-scroll")
            .debug_selector(|| "spaces-scroll".into())
            .flex()
            .flex_col()
            .flex_1()
            .min_h_0()
            .overflow_y_scroll();
        let mut agents = div()
            .id("agents-scroll")
            .debug_selector(|| "agents-scroll".into())
            .flex()
            .flex_col()
            .flex_1()
            .min_h_0()
            .overflow_y_scroll();
        spaces = spaces.track_scroll(&self.sidebar_scroll[0]);
        agents = agents.track_scroll(&self.sidebar_scroll[1]);
        let multi = self.endpoints.len() > 1;
        let mut agent_count = 0;
        // A plugin view hid every agent, rather than there being none.
        let mut filtered = false;
        // Child positions of the highlighted rows, for the one-time reveal below.
        // Agent rows are counted by `agent_count`, which indexes that list.
        let mut space_rows = 0usize;
        let mut highlighted = [None; 2];
        // Each host header's endpoint index and child position in the spaces
        // list, for the header pinned over it.
        let mut host_rows = Vec::new();
        // A lifted workspace row: each drop unit's rows in the spaces list, and
        // the move every gap makes, for the pointer handler below.
        let mut drop_rows = Vec::new();
        let mut drop_requests = Vec::new();
        let mut drop_dragged = 0;
        let now = std::time::Instant::now();
        let mut sliding = false;
        for (endpoint_index, endpoint) in self.endpoints.iter().enumerate() {
            if !self.device_visible(&endpoint.id) {
                continue;
            }
            let selected = endpoint_index == self.selected_endpoint;
            let endpoint_id = endpoint.id.clone();
            let mark = wash::HostMark::resolve(
                &self.config.sidebar_style,
                &endpoint.label,
                selected,
                theme,
            );
            if multi {
                host_rows.push((endpoint_index, space_rows));
                spaces = spaces.child(self.host_row(endpoint, selected, look, width, false, cx));
                space_rows += 1;
            }
            let row_cx = RowContext {
                indicators,
                font,
                theme,
                look,
                width,
                nest: if multi { look.nest_indent() } else { 0. },
                mark,
                host: (multi && endpoint_id != crate::endpoint::LOCAL)
                    .then_some(endpoint.label.as_str()),
            };
            let daemon = crate::listening_ports::Daemon::of(&endpoint.connection.target);
            let live = if selected { &self.live } else { &endpoint.live };
            let Some(snapshot) = &live.snapshot else {
                continue;
            };
            let collapsed_repos = if endpoint_index == 0 {
                &self.collapsed_repos
            } else {
                &endpoint.collapsed_repos
            };
            let entries = visible_workspace_entries(&snapshot.workspaces, collapsed_repos);
            let drag = self
                .workspace_drag
                .as_ref()
                .filter(|drag| selected && drag.previewing(&snapshot.workspaces));
            let floating = drag.is_some_and(|drag| drag.floating());
            let plan = drag.and_then(|drag| Plan::new(&snapshot.workspaces, &drag.workspace));
            // Each unit's shift for the drop in preview, from the heights the
            // last frame laid out: shifting moves rows, never resizes them.
            let base = space_rows;
            let shifts = plan.as_ref().map_or_else(Vec::new, |plan| {
                drop_requests = (0..=plan.len())
                    .map(|slot| plan.request(&snapshot.workspaces, slot))
                    .collect();
                drop_dragged = plan.dragged();
                let mut heights = vec![0.; plan.len()];
                for (position, entry) in entries.iter().enumerate() {
                    if let (Some(unit), Some(bounds)) = (
                        plan.unit_of(entry.0),
                        self.sidebar_scroll[0].bounds_for_item(base + position),
                    ) {
                        heights[unit] += f32::from(bounds.size.height);
                        if spaces_custom && !entry.1 {
                            heights[unit] += f32::from(self.config.sidebar_layout.spaces.row_gap)
                                * line_height(font);
                        }
                    }
                }
                let slot = drag
                    .and_then(|drag| drag.target.as_ref())
                    .map_or(plan.dragged(), |target| target.slot);
                crate::reorder::preview(&heights, plan.dragged(), slot)
            });
            // A child closes the group when no child follows it.
            let closes: Vec<bool> = (0..entries.len())
                .map(|position| {
                    entries[position].1 && !entries.get(position + 1).is_some_and(|next| next.1)
                })
                .collect();
            // Gap separates one repository from the next, not a parent from
            // the linked worktrees under it. Reset per host.
            let mut previous_indented = None;
            for (position, (index, indented, group)) in entries.into_iter().enumerate() {
                if multi && endpoint.collapsed {
                    break;
                }
                let workspace = &snapshot.workspaces[index];
                if selected && workspace.focused {
                    highlighted[0] = Some(space_rows);
                }
                let unit = plan.as_ref().and_then(|plan| plan.unit_of(index));
                // The lifted row and the rows it carries, such as its group's
                // children, follow the pointer together while it floats.
                let carried = unit.is_some_and(|unit| unit == drop_dragged) && floating;
                let shift = match (drag, unit) {
                    (Some(drag), Some(_)) if carried => {
                        drag.pin(&workspace.workspace_id, f32::from(drag.offset()), now);
                        drag.offset()
                    }
                    (Some(drag), Some(unit)) => {
                        let (at, moving) = drag.slide(&workspace.workspace_id, shifts[unit], now);
                        sliding |= moving;
                        px(at)
                    }
                    _ => px(0.),
                };
                if let Some(unit) = unit {
                    drop_rows.push((unit, space_rows, shift));
                }
                space_rows += 1;
                let id = workspace.workspace_id.clone();
                let press_id = id.clone();
                let context_id = id.clone();
                let hover_id = id.clone();
                let context_endpoint = endpoint_id.clone();
                let navigate_endpoint = endpoint_id.clone();
                let collapse_endpoint = endpoint_id.clone();
                let grouped = group.is_some() || indented;
                let tree = match (indented, closes[position]) {
                    (false, _) => RowTree::None,
                    (true, false) => RowTree::Child,
                    (true, true) => RowTree::LastChild,
                };
                let fold = group.map(|key| Fold {
                    id: SharedString::from(format!("collapse-{endpoint_id}-{id}")).into(),
                    index,
                    collapsed: collapsed_repos.contains(&key),
                    toggle: Box::new(cx.listener(move |this, _, _, cx| {
                        let collapsed = if collapse_endpoint == crate::endpoint::LOCAL {
                            &mut this.collapsed_repos
                        } else if let Some(endpoint) = this
                            .endpoints
                            .iter_mut()
                            .find(|e| e.id == collapse_endpoint)
                        {
                            &mut endpoint.collapsed_repos
                        } else {
                            return;
                        };
                        if !collapsed.remove(&key) {
                            collapsed.insert(key.clone());
                        }
                        cx.notify();
                    })),
                });
                let label = workspace_label(workspace, indented);
                let shown_status = if self.config.usage.inline {
                    displayed_workspace_status(&snapshot.workspaces, workspace, collapsed_repos)
                } else {
                    workspace.agent_status
                };
                let lines = if spaces_custom {
                    tokens::space_rows(
                        &self.config.sidebar_layout.spaces,
                        SpaceContext {
                            label,
                            branch: workspace.branch.as_deref(),
                            status: shown_status,
                            ahead_behind: workspace.git_ahead_behind,
                            tokens: &workspace.tokens,
                            indented,
                        },
                    )
                } else {
                    Vec::new()
                };
                let gap = if spaces_custom {
                    match previous_indented.replace(indented) {
                        Some(_) if !indented => {
                            f32::from(self.config.sidebar_layout.spaces.row_gap) * line_height(font)
                        }
                        _ => 0.,
                    }
                } else {
                    0.
                };
                let removing_row = selected
                    && self.live.status.is_connected()
                    && self.removal.as_ref().is_some_and(|removal| {
                        removal.pending_for(
                            (self.selection_epoch, endpoint.generation),
                            &snapshot.boot_id,
                            &workspace.workspace_id,
                        )
                    });
                // Lines under the row start under its label column, clear of
                // the status dot.
                let under_left = content_x
                    + row_cx.nest
                    + if indented {
                        layout.child_indent() + indicators.width(font) - STATUS_WIDTH
                    } else {
                        0.
                    }
                    + indicators.width(font)
                    + layout.gap();
                let note = workspace_note(
                    workspace,
                    crate::worktree_notes::Notes::of(cx),
                    &endpoint.id,
                )
                .map(SharedString::from);
                let note_line = note.clone().map(|note| {
                    let endpoint = endpoint_id.clone();
                    let workspace = id.clone();
                    super::note_line::element(
                        &format!("{endpoint_id}-{id}"),
                        note,
                        (under_left, content_x),
                        font,
                        theme,
                    )
                    .on_click(cx.listener(
                        move |this, event: &ClickEvent, window, cx| {
                            cx.stop_propagation();
                            this.edit_worktree_note(
                                &endpoint,
                                &workspace,
                                event.position(),
                                window,
                                cx,
                            );
                        },
                    ))
                });
                let ports = (self.config.show_listening_ports && !removing_row)
                    .then_some(daemon.as_ref())
                    .flatten()
                    .and_then(|daemon| self.listening_ports.get(daemon, &workspace.workspace_id))
                    .map(|listed| {
                        div()
                            .debug_selector(|| format!("ports-{endpoint_id}-{id}"))
                            .h(px(line_height(font)))
                            .flex_none()
                            .w_full()
                            .min_w_0()
                            .pl(px(under_left))
                            .pr(px(content_x))
                            .text_size(px((font.size * 0.85).round()))
                            .child(crate::listening_ports::chips(
                                listed,
                                (&endpoint_id, &workspace.workspace_id),
                                theme,
                                (font.size * 0.85).round(),
                                cx,
                            ))
                    });
                let element = Cell::new(
                    rows,
                    RowData::Workspace(WorkspaceRow {
                        workspace,
                        label,
                        tree,
                        icon: if indented {
                            RowIcon::None
                        } else {
                            self.avatars
                                .as_ref()
                                .filter(|_| endpoint_index == 0)
                                .and_then(|avatars| avatars.image(&workspace.new_workspace_cwd))
                                .map_or(RowIcon::Mark, RowIcon::Avatar)
                        },
                        fold,
                        grouped,
                        badge: workspace_badge(
                            workspace,
                            (endpoint_index == self.selected_endpoint)
                                .then_some(&self.menu.pr_cache),
                            &self.git,
                            (&self.teleport_marks, &endpoint.id),
                            note.as_deref(),
                            theme,
                        ),
                        removing: removing_row,
                        status: shown_status,
                        lines,
                    }),
                    &row_cx,
                )
                .selected(selected && workspace.focused)
                .highlighted(selected && menu_target == Some(id.as_str()))
                .lift(match (carried, floating) {
                    (true, _) => RowLift::Lifted,
                    (false, true) => RowLift::Passed,
                    (false, false) => RowLift::Resting,
                })
                .row()
                .on_mouse_down(
                    MouseButton::Right,
                    cx.listener(move |this, event: &MouseDownEvent, window, cx| {
                        cx.stop_propagation();
                        if this.navigate_endpoint(
                            &context_endpoint,
                            NavigationTarget::Workspace(&context_id),
                            cx,
                        ) {
                            this.open_workspace_menu(&context_id, event.position, window, cx);
                            this.menu.opening_right_click =
                                this.menu.page == Some(crate::menu::Page::Workspace);
                        }
                    }),
                )
                .when(
                    self.menu.page == Some(crate::menu::Page::Workspace),
                    |row| {
                        let view = cx.entity().downgrade();
                        let endpoint = endpoint_id.clone();
                        let workspace = id.clone();
                        row.child(
                            canvas(
                                |_, _, _| (),
                                move |bounds, _, window, _| {
                                    let bounds = bounds.intersect(&window.content_mask().bounds);
                                    window.on_mouse_event(
                                        move |event: &MouseDownEvent, phase, window, cx| {
                                            // The overlay dismisses first in bubble order. Use
                                            // clipped row geometry because it occludes our hitbox.
                                            if phase == DispatchPhase::Bubble
                                                && event.button == MouseButton::Right
                                                && bounds.contains(&event.position)
                                            {
                                                let _ = view.update(cx, |this, cx| {
                                                    cx.stop_propagation();
                                                    if this.navigate_endpoint(
                                                        &endpoint,
                                                        NavigationTarget::Workspace(&workspace),
                                                        cx,
                                                    ) {
                                                        this.open_workspace_menu(
                                                            &workspace,
                                                            event.position,
                                                            window,
                                                            cx,
                                                        );
                                                        this.menu.opening_right_click = this
                                                            .menu
                                                            .page
                                                            == Some(crate::menu::Page::Workspace);
                                                    }
                                                });
                                            }
                                        },
                                    );
                                },
                            )
                            .absolute()
                            .inset_0()
                            .size_full(),
                        )
                    },
                )
                .id(SharedString::from(format!("workspace-{endpoint_id}-{id}")))
                .when(multi, |row| {
                    row.debug_selector(|| format!("workspace-{endpoint_id}-{id}"))
                })
                .on_click(cx.listener(move |this, _, window, cx| {
                    this.navigate_endpoint(
                        &navigate_endpoint,
                        NavigationTarget::Workspace(&id),
                        cx,
                    );
                    window.focus(&this.focus, cx);
                }))
                // Only the selected endpoint's rows arm the hover menu:
                // another endpoint's menu would have to select it first, and
                // resting the pointer must not switch which daemon is shown.
                // The feature is opt-in, so rows stay unarmed without it.
                .when(selected && self.config.features.sidebar_hover_menu, |row| {
                    row.on_hover(cx.listener(move |this, hovered: &bool, window, _| {
                        this.hover_workspace(&hover_id, *hovered, window);
                    }))
                })
                // Holding a press lifts the row for reordering. Another
                // endpoint's rows would have to select it first.
                .when(selected, |row| {
                    row.on_mouse_down(
                        MouseButton::Left,
                        cx.listener(move |this, event: &MouseDownEvent, _, cx| {
                            if event.click_count == 1 {
                                this.press_workspace(&press_id, event.position, cx);
                            }
                        }),
                    )
                })
                .when(carried, |row| row.cursor_grabbing());
                // The note and ports ride under their row as one list item, so
                // the drop preview still measures one height per workspace.
                let element = if note_line.is_none() && ports.is_none() {
                    element
                        .when(gap > 0., |row| row.mt(px(gap)))
                        .when(shift != px(0.), |row| row.top(shift))
                        .into_any_element()
                } else {
                    div()
                        .flex()
                        .flex_col()
                        .flex_none()
                        .w_full()
                        .relative()
                        .when(gap > 0., |unit| unit.mt(px(gap)))
                        .when(shift != px(0.), |unit| unit.top(shift))
                        .child(element)
                        .children(note_line)
                        .children(ports)
                        .into_any_element()
                };
                spaces = if carried {
                    // Painted last so it floats over the rows it passes, while
                    // its layout slot keeps the others' positions stable.
                    spaces.child(deferred(element).with_priority(1))
                } else {
                    spaces.child(element)
                };
            }
            // Agent rows come after every host: the panel interleaves them.
            // Only a host the panel lists can make the view a filtered one.
            if self.config.show_agents && endpoint.enabled {
                filtered |= snapshot.agent_view_label.is_some();
            }
        }
        if self.config.show_agents {
            (agents, agent_count, highlighted[1]) =
                self.append_agent_rows(agents, indicators, look, width, cx);
        }
        if sliding {
            window.request_animation_frame();
        }
        let mut headers = if multi {
            self.host_headers(&host_rows)
        } else {
            Vec::new()
        };
        if let Some(row) = self.sidebar_pin_reveal.take()
            && self.uncover_revealed(row, &headers)
        {
            headers = self.host_headers(&host_rows);
        }
        // Rows under the pinned header are hidden, so a reveal must clear it.
        let cover = px(sticky::cover(&headers));
        let pinned_host = sticky::pinned(&headers)
            .and_then(|pinned| self.pinned_host_row(pinned, look, width, cx));
        // Follow the selection, but only once a frame has measured the viewport:
        // the handle resolves the request against the previous frame's bounds, so
        // an unmeasured list would scroll to a meaningless offset. Recording what
        // was revealed keeps later frames from undoing the user's own scrolling.
        for (list, row) in highlighted.iter().enumerate() {
            let Some(row) = *row else { continue };
            if self.sidebar_revealed[list].get() != Some(row)
                && self.sidebar_scroll[list].bounds().size.height > px(0.)
            {
                let scroll = &self.sidebar_scroll[list];
                let cover = if list == 0 { cover } else { px(0.) };
                let visible = scroll.bounds_for_item(row).is_some_and(|bounds| {
                    let offset = scroll.offset().y;
                    bounds.bottom() + offset > scroll.bounds().top() + cover
                        && bounds.top() + offset < scroll.bounds().bottom()
                });
                // Even a partially visible worktree is already seen. GPUI's
                // reveal also moves clipped rows, so only request it off-screen.
                if !visible {
                    scroll.scroll_to_item(row);
                    // The scroll lands in prepaint, after this render pinned a
                    // header for the old offset, and puts a row from above at
                    // the top edge, under the pinned header. Another frame pins
                    // for the new offset and moves the row out from under it.
                    if list == 0 && multi {
                        window.request_animation_frame();
                        self.sidebar_pin_reveal.set(Some(row));
                    }
                }
                self.sidebar_revealed[list].set(Some(row));
            }
        }
        if agent_count == 0 {
            agents = agents.child(
                div()
                    .px(px(content_x))
                    .text_color(rgb(theme.muted))
                    .truncate()
                    .child(label_text(if filtered {
                        "no matching agents"
                    } else {
                        "no agents"
                    })),
            );
        }
        div()
            .id("sidebar")
            .debug_selector(|| "sidebar".into())
            .relative()
            .w(px(width))
            .flex_none()
            .h_full()
            .min_h_0()
            .overflow_hidden()
            .flex()
            .flex_col()
            .text_font(font)
            .text_size(px(font.size))
            .line_height(px(line_height(font)))
            .text_color(rgb(theme.foreground))
            .bg(rgb(theme.sidebar_background()))
            .border_r_1()
            .border_color(rgb(theme.active))
            // Zero flex bases keep long workspace lists from displacing agents.
            .child(
                div()
                    .debug_selector(|| "spaces-section".into())
                    .flex()
                    .flex_col()
                    .flex_1()
                    .map(|mut section| {
                        section.style().flex_grow =
                            Some(if self.config.show_agents { split } else { 1. });
                        section
                    })
                    .min_h_0()
                    .overflow_hidden()
                    .child(header("spaces", font, theme, look))
                    // The wrapper clips the pinned header as the next host's
                    // pushes it up, so it never paints over the title above.
                    .child(
                        div()
                            .relative()
                            .flex_1()
                            .min_h_0()
                            .flex()
                            .flex_col()
                            .overflow_hidden()
                            .child(spaces)
                            .children(pinned_host),
                    )
                    .child(
                        div()
                            .flex_none()
                            .h(px(line_height(font) + 2. * layout.footer_padding()))
                            .px(px(content_x))
                            .flex()
                            .items_center()
                            // Menu hugs the sidebar's edge, as in the terminal client.
                            .justify_between()
                            .text_color(rgb(theme.muted))
                            .gap(px(20.))
                            .child(
                                div()
                                    .id("new-workspace")
                                    .cursor_pointer()
                                    .hover(|s| s.text_color(rgb(theme.foreground)))
                                    .child("new")
                                    .on_click(cx.listener(|this, _, window, cx| {
                                        this.command(Command::Workspace, window, cx)
                                    })),
                            )
                            .child(
                                div()
                                    .id("sidebar-menu")
                                    .debug_selector(|| "sidebar-menu".into())
                                    .cursor_pointer()
                                    .hover(|s| s.text_color(rgb(theme.foreground)))
                                    .child(label_text("menu"))
                                    .on_click(cx.listener(
                                        |this, event: &ClickEvent, window, cx| {
                                            this.menu.anchor = event.position();
                                            this.open_menu(window, cx);
                                        },
                                    )),
                            ),
                    ),
            )
            .when(self.config.show_agents, |sidebar| {
                sidebar
                    .child(
                        div()
                            .id("sidebar-split-resize")
                            .debug_selector(|| "sidebar-split-resize".into())
                            .h(px(6.))
                            .flex_none()
                            .cursor(CursorStyle::ResizeUpDown)
                            .border_t_1()
                            .border_color(rgb(theme.active))
                            .hover(|s| s.bg(rgba(crate::panel_resize::RESIZE_HOVER)))
                            .on_mouse_down(
                                MouseButton::Left,
                                cx.listener(|this, event: &MouseDownEvent, _, cx| {
                                    cx.stop_propagation();
                                    this.sidebar_split_modified = true;
                                    if event.click_count == 2 {
                                        this.sidebar_drag = None;
                                        this.sidebar_split = None;
                                        this.save_chrome();
                                    } else {
                                        this.sidebar_drag = Some(SidebarDrag::Split);
                                    }
                                    cx.notify();
                                }),
                            ),
                    )
                    .child(
                        div()
                            .debug_selector(|| "agents-section".into())
                            .flex()
                            .flex_col()
                            .flex_1()
                            .map(|mut section| {
                                section.style().flex_grow = Some(1. - split);
                                section
                            })
                            .min_h_0()
                            .overflow_hidden()
                            .child(
                                header("agents", font, theme, look)
                                    .justify_between()
                                    .child(agents_sort(self, cx)),
                            )
                            .child(agents),
                    )
            })
            .child(self.render_device_footer(cx))
            .child(
                div()
                    .id("sidebar-resize")
                    .debug_selector(|| "sidebar-resize".into())
                    .absolute()
                    .right_0()
                    .top_0()
                    .h_full()
                    .w(px(6.))
                    .cursor(CursorStyle::ResizeLeftRight)
                    .hover(|s| s.bg(rgba(crate::panel_resize::RESIZE_HOVER)))
                    .on_mouse_down(
                        MouseButton::Left,
                        cx.listener(move |this, event: &MouseDownEvent, _, cx| {
                            cx.stop_propagation();
                            this.sidebar_modified = true;
                            if event.click_count == 2 {
                                this.sidebar_drag = None;
                                this.sidebar_width = None;
                                this.save_sidebar_width();
                            } else {
                                this.sidebar_drag = Some(SidebarDrag::Width {
                                    start: f32::from(event.position.x),
                                    width,
                                });
                            }
                            cx.notify();
                        }),
                    ),
            )
            .child(
                canvas(
                    |_, _, _| (),
                    move |bounds, _, window, _| {
                        // Capture globally so dragging continues outside the narrow divider,
                        // and terminal handlers never receive the resize gesture's release.
                        let moving = view.clone();
                        window.on_mouse_event(move |event: &MouseMoveEvent, phase, window, cx| {
                            if phase == DispatchPhase::Capture {
                                let _ = moving.update(cx, |this, cx| {
                                    let scroll = this.sidebar_scroll[0].clone();
                                    if this.move_workspace_drag(
                                        event.position,
                                        event.pressed_button == Some(MouseButton::Left),
                                        |lift| {
                                            reorder::resolve(
                                                &drop_rows,
                                                &drop_requests,
                                                drop_dragged,
                                                &scroll,
                                                lift,
                                            )
                                        },
                                        cx,
                                    ) {
                                        cx.stop_propagation();
                                    } else if let Some(drag) = this.sidebar_drag {
                                        match drag {
                                            SidebarDrag::Width { start, width } => {
                                                this.sidebar_width = Some(sidebar_width(
                                                    Some(
                                                        width + f32::from(event.position.x) - start,
                                                    ),
                                                    f32::from(window.viewport_size().width),
                                                ));
                                            }
                                            SidebarDrag::Split => {
                                                let height = (f32::from(bounds.size.height)
                                                    - 6.
                                                    - DEVICE_FOOTER_HEIGHT)
                                                    .max(1.);
                                                this.sidebar_split = Some(
                                                    ((f32::from(
                                                        event.position.y - bounds.origin.y,
                                                    ) - 3.)
                                                        / height)
                                                        .clamp(0.1, 0.9),
                                                );
                                            }
                                        }
                                        cx.stop_propagation();
                                        cx.notify();
                                    }
                                });
                            }
                        });
                        let released = view.clone();
                        window.on_mouse_event(move |event: &MouseUpEvent, phase, _, cx| {
                            if phase == DispatchPhase::Capture && event.button == MouseButton::Left
                            {
                                let _ = released.update(cx, |this, cx| {
                                    // A lifted row's release is its drop, not a click.
                                    if this.release_workspace_drag(cx) {
                                        cx.stop_propagation();
                                    } else if this.sidebar_drag.take().is_some() {
                                        this.save_chrome();
                                        cx.stop_propagation();
                                        cx.notify();
                                    }
                                });
                            }
                        });
                    },
                )
                .absolute()
                .size_full(),
            )
    }
}

pub(super) fn header(
    label: &'static str,
    font: &FontConfig,
    theme: &Theme,
    look: SidebarLook,
) -> Div {
    div()
        .debug_selector(|| format!("header-{label}"))
        .flex_none()
        .h(px(line_height(font) + 2. * look.density.header_padding()))
        .px(px(look.content_x()))
        .flex()
        .items_center()
        .text_size(px(font.size))
        .text_color(rgb(theme.muted))
        .child(
            div()
                .debug_selector(|| format!("header-label-{label}"))
                .child(label_text(&look.header_label(label))),
        )
}
