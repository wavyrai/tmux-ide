//! `[status_bar] keep_awake = false` never hides a cup that is holding.
use super::*;
use crate::sidebar::layout_tests::{fixture_window, full_draw};

#[gpui::test]
fn a_hidden_cup_stays_while_the_display_is_kept_awake(cx: &mut gpui::TestAppContext) {
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = fixture_window(window, cx);
        view.config.status_bar.keep_awake = false;
        view
    });
    cx.update(|window, cx| full_draw(window, cx).clear(cx));
    assert!(cx.debug_bounds("status-caffeine").is_none());
    for (cup, shown) in [(Cup::Pending, true), (Cup::On, true), (Cup::Off, false)] {
        cx.update(|window, cx| {
            cx.set_global(Caffeine { cup, worker: None });
            view.update(cx, |_, cx| cx.notify());
            full_draw(window, cx).clear(cx);
        });
        assert_eq!(
            cx.debug_bounds("status-caffeine").is_some(),
            shown,
            "{cup:?}"
        );
    }
}
