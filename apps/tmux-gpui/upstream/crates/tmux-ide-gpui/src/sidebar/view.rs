//! The sidebar as a cached child view.
//!
//! Terminal output redraws the window many times a second, and rebuilding and
//! laying out every workspace and agent row each time cost more than painting
//! the terminal. GPUI reuses a cached view's layout and paint until that view
//! is notified, so the window notifies this one whenever it is notified itself
//! (`HerdrWindow::new` observes itself), and a surface-only update redraws the
//! window without notifying it (`HerdrWindow::redraw_terminal`).
//!
//! The rows still come from `HerdrWindow::render_sidebar`, so their listeners
//! and state stay where they were.

use super::{SidebarMode, agents::Indicators};
use crate::window::HerdrWindow;
use gpui::{
    AnyView, Context, Empty, Entity, IntoElement, Render, StyleRefinement, Styled, ViewElement,
    WeakEntity, Window, px,
};

pub(crate) struct SidebarView {
    window: WeakEntity<HerdrWindow>,
    indicators: Indicators,
    #[cfg(test)]
    pub(crate) renders: usize,
}

impl SidebarView {
    pub(crate) fn new(window: WeakEntity<HerdrWindow>, indicators: Indicators) -> Self {
        Self {
            window,
            indicators,
            #[cfg(test)]
            renders: 0,
        }
    }

    pub(crate) fn set_indicators(&mut self, indicators: Indicators, cx: &mut Context<Self>) {
        if self.indicators != indicators {
            self.indicators = indicators;
            cx.notify();
        }
    }
}

impl Render for SidebarView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        #[cfg(test)]
        {
            self.renders += 1;
        }
        #[cfg(feature = "integration-test")]
        {
            cx.default_global::<crate::performance::Counts>()
                .sidebar_renders += 1;
        }
        // A closed window leaves nothing to draw.
        self.window
            .update(cx, |view, cx| match view.sidebar_mode() {
                SidebarMode::Rail => view
                    .render_rail(self.indicators, window, cx)
                    .into_any_element(),
                _ => view
                    .render_sidebar(self.indicators, window, cx)
                    .into_any_element(),
            })
            .unwrap_or_else(|_| Empty.into_any_element())
    }
}

/// The sidebar in the window body, `width` wide as its mode lays it out. The
/// outer style repeats the sidebar's own root, which GPUI lays out without
/// rendering while the cache holds.
pub(crate) fn cached(view: &Entity<SidebarView>, width: f32) -> ViewElement<AnyView> {
    AnyView::from(view.clone()).cached(
        StyleRefinement::default()
            .w(px(width))
            .flex_none()
            .h_full()
            .min_h_0(),
    )
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use super::*;
    use crate::{herdr_settings::Settings, sidebar::layout_tests::fixture_window};

    #[gpui::test]
    fn shared_indicator_reload_invalidates_cache_but_identical_props_do_not(
        cx: &mut gpui::TestAppContext,
    ) {
        let (view, cx) = cx.add_window_view(fixture_window);
        let sidebar = cx.update(|window, cx| {
            window.draw(cx).clear(cx);
            view.read(cx).sidebar_view.clone()
        });
        for text in [
            "[ui]\nstatus_indicators = 'symbols'\n[theme.custom]\nyellow = '#123456'\n",
            "[ui]\nstatus_indicators = 'symbols'\n[theme.custom]\nyellow = '#ff9900'\n",
            "[ui]\nstatus_indicators = 'dots'\n[theme.custom]\nyellow = '#ff9900'\n",
        ] {
            let (before, previous) = cx.update(|_, cx| {
                let sidebar = sidebar.read(cx);
                (sidebar.renders, sidebar.indicators)
            });
            view.update(cx, |view, cx| {
                view.settings.shared = Some(Settings::parse_text(text).unwrap());
                cx.notify();
            });
            cx.update(|window, cx| window.draw(cx).clear(cx));
            let (renders, indicators) = cx.update(|_, cx| {
                let parent = view.read(cx);
                let expected = Indicators::new(
                    parent.settings.shared.as_ref(),
                    matches!(
                        cx.window_appearance(),
                        gpui::WindowAppearance::Light | gpui::WindowAppearance::VibrantLight
                    ),
                    &parent.theme,
                );
                let sidebar = sidebar.read(cx);
                assert_eq!(sidebar.indicators, expected);
                assert_ne!(sidebar.indicators, previous);
                assert!(sidebar.renders > before);
                (sidebar.renders, sidebar.indicators)
            });
            sidebar.update(cx, |sidebar, cx| sidebar.set_indicators(indicators, cx));
            view.update(cx, |view, cx| view.redraw_terminal(cx));
            cx.update(|window, cx| {
                window.draw(cx).clear(cx);
                assert_eq!(sidebar.read(cx).renders, renders);
            });
        }
    }
}
