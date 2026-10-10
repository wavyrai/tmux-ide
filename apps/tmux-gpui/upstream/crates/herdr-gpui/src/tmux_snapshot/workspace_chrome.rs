//! Primary application navigation is distinct from daemon-owned tmux windows.
use super::{SnapshotView, browser, browser_ui::Selection, navigation};
use gpui::{prelude::*, *};

pub(super) const APPLICATION_TABS_HEIGHT: f32 = 36.;

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
enum ApplicationTab {
    Home,
    Terminals,
}

impl SnapshotView {
    fn dispatch_application_tab(
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
        &self,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = self.theme();
        let request = self.browser_request;
        let mut tabs = div()
            .id("application-tabs")
            .w_full()
            .h(px(APPLICATION_TABS_HEIGHT))
            .flex_shrink_0()
            .flex()
            .items_center()
            .gap_1()
            .px_2()
            .bg(rgb(theme.surface));
        for (id, label, tab, selected) in [
            (
                "application-home",
                "Home",
                ApplicationTab::Home,
                self.browser_state.surface == browser::Surface::Home,
            ),
            (
                "application-terminals",
                "Terminals",
                ApplicationTab::Terminals,
                self.browser_state.surface == browser::Surface::Workspace,
            ),
        ] {
            tabs = tabs.child(
                div()
                    .id(id)
                    .debug_selector(move || id.to_owned())
                    .h_full()
                    .flex_shrink_0()
                    .flex()
                    .items_center()
                    .px_3()
                    .border_b_2()
                    .border_color(if selected {
                        rgb(self.accent()).into()
                    } else {
                        transparent_black()
                    })
                    .text_color(rgb(if selected {
                        theme.foreground
                    } else {
                        theme.muted
                    }))
                    .cursor_pointer()
                    .child(label)
                    .on_click(cx.listener(move |view, _, window, cx| {
                        view.dispatch_application_tab(request, tab, window, cx);
                    })),
            );
        }
        tabs.into_any_element()
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
            .w_full()
            .flex()
            .flex_shrink_0()
            .overflow_x_scroll()
            .track_scroll(&self.window_reveal.scroll)
            .px_2()
            .bg(rgb(theme.surface));
        if self.browser_state.surface != browser::Surface::Workspace {
            return strip.into_any_element();
        }
        let Some(session) = self.browser_state.selected_session.as_ref() else {
            return strip.into_any_element();
        };
        for (index, choice) in choices.into_iter().enumerate() {
            let session = session.clone();
            strip = strip.child(
                div()
                    .id(("window-choice", index))
                    .debug_selector(move || format!("workspace-window-{index}"))
                    .flex_shrink_0()
                    .max_w(px(200.))
                    .truncate()
                    .px_3()
                    .py_1()
                    .border_b_2()
                    .border_color(if choice.selected {
                        rgb(self.accent()).into()
                    } else {
                        transparent_black()
                    })
                    .text_color(rgb(if choice.selected {
                        theme.foreground
                    } else {
                        theme.muted
                    }))
                    .cursor_pointer()
                    .child(choice.label.clone())
                    .on_click(cx.listener(move |view, _, window, cx| {
                        view.select_window(request, &session, &choice, window, cx);
                    })),
            );
        }
        strip.into_any_element()
    }
}

#[cfg(test)]
mod tests;
