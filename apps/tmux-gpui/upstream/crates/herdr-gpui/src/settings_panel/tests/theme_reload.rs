use super::*;

#[gpui::test]
fn reloading_reads_a_theme_file_rewritten_in_place(cx: &mut TestAppContext) {
    let Ok(directory) = tempfile::tempdir() else {
        panic!("no temporary directory");
    };
    let path = directory.path().join("current.conf");
    let write = |background: &str| {
        if let Err(error) = std::fs::write(&path, format!("background = #{background}\n")) {
            panic!("write theme: {error}");
        }
    };
    write("120d0a");
    let (view, cx) = cx.add_window_view(crate::sidebar::layout_tests::fixture_window);
    view.update(cx, |view, cx| {
        view.config.theme = path.to_string_lossy().into_owned();
        assert!(view.reload_theme(cx));
    });
    cx.run_until_parked();
    view.read_with(cx, |view, _| {
        assert_eq!(view.theme.background, 0x120d0a);
        assert!(view.local_error.is_none());
    });

    write("1a1b26");
    view.update(cx, |view, cx| assert!(view.reload_theme(cx)));
    cx.run_until_parked();
    view.read_with(cx, |view, _| assert_eq!(view.theme.background, 0x1a1b26));

    // The picker owns the theme it previews.
    write("eff1f5");
    view.update(cx, |view, cx| {
        view.menu.page = Some(crate::menu::Page::Themes);
        assert!(!view.reload_theme(cx));
    });
    cx.run_until_parked();
    view.read_with(cx, |view, _| assert_eq!(view.theme.background, 0x1a1b26));
}
