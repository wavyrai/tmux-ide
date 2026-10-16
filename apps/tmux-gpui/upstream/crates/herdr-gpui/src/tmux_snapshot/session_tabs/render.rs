use super::*;
use crate::tmux_snapshot::controls;
use gpui::{prelude::*, *};
impl SnapshotView {
    pub(in crate::tmux_snapshot) fn retained_session_strip(
        &self,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let p = self
            .browser_state
            .session_tabs
            .as_ref()
            .filter(|p| !p.rows.is_empty())?;
        let theme = self.theme();
        let request = p.request;
        let revision = p.revision;
        let mut strip = div()
            .id("retained-session-tabs")
            .debug_selector(|| "retained-session-tabs".into())
            .flex_1()
            .min_w_0()
            .h_full()
            .flex()
            .items_center()
            .overflow_x_scroll()
            .track_scroll(&self.session_tabs.scroll)
            .gap_1();
        for (index, row) in p.rows.iter().enumerate() {
            let action = row.activate.clone();
            let close = row.close.clone();
            let mut context = format!("{} · {}", row.host_label, row.label);
            if let Some(server) = &row.server_label {
                context = format!("{} · {} · {}", row.host_label, server, row.label);
            }
            let status = if p.pending.as_ref() == Some(&row.id) {
                Some("Opening")
            } else if !row.available {
                Some("Unavailable")
            } else {
                match row.activity {
                    Some(Activity::Failed) => Some("Failed"),
                    Some(Activity::Waiting) => Some("Waiting"),
                    Some(Activity::Running) => Some("Running"),
                    _ => None,
                }
            };
            let foreground = theme.foreground;
            let surface = theme.surface;
            let active = self.browser_state.surface == browser::Surface::Workspace
                && p.active.as_ref() == Some(&row.id);
            let tab = controls::titlebar_tab(
                ("retained-session", index),
                context.clone(),
                controls::Icon::Sessions,
                active,
                &theme,
            )
            .debug_selector(move || format!("retained-session-{index}"))
            .max_w(px(260.))
            .min_w(px(80.))
            .px_2()
            .when(!row.available, |t| t.text_color(rgb(theme.muted)))
            .children(status.map(|s| {
                div()
                    .text_size(px(10.))
                    .text_color(rgb(theme.muted))
                    .child(s)
            }))
            .when(row.unread, |t| {
                t.child(
                    div()
                        .text_size(px(10.))
                        .text_color(rgb(self.accent()))
                        .child("New"),
                )
            })
            .tooltip(move |_, cx| {
                cx.new(|_| crate::usage::Hint {
                    text: context.clone().into(),
                    foreground,
                    surface,
                })
                .into()
            })
            .on_click(cx.listener(move |v, _, w, cx| {
                v.choose_session_tab(request, revision, &action, w, cx)
            }));
            let close_button = div()
                .id(("close-retained-session", index))
                .debug_selector(move || format!("close-retained-session-{index}"))
                .size(px(24.))
                .flex_shrink_0()
                .flex()
                .items_center()
                .justify_center()
                .cursor_pointer()
                .rounded(px(crate::config::corners::CONTROL))
                .hover(move |s| s.text_color(rgb(theme.foreground)))
                .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                .child(
                    svg()
                        .path("icons/close.svg")
                        .size(px(12.))
                        .text_color(rgb(theme.muted)),
                )
                .tooltip(move |_, cx| {
                    cx.new(|_| crate::usage::Hint {
                        text: "Close tab — session keeps running".into(),
                        foreground,
                        surface,
                    })
                    .into()
                })
                .on_click(cx.listener(move |v, _, w, cx| {
                    cx.stop_propagation();
                    v.choose_session_tab(request, revision, &close, w, cx)
                }));
            strip = strip.child(tab.child(close_button));
        }
        Some(strip.into_any_element())
    }
}
