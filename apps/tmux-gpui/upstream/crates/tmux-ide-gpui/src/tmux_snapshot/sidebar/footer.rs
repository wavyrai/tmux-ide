//! Shared sidebar recovery controls and their captured-request admission.
use super::super::Selection;
use super::*;
use crate::tmux_snapshot::{SnapshotView, controls};

impl SnapshotView {
    pub(in crate::tmux_snapshot) fn sidebar_footer(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = self.theme();
        let request = self.browser_request;
        div()
            .debug_selector(|| "tmux-sidebar-footer".into())
            .flex_none()
            .flex()
            .gap_2()
            .px_2()
            .py_2()
            .child(
                self.sidebar_focus_control(
                    controls::button(
                        "open-picker",
                        Some("Switch"),
                        "Switch session",
                        controls::Icon::Sessions,
                        &theme,
                    ),
                    0,
                    &theme,
                )
                .on_click(cx.listener(move |view, _, window, cx| {
                    if view.sidebar_footer_current(request) {
                        view.open_picker(window, cx);
                    }
                })),
            )
            .child(
                self.sidebar_focus_control(
                    controls::action_button(
                        "open-theme-picker",
                        None,
                        "Choose theme",
                        controls::Icon::Theme,
                        if self.browser_state.appearance.is_some() {
                            controls::ButtonStyle::Quiet
                        } else {
                            controls::ButtonStyle::Unavailable
                        },
                        &theme,
                    ),
                    1,
                    &theme,
                )
                .when(self.browser_state.appearance.is_none(), |control| {
                    control.aria_description("Appearance settings are not available yet")
                })
                .when(self.browser_state.appearance.is_some(), |control| {
                    control.on_click(cx.listener(move |view, _, window, cx| {
                        if view.sidebar_footer_current(request) {
                            view.open_theme_picker(window, cx);
                        }
                    }))
                }),
            )
            .child(
                self.sidebar_focus_control(
                    controls::button(
                        "refresh-sessions",
                        None,
                        "Refresh sessions",
                        controls::Icon::Refresh,
                        &theme,
                    ),
                    2,
                    &theme,
                )
                .on_click(cx.listener(move |view, _, window, cx| {
                    if view.sidebar_footer_current(request) {
                        view.select(Selection::Refresh, window, cx);
                    }
                })),
            )
            .into_any_element()
    }
}
