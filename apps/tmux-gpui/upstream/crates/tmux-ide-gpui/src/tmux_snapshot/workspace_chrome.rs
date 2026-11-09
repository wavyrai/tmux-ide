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

    pub(super) fn application_tabs(
        &mut self,
        notice: Option<AnyElement>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = self.theme();
        let request = self.browser_request;
        let workspace = self.browser_state.surface == browser::Surface::Workspace;
        let window_tabs = workspace.then(|| self.workspace_window_strip(window, cx));
        let tabs = div()
            .id("application-tabs")
            .when(window.is_fullscreen(), |bar| {
                bar.pl(px(super::shell::CONTENT_INSET))
            })
            .on_key_down(cx.listener(Self::picker_key))
            .flex_1()
            .min_w_0()
            .h(px(APPLICATION_TABS_HEIGHT))
            .flex_shrink_0()
            .flex()
            .items_center()
            .gap_1()
            .pr_2()
            .child(
                self.sidebar_focus_control(
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
                })),
            )
            .child(
                controls::titlebar_tab(
                    "application-home",
                    "Home",
                    controls::Icon::Home,
                    self.browser_state.surface == browser::Surface::Home,
                    &theme,
                )
                .min_w(px(72.))
                .debug_selector(|| "application-home".into())
                .on_click(cx.listener(move |view, _, window, cx| {
                    view.dispatch_application_tab(request, ApplicationTab::Home, window, cx);
                })),
            )
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
                    }))
                    .children(window_tabs),
            )
            .when(!workspace, |bar| {
                bar.child(
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
                    )
                    .debug_selector(|| "application-new-session".into())
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .on_click(cx.listener(move |view, _, window, cx| {
                        view.open_local_session(request, window, cx);
                    })),
                )
            });
        tabs.into_any_element()
    }

    pub(super) fn create_window_from_strip(
        &mut self,
        target: &super::pane_actions::Target,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.picker.is_some()
            || self.new_session.is_some()
            || self.pane_actions.is_some()
            || !self.presence.ready()
            || self.browser_state.request != self.browser_request
            || !target.current(&self.browser_state)
        {
            return;
        }
        if !self.dispatch_captured_pane_action(
            target,
            super::pane_actions::Action::NewWindow,
            window,
            cx,
        ) {
            // Reuse the existing visible queue-error owner without claiming creation.
            self.show_pane_action_queue_error(window, cx);
        }
    }

    /// The titlebar's New window button. The windows themselves are listed in
    /// the sidebar under the open session (#746).
    pub(super) fn workspace_window_strip(
        &mut self,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = self.theme();
        let captured = super::pane_actions::Target::capture(&self.browser_state);
        let enabled = captured.is_some()
            && self.presence.ready()
            && self.browser_state.request == self.browser_request;
        let mut add = controls::action_button(
            "workspace-new-window",
            None,
            "New terminal window",
            controls::Icon::Plus,
            if enabled {
                controls::ButtonStyle::Quiet
            } else {
                controls::ButtonStyle::Unavailable
            },
            &theme,
        );
        if enabled {
            if let Some(target) = captured {
                add = add.on_click(cx.listener(move |view, _, window, cx| {
                    view.create_window_from_strip(&target, window, cx);
                }));
            }
        } else {
            add = add.aria_description("Unavailable until the selected terminal is ready");
        }
        let add = self
            .sidebar_focus_control(add, 4, &theme)
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation());
        div()
            .debug_selector(|| "workspace-window-strip".into())
            .flex_1()
            .min_w_0()
            .h_full()
            .flex()
            .items_center()
            .justify_end()
            .child(add)
            .into_any_element()
    }
}

#[cfg(test)]
mod tests;
