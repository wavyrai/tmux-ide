//! Primary application navigation is distinct from daemon-owned tmux windows.
use super::{SnapshotView, browser, browser_ui::Selection, controls};
use gpui::{prelude::*, *};

pub(super) const APPLICATION_TABS_HEIGHT: f32 = crate::titlebar::HEIGHT;

#[derive(Clone, Copy)]
pub(super) enum ApplicationTab {
    Home,
    Terminals,
}

impl SnapshotView {
    pub(super) fn dispatch_application_tab(
        &mut self,
        request: u64,
        tab: ApplicationTab,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if request != self.browser_request || self.browser_commands.is_none() {
            return;
        }
        match tab {
            ApplicationTab::Home => self.select(Selection::Home, window, cx),
            ApplicationTab::Terminals => {
                if self.browser_state.surface != browser::Surface::Workspace {
                    if let Some(id) = self.last_workspace_session.as_ref().filter(|id| {
                        self.browser_state.home_phase == browser::HomePhase::Live
                            && self
                                .browser_state
                                .sessions
                                .iter()
                                .any(|session| &session.id == *id)
                    }) {
                        self.select(Selection::Session(id.clone()), window, cx);
                    } else {
                        self.open_picker(window, cx);
                    }
                }
            }
        }
    }

    /// The top row (#746): the sidebar's own controls sit beside the traffic
    /// lights, over the sidebar: show/hide the sidebar, then search and New
    /// session at the sidebar's right edge. Home is the sidebar's first row;
    /// with the sidebar hidden it joins this row. New window is in the menu
    /// bar (Cmd-T). The rest of the row moves the window.
    pub(super) fn application_tabs(
        &mut self,
        notice: Option<AnyElement>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = self.theme();
        let request = self.browser_request;
        let workspace = self.browser_state.surface == browser::Surface::Workspace;
        let sidebar = workspace && !self.sidebar_hidden;
        let fullscreen = window.is_fullscreen();
        // The traffic lights take the band's left end, except in full screen.
        let leading = if fullscreen {
            super::shell::CONTENT_INSET
        } else {
            bezel_theme::Theme::TRAFFIC_LIGHT_INSET
        };
        let toggle = self
            .sidebar_focus_control(
                controls::button(
                    "sidebar-toggle",
                    None,
                    "Show / hide sidebar · F10",
                    controls::Icon::Sidebar,
                    &theme,
                ),
                3,
                &theme,
            )
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .on_click(cx.listener(move |view, _, _, cx| {
                if view.browser_request == request
                    && view.picker.is_none()
                    && view.new_session.is_none()
                    && view.pane_actions.is_none()
                    && view.marked.is_empty()
                {
                    view.toggle_sidebar(cx);
                }
            }));
        let home = (!sidebar && workspace).then(|| {
            controls::button(
                "application-home",
                None,
                "Home · F1",
                controls::Icon::Home,
                &theme,
            )
            .debug_selector(|| "application-home".into())
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .on_click(cx.listener(move |view, _, window, cx| {
                view.dispatch_application_tab(request, ApplicationTab::Home, window, cx);
            }))
        });
        let search = self
            .sidebar_focus_control(
                controls::button(
                    "application-search",
                    None,
                    "Browse sessions…",
                    controls::Icon::Search,
                    &theme,
                ),
                5,
                &theme,
            )
            .debug_selector(|| "application-search".into())
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .on_click(cx.listener(move |view, _, window, cx| {
                if view.browser_request == request
                    && view.picker.is_none()
                    && view.new_session.is_none()
                    && view.pane_actions.is_none()
                {
                    view.open_picker(window, cx);
                }
            }));
        let new_session = self
            .sidebar_focus_control(
                controls::action_button(
                    "application-new-session",
                    None,
                    "New session on this Mac",
                    controls::Icon::Plus,
                    if self.local_session_available() {
                        controls::ButtonStyle::Quiet
                    } else {
                        controls::ButtonStyle::Unavailable
                    },
                    &theme,
                ),
                6,
                &theme,
            )
            .debug_selector(|| "application-new-session".into())
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .on_click(cx.listener(move |view, _, window, cx| {
                view.open_local_session(request, window, cx);
            }));
        let cluster = div()
            .debug_selector(|| "sidebar-top-row".into())
            .flex_none()
            .h_full()
            .flex()
            .items_center()
            .gap_1()
            // Over the sidebar, its controls end where the sidebar does.
            .when(sidebar, |row| {
                row.w(px(super::browser_ui::SIDEBAR_WIDTH - leading))
                    .pr(px(bezel_theme::Theme::SPACE))
            })
            .child(toggle)
            .children(home)
            .child(div().flex_1())
            .child(search)
            .child(new_session);
        div()
            .id("application-tabs")
            .when(fullscreen, |bar| bar.pl(px(super::shell::CONTENT_INSET)))
            .on_key_down(cx.listener(Self::picker_key))
            .flex_1()
            .min_w_0()
            .h(px(APPLICATION_TABS_HEIGHT))
            .flex_shrink_0()
            .flex()
            .items_center()
            .gap_1()
            .pr_2()
            .child(cluster)
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .h_full()
                    .flex()
                    .items_center()
                    .justify_center()
                    .debug_selector(|| "application-drag-region".into())
                    .children(notice.map(|notice| {
                        div()
                            .max_w(px(200.))
                            .min_w_0()
                            .overflow_hidden()
                            .child(notice)
                    })),
            )
            .into_any_element()
    }
}

#[cfg(test)]
mod tests;
