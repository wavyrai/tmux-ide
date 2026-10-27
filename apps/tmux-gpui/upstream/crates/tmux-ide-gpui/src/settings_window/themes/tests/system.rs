use super::*;

fn builtins(view: &mut SettingsWindow) {
    view.themes.names = Theme::BUILTIN_NAMES
        .iter()
        .map(|name| (*name).into())
        .collect();
    view.themes.filter(None);
}

fn select(view: &mut SettingsWindow, name: &str, cx: &mut Context<SettingsWindow>) {
    let index = view
        .themes
        .filtered
        .iter()
        .position(|choice| choice.scope == Scope::App && choice.name == name)
        .unwrap();
    view.select_settings_theme(index, cx);
}

fn builtin(name: &str) -> Theme {
    Theme::builtin(name).unwrap()
}

// The test platform's appearance is always light.
#[gpui::test]
fn following_the_system_drafts_one_side_at_a_time(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(fixture);
    view.update(cx, |view, cx| {
        builtins(view);
        // The default theme is dark, so it keeps the dark side.
        view.toggle_system_theme(cx);
        assert_eq!(view.config.theme, "light:Catppuccin Latte,dark:Default");
        assert_eq!(view.theme, builtin("Catppuccin Latte"));
        assert!(view.themes.editing_light);
        assert_eq!(view.themes.choice().unwrap().name, "Catppuccin Latte");
        assert_eq!(view.edited_theme(), "Catppuccin Latte");

        view.edit_theme_side(false, cx);
        assert_eq!(view.themes.choice().unwrap().name, "Default");
        select(view, "Nord", cx);
        assert_eq!(view.config.theme, "light:Catppuccin Latte,dark:Nord");
        // The dark side is drafted without showing while the system is light.
        assert_eq!(view.theme, builtin("Catppuccin Latte"));
        assert_eq!(view.edited_theme(), "Nord");

        view.edit_theme_side(true, cx);
        select(view, "Dracula", cx);
        assert_eq!(view.config.theme, "light:Dracula,dark:Nord");
        assert_eq!(view.theme, builtin("Dracula"));
        assert!(view.theme_dirty());

        // Turning it off keeps the theme the system is showing.
        view.toggle_system_theme(cx);
        assert_eq!(view.config.theme, "Dracula");
        assert_eq!(view.theme, builtin("Dracula"));
    });
}

#[gpui::test]
fn a_light_theme_keeps_the_light_side_when_following_starts(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(fixture);
    view.update(cx, |view, cx| {
        builtins(view);
        select(view, "Catppuccin Latte", cx);
        view.toggle_system_theme(cx);
        assert_eq!(
            view.config.theme,
            "light:Catppuccin Latte,dark:Catppuccin Mocha"
        );
        assert_eq!(view.theme, builtin("Catppuccin Latte"));
        assert_eq!(
            view.selected_theme_names(),
            ["Catppuccin Latte", "Catppuccin Mocha"]
        );
    });
}
