use super::*;

// The test platform's appearance is always light, so each test starts from a
// theme loaded for dark, as if the system had just turned light.

fn theme_file(background: &str) -> (tempfile::TempDir, std::path::PathBuf) {
    let Ok(directory) = tempfile::tempdir() else {
        panic!("no temporary directory");
    };
    let path = directory.path().join("current.conf");
    write_theme(&path, background);
    (directory, path)
}

fn write_theme(path: &std::path::Path, background: &str) {
    if let Err(error) = std::fs::write(path, format!("background = #{background}\n")) {
        panic!("write theme: {error}");
    }
}

#[gpui::test]
fn herdr_hears_a_new_appearance_only_with_the_colors_loaded_for_it(cx: &mut TestAppContext) {
    let (_directory, path) = theme_file("1f130b");
    let (view, cx) = cx.add_window_view(crate::sidebar::layout_tests::fixture_window);
    view.update(cx, |view, cx| {
        view.config.theme = path.to_string_lossy().into_owned();
        view.theme.background = 0x1f130b;
        view.theme_light = false;
        // A desktop theme switcher rewrites the file, then turns the system light.
        write_theme(&path, "f4f1e8");
        view.apply_system_theme(cx);
        // Until the file is read again, Herdr keeps the old appearance with
        // the old colors.
        assert!(!view.theme_light);
        assert_eq!(view.theme.background, 0x1f130b);
    });
    cx.run_until_parked();
    view.read_with(cx, |view, _| {
        assert!(view.theme_light);
        assert_eq!(view.theme.background, 0xf4f1e8);
    });
}

#[gpui::test]
fn the_appearance_is_reported_at_once_when_nothing_loads_for_it(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(crate::sidebar::layout_tests::fixture_window);
    view.update(cx, |view, cx| {
        // The picker owns the theme it previews.
        view.menu.page = Some(crate::menu::Page::Themes);
        view.theme_light = false;
        view.apply_system_theme(cx);
        assert!(view.theme_light);

        // Follow Herdr already shows the daemon's theme for the appearance.
        view.menu.page = None;
        view.config.theme = "Follow Herdr".into();
        view.theme_light = false;
        view.apply_system_theme(cx);
        assert!(view.theme_light);
    });
}
