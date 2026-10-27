//! The host header row of the spaces list, and the copy of it pinned over the
//! top of a scrolled list.

use super::{
    HOST_ARROW_WIDTH, STATUS_WIDTH,
    cell::RowState,
    label_text,
    layout::SidebarLook,
    line_height,
    row::removing_dot,
    sticky::{self, HostHeader},
    wash,
};
use crate::{HerdrWindow, endpoint::Endpoint};
use gpui::{prelude::*, *};

impl HerdrWindow {
    /// A host's header row. `pinned` draws the copy that sits over the list
    /// instead of the one inside it: the same row under `sticky-` ids, so the
    /// two never share element state, with an opaque background for the rows
    /// scrolling beneath it.
    pub(super) fn host_row(
        &self,
        endpoint: &Endpoint,
        selected: bool,
        look: SidebarLook,
        width: f32,
        pinned: bool,
        cx: &mut Context<Self>,
    ) -> Stateful<Div> {
        let font = &self.config.sidebar;
        let theme = &self.theme;
        let layout = look.density;
        let content_x = look.content_x();
        let host_gap = layout.host_gap();
        // The label yields room to the arrow and to the trailing status dot.
        let host_label_width =
            (look.content_width(width) - HOST_ARROW_WIDTH - 2. * host_gap - STATUS_WIDTH).max(0.);
        let prefix = if pinned { "sticky-" } else { "" };
        let endpoint_id = endpoint.id.clone();
        let collapse_id = endpoint_id.clone();
        let select_id = endpoint_id.clone();
        let menu_id = endpoint_id.clone();
        let removing = self.menu.removing_devices.contains(&endpoint.id);
        // A cloud machine has no host to read its load from.
        let host = crate::usage::Host::of(&endpoint.connection.target);
        let load = host
            .as_ref()
            .filter(|_| self.config.show_system_load)
            .and_then(|host| self.system_load.get(host));
        // Densities with detail lines give the load its own line;
        // compact ones fit gauges between the name and the status.
        let load_line = load.filter(|_| layout.workspace_details());
        let gauges = load.filter(|_| load_line.is_none()).map(|reading| {
            crate::system_load::gauges(
                reading,
                theme,
                super::metrics::glyph_width(font),
                (font.size * 0.8).round(),
            )
        });
        // The removal pulse and the gauges take their room from the
        // label, not from the status.
        let label_width = (host_label_width
            - if removing {
                STATUS_WIDTH + host_gap
            } else {
                0.
            }
            - gauges.as_ref().map_or(0., |(width, _)| width + host_gap))
        .max(0.);
        let lines = 1. + if load_line.is_some() { 1. } else { 0. };
        div()
            .id(SharedString::from(format!("{prefix}host-{endpoint_id}")))
            .debug_selector(|| format!("{prefix}host-{endpoint_id}"))
            .h(px(lines * line_height(font)
                + 2. * layout.host_padding()
                + look.chrome_height()))
            .flex_none()
            .relative()
            .flex()
            .flex_col()
            .justify_center()
            .px(px(content_x))
            // Rows scrolling underneath show through anything translucent, so
            // the copy paints the sidebar's own background. It stops hover and
            // clicks reaching those rows but not the wheel, which must keep
            // scrolling the list while the pointer rests on the pinned header.
            .when(pinned, |row| {
                row.bg(rgb(theme.sidebar_background()))
                    .block_mouse_except_scroll()
            })
            // The host's colour wash sits under its highlight, on the pinned
            // copy too, so the header keeps its colour while it scrolls.
            .map(|row| {
                wash::HostMark::resolve(
                    &self.config.sidebar_style,
                    &endpoint.label,
                    selected,
                    theme,
                )
                .apply(row, &format!("{prefix}host-{endpoint_id}"), &look)
            })
            // Hosts mark selection only; they do not join the rows'
            // hover group.
            .child(look.highlight(
                &format!("{prefix}host-{endpoint_id}"),
                RowState {
                    selected,
                    ..RowState::default()
                },
                theme,
            ))
            .text_color(rgb(if endpoint.enabled {
                theme.foreground
            } else {
                theme.muted
            }))
            .cursor_pointer()
            .on_mouse_down(
                MouseButton::Right,
                cx.listener(move |this, event: &MouseDownEvent, window, cx| {
                    cx.stop_propagation();
                    this.open_host_menu(&menu_id, event.position, window, cx);
                    this.menu.opening_right_click = this.menu.page == Some(crate::menu::Page::Host);
                }),
            )
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(host_gap))
                    .child(
                        div()
                            .id(SharedString::from(format!(
                                "{prefix}collapse-host-{endpoint_id}"
                            )))
                            .when(pinned, |arrow| {
                                arrow.debug_selector(|| {
                                    format!("{prefix}collapse-host-{endpoint_id}")
                                })
                            })
                            .w(px(HOST_ARROW_WIDTH))
                            .flex_none()
                            .child(label_text(if endpoint.collapsed {
                                "\u{25b8}"
                            } else {
                                "\u{25be}"
                            }))
                            .on_click(cx.listener(move |this, _, _, cx| {
                                cx.stop_propagation();
                                if let Some(endpoint) =
                                    this.endpoints.iter_mut().find(|e| e.id == collapse_id)
                                {
                                    endpoint.collapsed = !endpoint.collapsed;
                                }
                                cx.notify();
                            })),
                    )
                    .when(removing, |row| {
                        row.child(removing_dot("host-removing", theme))
                    })
                    .child(
                        div()
                            // As with workspace labels, avoid zero-basis text measurement.
                            .w(px(label_width))
                            .flex_none()
                            .overflow_hidden()
                            .child(
                                div()
                                    .w(px(label_width))
                                    .truncate()
                                    .child(label_text(&endpoint.label)),
                            ),
                    )
                    .when_some(
                        gauges.zip(load).zip(host.clone()),
                        |row, (((_, gauges), reading), host)| {
                            row.child(
                                div()
                                    .id(SharedString::from(format!(
                                        "{prefix}host-load-{endpoint_id}"
                                    )))
                                    .flex_none()
                                    .child(gauges)
                                    .tooltip(crate::system_load::tooltip(reading, &host, theme)),
                            )
                        },
                    )
                    .child(
                        div()
                            .debug_selector(|| format!("{prefix}host-status-{endpoint_id}"))
                            .size(px(STATUS_WIDTH))
                            .flex_none()
                            .rounded_full()
                            .bg(rgb(if endpoint.live.status.is_connected() {
                                crate::menu::online(theme)
                            } else {
                                theme.muted
                            })),
                    ),
            )
            .when_some(load_line.zip(host), |row, (reading, host)| {
                row.child(
                    div()
                        .id(SharedString::from(format!(
                            "{prefix}host-load-{endpoint_id}"
                        )))
                        .h(px(line_height(font)))
                        .flex()
                        .items_center()
                        .pl(px(HOST_ARROW_WIDTH + host_gap))
                        .overflow_hidden()
                        .child(crate::system_load::line(
                            reading,
                            theme,
                            Some(super::metrics::glyph_width(font)),
                            crate::config::status_bar::Detail::Detailed,
                        ))
                        .tooltip(crate::system_load::tooltip(reading, &host, theme)),
                )
            })
            .on_click(cx.listener(move |this, _, window, cx| {
                this.select_endpoint(&select_id, cx);
                window.focus(&this.focus, cx);
            }))
    }

    /// Each host header the spaces list last laid out, at its current scroll
    /// offset. `rows` pairs each host's endpoint index with its header's child
    /// position in the list. Positions come from the previous frame's layout,
    /// as the handle reports them, so there are none until a frame has
    /// measured the list.
    pub(super) fn host_headers(&self, rows: &[(usize, usize)]) -> Vec<HostHeader> {
        let scroll = &self.sidebar_scroll[0];
        if scroll.bounds().size.height <= px(0.) {
            return Vec::new();
        }
        let list_top = scroll.bounds().top();
        let offset = scroll.offset().y;
        rows.iter()
            .filter_map(|&(host, child)| {
                let bounds = scroll.bounds_for_item(child)?;
                Some(HostHeader {
                    host,
                    top: f32::from(bounds.top() + offset - list_top),
                    height: f32::from(bounds.size.height),
                })
            })
            .collect()
    }

    /// The copy of `pinned`'s header held over the top of the spaces list.
    pub(super) fn pinned_host_row(
        &self,
        pinned: HostHeader,
        look: SidebarLook,
        width: f32,
        cx: &mut Context<Self>,
    ) -> Option<Stateful<Div>> {
        let endpoint = self.endpoints.get(pinned.host)?;
        let row = self.host_row(
            endpoint,
            pinned.host == self.selected_endpoint,
            look,
            width,
            true,
            cx,
        );
        Some(row.absolute().top(px(pinned.top)).left_0().right_0())
    }

    /// Moves the spaces list down when `row`, revealed last frame, landed
    /// under the pinned header: GPUI reveals a row from above at the list's
    /// top edge, which the pinned header covers. Returns whether it moved.
    pub(super) fn uncover_revealed(&self, row: usize, headers: &[HostHeader]) -> bool {
        let scroll = &self.sidebar_scroll[0];
        let Some(bounds) = scroll.bounds_for_item(row) else {
            return false;
        };
        let offset = scroll.offset();
        let top = f32::from(bounds.top() + offset.y - scroll.bounds().top());
        let down = sticky::cover(headers) - top;
        if down <= 0. {
            return false;
        }
        scroll.set_offset(point(offset.x, (offset.y + px(down)).min(px(0.))));
        true
    }
}
