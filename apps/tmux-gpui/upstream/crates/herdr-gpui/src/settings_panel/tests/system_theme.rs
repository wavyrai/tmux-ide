use super::*;
use crate::config::Theme;

// The test platform's appearance is always light.
#[gpui::test]
fn a_theme_following_the_system_shows_its_light_side(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(crate::sidebar::layout_tests::fixture_window);
    view.update(cx, |view, cx| {
        view.config.theme = "light:Catppuccin Latte,dark:Nord".into();
        view.theme = Theme::builtin("Nord").unwrap_or_default();
        view.apply_system_theme(cx);
    });
    cx.run_until_parked();
    view.read_with(cx, |view, _| {
        assert_eq!(Some(view.theme.clone()), Theme::builtin("Catppuccin Latte"));
        assert!(view.local_error.is_none());
    });

    // A result for a theme changed while it loaded is dropped.
    view.update(cx, |view, cx| {
        view.config.theme = "light:Dracula,dark:Nord".into();
        view.apply_system_theme(cx);
        view.config.theme = "Nord".into();
        view.theme = Theme::builtin("Nord").unwrap_or_default();
    });
    cx.run_until_parked();
    view.read_with(cx, |view, _| {
        assert_eq!(Some(view.theme.clone()), Theme::builtin("Nord"));
    });
}
