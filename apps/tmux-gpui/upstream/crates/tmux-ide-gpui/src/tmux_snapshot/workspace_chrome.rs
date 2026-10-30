//! Primary application navigation is distinct from daemon-owned tmux windows.
use super::{SnapshotView, browser, browser_ui::Selection, controls, navigation};
use gpui::{prelude::*, *};

pub(super) const APPLICATION_TABS_HEIGHT: f32 = crate::titlebar::HEIGHT;

#[derive(Default)]
pub(super) struct WindowReveal {
    pub(super) scroll: ScrollHandle,
    revealed: Option<RevealKey>,
    measurement_attempted: Option<RevealKey>,
}
#[derive(Clone, PartialEq)]
struct RevealKey {
    session: String,
    selected: String,
    windows: Vec<(String, String)>,
    viewport_width: Pixels,
    measured_width: Pixels,
}

#[derive(Debug, PartialEq, Eq)]
enum RevealEffect {
    None,
    MeasureOnce,
    Reveal,
}
impl WindowReveal {
    fn observe(&mut self, key: RevealKey, measurable: bool) -> RevealEffect {
        if self.revealed.as_ref() == Some(&key) {
            return RevealEffect::None;
        }
        if measurable {
            self.revealed = Some(key);
            return RevealEffect::Reveal;
        }
        // One follow-up per stable key. Do not mark an unseen item revealed,
        // and do not spin while hidden/zero-width; later normal layout recovers.
        if self.measurement_attempted.as_ref() == Some(&key) {
            return RevealEffect::None;
        }
        self.measurement_attempted = Some(key);
        RevealEffect::MeasureOnce
    }
}

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

    pub(super) fn workspace_window_strip(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = self.theme();
        let request = self.browser_request;
        let choices = navigation::windows(
            &self.browser_state.panes,
            self.browser_state.selected_pane.as_deref(),
        );
        if self.browser_state.surface != browser::Surface::Workspace
            || self.browser_state.request != self.browser_request
            || self.browser_state.selected_session.is_none()
            || !choices.iter().any(|choice| choice.selected)
        {
            // A fresh handle also cancels any prepaint reveal from retired state.
            self.window_reveal = Default::default();
        } else if let Some((index, selected)) = choices.iter().enumerate().find(|(_, c)| c.selected)
        {
            let key = RevealKey {
                session: self
                    .browser_state
                    .selected_session
                    .clone()
                    .unwrap_or_default(),
                selected: selected.id.clone(),
                windows: choices
                    .iter()
                    .map(|c| (c.id.clone(), c.label.clone()))
                    .collect(),
                viewport_width: window.viewport_size().width,
                measured_width: self.window_reveal.scroll.bounds().size.width,
            };
            // Adapt Herdr sidebar/render.rs's measured ScrollHandle/revealed ledger.
            // Semantic identity + order/layout changes reveal once; ordinary output
            // and same-window pane changes never overwrite manual scrolling.
            let measurable = key.measured_width > px(0.)
                && self.window_reveal.scroll.bounds_for_item(index).is_some();
            match self.window_reveal.observe(key, measurable) {
                RevealEffect::Reveal => {
                    self.window_reveal.scroll.scroll_to_item(index);
                    window.request_animation_frame();
                }
                RevealEffect::MeasureOnce => window.request_animation_frame(),
                RevealEffect::None => {}
            }
        }
        let mut strip = div()
            .id("window-strip")
            .debug_selector(|| "workspace-window-strip".into())
            .flex_1()
            .min_w_0()
            .flex()
            .flex_shrink_0()
            .overflow_x_scroll()
            .track_scroll(&self.window_reveal.scroll)
            .on_scroll_wheel({
                let scroll = self.window_reveal.scroll.clone();
                move |event, window, cx| crate::tab_scroll::wheel(&scroll, event, window, cx)
            })
            .gap(px(4.))
            .items_center();
        if self.browser_state.surface != browser::Surface::Workspace {
            return strip.into_any_element();
        }
        let Some(session) = self.browser_state.selected_session.as_ref() else {
            return strip.into_any_element();
        };
        for (index, choice) in choices.into_iter().enumerate() {
            let session = session.clone();
            strip = strip.child(
                controls::image_tab(
                    ("window-choice", index),
                    choice.label.clone(),
                    super::pane_chrome::browser_icon::element(
                        self.browser_state
                            .panes
                            .iter()
                            .find(|pane| pane.id == choice.pane)
                            .and_then(|pane| pane.browser_icon.as_deref()),
                        "icons/terminal.svg",
                        14.,
                        theme.muted,
                    ),
                    choice.selected,
                    &theme,
                )
                .debug_selector(move || format!("workspace-window-{index}"))
                .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                .overflow_hidden()
                .on_click(cx.listener(move |view, _, window, cx| {
                    view.select_window(request, &session, &choice, window, cx);
                })),
            );
        }
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
            .flex_1()
            .min_w_0()
            .h_full()
            .flex()
            .items_center()
            .child(strip)
            .child(add)
            .into_any_element()
    }
}

#[cfg(test)]
mod tests;
