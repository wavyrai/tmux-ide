//! Painting the window from prepared state. Render reads bounded caches and
//! the latest projection only: it never queries the daemon, touches disk, or
//! starts a process.

use super::{HerdrWindow, PressedLink};
use crate::{
    CheckForUpdates, Minimize, PlaySound, RunCommand, ShowHerdrNotDetected, ShowUpdatePreview,
    actions::{RingBellPreview, ShowToastPreview},
    browser::{Pick, Shown, Slot},
    config::ClipboardToastPosition,
    fonts::StyledFont,
    terminal::*,
    terminal_painter::{self, ImageTarget, PlacedImages},
};
use gpui::{prelude::*, *};
use herdr_client::ConnectOptions;

impl HerdrWindow {
    /// Config warnings, then the daemon's announcement, stacked over the
    /// top-right of the terminal area below the tab strip, whose buttons stay
    /// reachable. A menu page owns the window's attention; they wait behind it.
    fn render_notices(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        if self.menu.page.is_some() {
            return None;
        }
        let mut cards = self.config_diagnostic_cards(cx);
        cards.extend(self.announcement_card(cx));
        if cards.is_empty() {
            return None;
        }
        // Spans the terminal area so a narrow window shrinks the cards rather
        // than pushing them off the left edge.
        Some(
            div()
                .absolute()
                .top(px(self.tab_strip_height() + 8.))
                .left(px(8.))
                .right(px(8.))
                .flex()
                .flex_col()
                .items_end()
                .gap(px(8.))
                .children(cards)
                .into_any_element(),
        )
    }
}

impl Render for HerdrWindow {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.restore_menu_focus(window, cx);
        self.viewport_width = f32::from(window.viewport_size().width);
        let font = self.config.terminal.font();
        // Parked groups paint with the same face as the window's terminal.
        let parked_font = font.clone();
        let cell_height = self.config.terminal.line_height();
        self.painter.borrow_mut().set_appearance(
            self.config.terminal.size,
            cell_height,
            self.theme.clone(),
        );
        self.cell_width = self.painter.borrow_mut().cell_width(&font, window, cx);
        // Registers the window for surface-only redraws; see `redraw_terminal`.
        self.surface_signal.read(cx);
        let sidebar = self
            .sidebar_mode()
            .width(self.sidebar_width, f32::from(window.viewport_size().width))
            .map(|width| crate::sidebar::cached_view(&self.sidebar_view, width));
        // Paints the frame on screen, which during a focus change is the one
        // presented before it: the terminal area never blanks between two
        // projections. What the client knows to be current stays in `live`.
        let picture = self.presentation.picture(&self.live);
        let surface = picture.as_ref().map(|picture| picture.frame.clone());
        let images = picture.as_ref().map(|picture| picture.images.clone());
        // A group picking the tab another shows paints this same frame.
        let window_frame = picture;
        let entity = cx.entity();
        let paint_entity = entity.clone();
        let focus = self.focus.clone();
        let menu_open = self.menu.page.is_some();
        let cell_width = self.cell_width;
        let painter = self.painter.clone();
        // The highlight is grid coordinates, so it paints with the frame that
        // owns the cells rather than being recomputed from the pointer here.
        let selection_rows = |owned: bool| -> Vec<_> {
            surface
                .as_deref()
                .zip(self.selection.as_ref().filter(|_| owned))
                .into_iter()
                .flat_map(|(surface, selection)| selection.rows(surface, cell_width, cell_height))
                .map(|(row, columns)| terminal_painter::Highlight {
                    row,
                    columns,
                    tint: terminal_painter::Tint::Selection,
                })
                .collect()
        };
        // The highlight belongs to the frame that owns the cells, so only one
        // of the panes and the popup paints it.
        let popup_highlights = surface
            .as_deref()
            .and_then(|surface| surface.popup.as_ref())
            .map(|popup| {
                selection_rows(
                    self.selection
                        .as_ref()
                        .is_some_and(|selection| selection.in_popup(&popup.terminal_id)),
                )
            })
            .unwrap_or_default();
        let pane_selection = selection_rows(
            self.selection
                .as_ref()
                .is_some_and(|selection| selection.in_panes()),
        );
        // Like the highlight, the link underline paints with the frame that
        // owns its cells, and only while that frame shows the content the
        // daemon resolved it from. Without one, the row-local reading under
        // the pointer is underlined instead.
        let link_rows: Vec<_> = surface
            .as_deref()
            .zip(self.hovered_daemon_link())
            .filter(|(surface, link)| link.cell.current(surface))
            .map(|(_, link)| link.frame_rows().collect())
            .or_else(|| {
                let link = self.hovered_local_link()?;
                Some(vec![(link.row, link.columns.clone())])
            })
            .unwrap_or_default();
        // Search matches, mapped onto the frame on screen, tint below the
        // selection, which reads as chosen over them. A popup covers the
        // panes, so their matches stay under it.
        let mut highlights = surface
            .as_deref()
            .map(|surface| {
                let mut highlights = self.find_highlights(surface);
                highlights.extend(self.copy_mode_highlights(surface));
                highlights
            })
            .unwrap_or_default();
        highlights.extend(pane_selection);
        let look = super::regions::Look {
            font: font.clone(),
            font_size: self.config.terminal.size,
            cell_width,
            cell_height,
            theme: self.theme.clone(),
        };
        let regions = self.terminal_regions(surface.as_ref(), &highlights, &look, cx);
        // Without regions the canvas paints the whole grid, images included.
        let whole = regions.is_empty();
        // The IME composition paints inline at the input cursor; a menu's
        // text field shows its own.
        // It anchors to the live surface, as the IME's candidate window does,
        // so a retained frame never separates the text from the window.
        let marked = (!menu_open && !self.marked.is_empty())
            .then(|| (self.marked.clone(), self.live.surface.clone()));
        self.hovered_terminal_link =
            self.terminal_link_hovered(window.mouse_position(), window.modifiers());
        self.split_cursor = self.split_cursor_at(window.mouse_position());
        // Pad the terminal itself: the canvas bounds that painting, hit testing,
        // and IME placement all read then already exclude the gap.
        let sidebar_gap = if sidebar.is_some() {
            self.config.layout.sidebar_gap
        } else {
            0.
        };
        // Only the first group meets the sidebar, so only it takes the gap.
        self.ensure_layout();
        self.forget_gone_strips();
        let slots = self.group_slots();
        let shown: Vec<Shown> = slots
            .iter()
            .map(|slot| self.group_shown(slot.id, cx))
            .collect();
        let slot_gap = |slot: Slot| if slot.index == 0 { sidebar_gap } else { 0. };
        // The window's own terminal, with its input, goes to the group holding
        // its connection; other terminal groups paint parked connections.
        let primary = self.primary_group();
        let terminal_slot = slots
            .iter()
            .zip(&shown)
            .find(|(slot, shown)| {
                **shown == Shown::Terminal && primary.is_none_or(|group| group == slot.id)
            })
            .map(|(slot, _)| *slot);
        let terminal_gap = terminal_slot.map_or(sidebar_gap, slot_gap);
        let find_bar = self.render_find_bar(surface.as_deref(), terminal_gap, cx);
        let copy_badge = self.render_copy_mode_badge(surface.as_deref(), terminal_gap);
        let terminal = div()
            .id("terminal")
            .debug_selector(|| "terminal".into())
            .pl(px(terminal_gap))
            .when(self.hovered_terminal_link, |terminal| {
                terminal.cursor_pointer()
            })
            .when_some(self.split_cursor, |terminal, cursor| {
                terminal.cursor(cursor)
            })
            .on_mouse_move(cx.listener(|this, event: &MouseMoveEvent, _, cx| {
                let split_cursor = this.split_cursor_at(event.position);
                if split_cursor != this.split_cursor {
                    this.split_cursor = split_cursor;
                    cx.notify();
                }
                // A border is not the application's to hover.
                if split_cursor.is_none() {
                    this.terminal_mouse_hover(event, cx);
                }
                let hovered = this.terminal_link_hovered(event.position, event.modifiers);
                if hovered != this.hovered_terminal_link {
                    this.hovered_terminal_link = hovered;
                    cx.notify();
                }
            }))
            // Holding the link modifier over a link in a mouse-reporting
            // application changes what a click does, so the pointer follows.
            .on_modifiers_changed(
                cx.listener(|this, event: &ModifiersChangedEvent, window, cx| {
                    this.hover_link(window.mouse_position(), event.modifiers, cx);
                    let hovered =
                        this.terminal_link_hovered(window.mouse_position(), event.modifiers);
                    if hovered != this.hovered_terminal_link {
                        this.hovered_terminal_link = hovered;
                        cx.notify();
                    }
                }),
            )
            .on_click(cx.listener(Self::open_terminal_link))
            .relative()
            .flex_1()
            .min_h_0()
            .min_w_0()
            .overflow_hidden()
            .bg(rgb(self.theme.background))
            .track_focus(&self.focus)
            // Screen readers and selection tools read the rows on screen and
            // the selection among them. The rows are built while GPUI
            // prepaints, and only while an assistive client is listening.
            .role(Role::Terminal)
            .when(
                window.is_a11y_active() && self.live.surface_ready(),
                |terminal| {
                    let surface = self.live.surface.clone();
                    let selection = self.selection.clone();
                    let cell_width = self.cell_width;
                    let cell_height = self.config.terminal.line_height();
                    let origin = (
                        f32::from(self.bounds.origin.x),
                        f32::from(self.bounds.origin.y),
                    );
                    let scale = window.scale_factor();
                    terminal.a11y_synthetic_children(move |builder| {
                        if let Some(transcript) = surface.as_deref().and_then(|surface| {
                            Transcript::read(surface, selection.as_ref(), cell_width, cell_height)
                        }) {
                            transcript.expose(builder, origin, scale);
                        }
                    })
                },
            )
            .on_key_down(cx.listener(Self::key_down))
            .on_key_up(cx.listener(Self::key_up))
            // The terminal has nothing for Cut or Select All to act on, and
            // Copy only while a released selection is still highlighted.
            .on_action(cx.listener(|this, _: &crate::actions::Paste, _, cx| this.paste(cx)))
            .when(self.selection_retained(), |terminal| {
                terminal.on_action(cx.listener(|this, _: &crate::actions::Copy, _, cx| {
                    this.copy_retained_selection(cx);
                }))
            })
            .on_scroll_wheel(cx.listener(Self::scroll_wheel))
            .on_drop(cx.listener(Self::drop_terminal_files))
            .on_mouse_down(
                MouseButton::Middle,
                cx.listener(|this, event: &MouseDownEvent, window, cx| {
                    this.terminal_mouse_down(event, window, cx);
                }),
            )
            .on_mouse_down(
                MouseButton::Right,
                cx.listener(|this, event: &MouseDownEvent, window, cx| {
                    if this.terminal_mouse_down(event, window, cx) {
                        return;
                    }
                    cx.stop_propagation();
                    this.open_pane_menu_at(event.position, window, cx);
                    this.menu.opening_right_click = this.menu.page == Some(crate::menu::Page::Pane);
                }),
            )
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, event: &MouseDownEvent, window, cx| {
                    if this.scrollbar_mouse_down(event, cx)
                        || this.split_mouse_down(event, cx)
                        || this.terminal_mouse_down(event, window, cx)
                    {
                        return;
                    }
                    this.pressed_terminal_link =
                        this.terminal_link_press(event.position, event.modifiers);
                    if this.menu.page.is_some() {
                        return;
                    }
                    // A press on a link may still turn into a drag across it,
                    // so the selection starts either way; the click that opens
                    // the link is the one that never left its half-cell.
                    this.begin_selection(event.position, event.click_count, cx);
                    if this.pressed_terminal_link.is_some() {
                        cx.stop_propagation();
                        return;
                    }
                    window.focus(&this.focus, cx);
                    if this.input_ready()
                        && let Some(surface) = &this.live.surface
                    {
                        let pane = pane_at(
                            surface,
                            this.bounds,
                            event.position,
                            this.cell_width,
                            this.config.terminal.line_height(),
                        )
                        .map(str::to_owned);
                        if let Some(id) = pane {
                            this.focus_clicked_pane(&id, cx);
                        }
                    }
                }),
            )
            // The cached regions paint the cells; the canvas above them takes
            // input and paints what changes without them. Both fill this box,
            // so every region shares the canvas's bounds.
            .child(
                div().relative().size_full().children(regions).child(
                    canvas(
                        move |bounds, _, cx| {
                            entity.update(cx, |this, _| {
                                this.bounds = bounds;
                                this.options = ConnectOptions {
                                    surface_size: viewport(
                                        bounds.size.width.to_f64() as f32,
                                        bounds.size.height.to_f64() as f32,
                                        cell_width,
                                        cell_height,
                                    ),
                                    cell_width_px: cell_width.round().max(1.) as u32,
                                    cell_height_px: cell_height.round().max(1.) as u32,
                                };
                                this.resize();
                            });
                        },
                        move |bounds, _, window, cx| {
                            // Capture movement outside the terminal too, before any
                            // element can stop propagation of a drag-away event.
                            let entity = paint_entity.clone();
                            window.on_mouse_event(move |event: &MouseMoveEvent, phase, _, cx| {
                                if phase == DispatchPhase::Capture {
                                    entity.update(cx, |this, cx| {
                                        // Window-wide, so leaving the terminal
                                        // drops the underline too.
                                        this.hover_link(event.position, event.modifiers, cx);
                                        if this.scrollbar_mouse_move(event, cx)
                                            || this.split_mouse_move(event, cx)
                                            || this.terminal_mouse_move(event, cx)
                                        {
                                            cx.stop_propagation();
                                            return;
                                        }
                                        if this.pressed_terminal_link.as_ref().is_some_and(
                                            |PressedLink { position, .. }| {
                                                (event.position.x - position.x).abs() > px(4.)
                                                    || (event.position.y - position.y).abs()
                                                        > px(4.)
                                            },
                                        ) {
                                            this.pressed_terminal_link = None;
                                        }
                                        // A drag that leaves the terminal keeps
                                        // selecting, and hover work elsewhere stays
                                        // out of the gesture.
                                        if this.extend_selection(event.position, cx) {
                                            cx.stop_propagation();
                                        }
                                    });
                                }
                            });
                            let released = paint_entity.clone();
                            window.on_mouse_event(move |event: &MouseUpEvent, phase, _, cx| {
                                if phase == DispatchPhase::Capture {
                                    released.update(cx, |this, cx| {
                                        // Global: the overlay occludes the opener, and release
                                        // may also precede the overlay's first frame.
                                        if matches!(
                                            event.button,
                                            MouseButton::Left | MouseButton::Right
                                        ) {
                                            this.menu.opening_right_click = false;
                                        }
                                        if this.scrollbar_mouse_up(event, cx)
                                            || this.split_mouse_up(event, cx)
                                            || this.terminal_mouse_up(event, cx)
                                            || (event.button == MouseButton::Left
                                                && !cx.has_active_drag()
                                                && this.release_selection(cx))
                                        {
                                            cx.stop_propagation();
                                        }
                                    });
                                }
                            });
                            window.handle_input(
                                &focus,
                                crate::input::TerminalInputHandler::new(
                                    bounds,
                                    paint_entity.clone(),
                                    menu_open,
                                ),
                                cx,
                            );
                            if let Some(surface) = &surface {
                                if whole {
                                    painter.borrow_mut().paint_frame(
                                        &surface.frame,
                                        bounds.origin,
                                        Some(bounds.size),
                                        cell_width,
                                        &font,
                                        &highlights,
                                        &surface.panes,
                                        None,
                                        images.as_deref().map(|images| PlacedImages {
                                            placements: &surface.graphics.placements,
                                            images,
                                            target: ImageTarget::Main,
                                        }),
                                        window,
                                        cx,
                                    );
                                } else {
                                    // Regions place no images, so nothing
                                    // else releases the ones that went away.
                                    painter.borrow_mut().release_idle_images(window);
                                }
                                painter.borrow().paint_link(
                                    &surface.frame,
                                    bounds.origin,
                                    cell_width,
                                    &link_rows,
                                    window,
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
                                        &popup_highlights,
                                        &[],
                                        None,
                                        images.as_deref().map(|images| PlacedImages {
                                            placements: &surface.graphics.placements,
                                            images,
                                            target: ImageTarget::Popup(&popup.terminal_id),
                                        }),
                                        window,
                                        cx,
                                    );
                                }
                            }
                            if let Some((marked, live)) = &marked {
                                let live = live.as_deref();
                                painter.borrow().paint_composition(
                                    marked,
                                    input_cursor_bounds(
                                        live,
                                        bounds.origin,
                                        cell_width,
                                        cell_height,
                                    )
                                    .origin,
                                    input_area(live, bounds, cell_width, cell_height),
                                    &font,
                                    window,
                                );
                            }
                        },
                    )
                    .size_full(),
                ),
            )
            .children(self.render_reconnecting(cx))
            .when_some(find_bar, |terminal, bar| terminal.child(bar))
            .when_some(copy_badge, |terminal, badge| terminal.child(badge))
            // Direct feedback for the user's own gesture, not a daemon notice:
            // it sits over the cells it copied and needs no dismissing.
            .when_some(self.flash.as_ref(), |terminal, (flash, _)| {
                use ClipboardToastPosition::*;
                let position = self.config.clipboard_toast.position;
                terminal.child(
                    div()
                        .absolute()
                        .map(|row| match position {
                            TopLeft | TopCenter | TopRight => row.top(px(12.)),
                            BottomLeft | BottomCenter | BottomRight => row.bottom(px(12.)),
                        })
                        .map(|row| match position {
                            TopLeft | BottomLeft => row.justify_start(),
                            TopCenter | BottomCenter => row.justify_center(),
                            TopRight | BottomRight => row.justify_end(),
                        })
                        // The pane's own padding is not part of the terminal:
                        // the flash spans the cells, so centering centers on
                        // them and a corner is the corner of the grid.
                        .left(px(terminal_gap))
                        .right_0()
                        .px(px(12.))
                        .flex()
                        .overflow_hidden()
                        .child(
                            div()
                                .debug_selector(|| "flash".into())
                                .min_w_0()
                                .flex()
                                .items_center()
                                .gap(px(8.))
                                .px(px(12.))
                                .py(px(6.))
                                .rounded(px(crate::config::corners::CONTROL))
                                .border_1()
                                .border_color(rgb(flash.accent(&self.theme)))
                                .bg(rgb(self.theme.surface))
                                .text_color(rgb(self.theme.foreground))
                                .child(
                                    div()
                                        .size(px(6.))
                                        .flex_none()
                                        .rounded_full()
                                        .bg(rgb(flash.accent(&self.theme))),
                                )
                                .child(div().truncate().child(flash.text.clone())),
                        ),
                )
            });
        // A focus handle belongs to one element: the terminal when drawn,
        // otherwise the group in use.
        let keyboard = terminal_slot
            .is_none()
            .then(|| self.active_group())
            .flatten();
        let mut terminal = Some(terminal);
        let merged = slots
            .first()
            .is_some_and(|first| self.tabs_in_titlebar(first.id, cx));
        let count = slots.len();
        let mut groups = Vec::with_capacity(count);
        for (slot, shown) in slots.into_iter().zip(shown) {
            let gap = slot_gap(slot);
            let owns_keyboard = keyboard == Some(slot.id);
            let tab = match &shown {
                Shown::Page(id) => cx
                    .try_global::<crate::browser::Store>()
                    .and_then(|store| store.get(*id))
                    .cloned(),
                _ => None,
            };
            let body = match (&shown, tab) {
                (Shown::Terminal, _) if terminal_slot == Some(slot) => terminal
                    .take()
                    .map(IntoElement::into_any_element)
                    .unwrap_or_else(|| div().into_any_element()),
                (Shown::Terminal, _) if self.shows_parked_terminal(slot.id, cx) => {
                    self.render_parked_terminal(slot, gap, parked_font.clone(), cell_height, cx)
                }
                // A review tab is drawn by the app, never a page.
                (Shown::Page(_), Some(tab))
                    if tab
                        .location
                        .as_ref()
                        .is_some_and(|location| !location.is_page()) =>
                {
                    self.render_review_tab(slot, &tab, gap, cx)
                }
                (Shown::Page(_), Some(tab)) => {
                    self.render_browser(slot, &tab, gap, owns_keyboard, cx)
                }
                (Shown::Elsewhere(Pick::Herdr(tab)), _) => {
                    match self.live_frame_of(tab, window_frame.clone()) {
                        Some(frame) => self.render_terminal_mirror(
                            slot,
                            gap,
                            Some(frame),
                            parked_font.clone(),
                            cell_height,
                            cx,
                        ),
                        None => self.render_stand_in(slot, &shown, gap, owns_keyboard, cx),
                    }
                }
                _ => self.render_stand_in(slot, &shown, gap, owns_keyboard, cx),
            };
            let ends = merged.then(|| crate::titlebar::Ends::of(slot.index, count));
            groups.push(self.render_group(slot, body, ends, window, cx));
        }
        let content = self.render_groups(groups, cx);
        // Not `||`: asking forgets group motion that has finished.
        if self.groups_moving() | self.tabs_growing() | self.annotations_moving() {
            window.request_animation_frame();
        }
        // A menu just opened, or a covered page's picture is on its way.
        if self.present_browser(cx) {
            window.request_animation_frame();
        }
        let root = div()
            .on_modifiers_changed(cx.listener(Self::double_shift_modifiers))
            .capture_any_mouse_down(cx.listener(|this, _, _, _| this.shift_taps.cancel()))
            .child({
                let entity = cx.weak_entity();
                canvas(
                    |_, _, _| (),
                    move |_, _, window, _| {
                        let scroll_entity = entity.clone();
                        window.on_mouse_event(move |_: &ScrollWheelEvent, phase, _, cx| {
                            if phase == DispatchPhase::Capture {
                                let _ =
                                    scroll_entity.update(cx, |this, _| this.shift_taps.cancel());
                            }
                        });
                        let entity = entity.clone();
                        window.on_mouse_event(move |_: &MouseMoveEvent, phase, _, cx| {
                            if phase == DispatchPhase::Capture {
                                let _ = entity.update(cx, |this, _| this.shift_taps.cancel());
                            }
                        });
                    },
                )
                .absolute()
                .size_full()
            })
            .on_action(
                cx.listener(|this, action: &crate::actions::SetLayout, _, cx| {
                    this.set_layout(action.mode, cx);
                }),
            )
            .on_action(cx.listener(|this, action: &RunCommand, window, cx| {
                this.command(action.command, window, cx);
            }))
            .on_action(cx.listener(|_, _: &Minimize, window, _| {
                window.minimize_window();
            }))
            .on_action(cx.listener(|this, _: &ShowHerdrNotDetected, window, cx| {
                this.show_install_modal(window, cx);
            }))
            .on_action(cx.listener(|this, _: &CheckForUpdates, window, cx| {
                this.open_app_update(false, window, cx);
                this.updater.check();
            }))
            .on_action(cx.listener(|this, _: &ShowUpdatePreview, window, cx| {
                this.open_app_update(true, window, cx);
            }))
            .on_action(cx.listener(
                |this, _: &crate::actions::ShowUpdateDownloadPreview, window, cx| {
                    this.open_update_progress_preview(
                        crate::updater::State::Downloading {
                            received: 50_000_000,
                            total: 100_000_000,
                        },
                        window,
                        cx,
                    );
                },
            ))
            .on_action(cx.listener(
                |this, _: &crate::actions::ShowUpdateHomebrewPreview, window, cx| {
                    this.open_update_progress_preview(
                        crate::updater::State::Upgrading {
                            detail: "Refreshing Homebrew metadata with brew update...".into(),
                        },
                        window,
                        cx,
                    );
                },
            ))
            .on_action(cx.listener(|this, action: &ShowToastPreview, _, cx| {
                this.show_toast_preview(action.kind, cx);
            }))
            .on_action(cx.listener(
                |this, _: &crate::actions::ShowSystemNotificationPreview, window, cx| {
                    this.show_system_notification_preview(window, cx);
                },
            ))
            .on_action(cx.listener(|this, _: &PlaySound, _, _| {
                this.sound.preview();
            }))
            .on_action(cx.listener(|this, _: &RingBellPreview, window, cx| {
                this.preview_bell(window, cx);
            }))
            .size_full()
            .relative()
            .flex()
            .flex_col()
            .bg(rgb(self.theme.background))
            .text_color(rgb(self.theme.foreground))
            .text_font(&self.config.ui)
            .text_size(px(self.config.ui.size))
            .when(!merged, |root| root.child(self.render_titlebar(window, cx)))
            // Under the traffic lights a banner would hide them, so with no
            // header it moves to the window's foot.
            .when(!merged, |root| root.children(self.render_worktree_banner()))
            .child(
                div()
                    .debug_selector(|| "window-body".into())
                    .flex()
                    .flex_1()
                    .min_h_0()
                    .children(sidebar.map(|sidebar| match merged {
                        true => self.sidebar_column(sidebar, window, cx).into_any_element(),
                        false => sidebar.into_any_element(),
                    }))
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .flex_1()
                            .min_w_0()
                            .min_h_0()
                            .relative()
                            .child(content)
                            .children(self.render_notices(cx))
                            .when(self.status_bar_visible, |column| {
                                column.child(self.render_status_bar(cx))
                            }),
                    ),
            )
            .when(merged, |root| root.children(self.render_worktree_banner()))
            .children(self.render_toasts(window, cx))
            .children(self.render_file_transfer(window, cx))
            .when(self.menu.page.is_some(), |root| {
                root.child(self.render_menu(window, cx))
            });
        crate::titlebar::frame(window, self.theme.active, root)
    }
}
