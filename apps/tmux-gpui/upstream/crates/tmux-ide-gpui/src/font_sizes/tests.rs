use super::*;
use gpui::Modifiers;
use std::sync::{Arc, Mutex};

#[gpui::test]
#[allow(clippy::unwrap_used)]
fn stepper_clicks_preview_and_coalesce_while_the_writer_is_busy(cx: &mut gpui::TestAppContext) {
    let (view, cx) = cx.add_window_view(crate::sidebar::layout_tests::fixture_window);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.open_preferences_fixture(window, cx);
            view.select_settings_tab(crate::settings_panel::Tab::Font, window, cx);
            view.font_size_saves.task = Some(cx.spawn(async |_, _| std::future::pending().await));
        });
        window.draw(cx).clear(cx);
    });
    for (button, expected) in [
        ("increase", 13.),
        ("increase", 14.),
        ("increase", 15.),
        ("decrease", 14.),
    ] {
        let bounds = cx
            .debug_bounds(if button == "increase" {
                "preferences-font-sidebar-increase"
            } else {
                "preferences-font-sidebar-decrease"
            })
            .unwrap();
        cx.simulate_click(bounds.center(), Modifiers::default());
        view.read_with(cx, |view, _| {
            assert_eq!(view.config.sidebar.size, expected);
            assert_eq!(view.font_size_saves.pending.len(), 1);
        });
        cx.update(|window, cx| window.draw(cx).clear(cx));
    }
    let batches = Arc::new(Mutex::new(Vec::new()));
    let recorded = batches.clone();
    view.update(cx, |view, cx| {
        view.font_size_saves.task = None;
        view.flush_font_sizes_with(
            move |sizes| {
                recorded.lock().unwrap().push(sizes.to_vec());
                Ok(())
            },
            cx,
        );
    });
    cx.run_until_parked();
    assert_eq!(
        *batches.lock().unwrap(),
        vec![vec![(FontFace::Sidebar, 14.)]]
    );
    view.read_with(cx, |view, _| assert!(!view.font_size_saves.is_busy()));
}

#[gpui::test]
#[allow(clippy::unwrap_used)]
fn completion_writes_the_latest_batch_without_reverting_the_preview(cx: &mut gpui::TestAppContext) {
    let (view, cx) = cx.add_window_view(crate::sidebar::layout_tests::fixture_window);
    let batches = Arc::new(Mutex::new(Vec::new()));
    let recorded = batches.clone();
    view.update(cx, |view, cx| {
        view.font_size_saves.queue(FontFace::Sidebar, 13., 12.);
        view.config.sidebar.size = 13.;
        view.flush_font_sizes_with(
            move |sizes| {
                recorded.lock().unwrap().push(sizes.to_vec());
                Ok(())
            },
            cx,
        );
        view.set_font_size(FontFace::Sidebar, 14., cx);
        view.set_font_size(FontFace::Sidebar, 15., cx);
        view.set_font_size(FontFace::Terminal, 20., cx);
        assert_eq!(view.config.sidebar.size, 15.);
    });
    cx.run_until_parked();
    assert_eq!(
        *batches.lock().unwrap(),
        vec![
            vec![(FontFace::Sidebar, 13.)],
            vec![(FontFace::Sidebar, 15.), (FontFace::Terminal, 20.)]
        ]
    );
    view.read_with(cx, |view, _| {
        assert_eq!(view.config.sidebar.size, 15.);
        assert_eq!(view.config.terminal.size, 20.);
        assert_eq!(view.configured_terminal_size, 20.);
        assert!(!view.font_size_saves.is_busy());
        assert!(view.font_size_saves.error.is_none());
    });
}

#[gpui::test]
fn a_reload_keeps_newer_clicks_without_publishing_them_as_saved(cx: &mut gpui::TestAppContext) {
    let (view, cx) = cx.add_window_view(crate::sidebar::layout_tests::fixture_window);
    view.update(cx, |view, cx| {
        view.load_gui_config_with(
            || {
                let mut config = Config::default();
                config.sidebar.size = 18.;
                Ok((config, Default::default()))
            },
            cx,
        );
        view.set_font_size(FontFace::Sidebar, 16., cx);
        // Hold the writer so the load's completion can be observed before saving.
        view.font_size_saves.task = Some(cx.spawn(async |_, _| std::future::pending().await));
    });
    cx.run_until_parked();
    view.update(cx, |view, cx| {
        assert_eq!(view.config.sidebar.size, 16.);
        assert_eq!(view.font_size_saves.pending[0].previous, 18.);
        assert_eq!(
            cx.global::<crate::app::InitialAppearance>()
                .config
                .sidebar
                .size,
            18.
        );
        view.font_size_saves.task = None;
        view.flush_font_sizes_with(
            |sizes| {
                assert_eq!(sizes, &[(FontFace::Sidebar, 16.)]);
                Ok(())
            },
            cx,
        );
    });
    cx.run_until_parked();
    view.read_with(cx, |view, cx| {
        assert!(!view.font_size_saves.is_busy());
        assert_eq!(
            cx.global::<crate::app::InitialAppearance>()
                .config
                .sidebar
                .size,
            16.
        );
    });
}

#[gpui::test]
fn save_failure_restores_the_preview_and_reports_the_error(cx: &mut gpui::TestAppContext) {
    let (view, cx) = cx.add_window_view(crate::sidebar::layout_tests::fixture_window);
    view.update(cx, |view, cx| {
        view.font_size_saves.queue(FontFace::Sidebar, 13., 12.);
        view.config.sidebar.size = 13.;
        view.flush_font_sizes_with(|_| Err(crate::Error::MissingHome), cx);
    });
    cx.run_until_parked();
    view.read_with(cx, |view, _| {
        assert_eq!(view.config.sidebar.size, 12.);
        assert!(!view.font_size_saves.is_busy());
        assert!(
            view.font_size_saves
                .status()
                .is_some_and(|message| message.starts_with("Could not save font sizes:"))
        );
    });
}

#[test]
fn repeated_clicks_coalesce_per_face_and_a_reload_preserves_the_latest_draft() {
    let mut saves = FontSizeSaves::default();
    saves.queue(FontFace::Sidebar, 13., 12.);
    saves.queue(FontFace::Sidebar, 14., 13.);
    saves.queue(FontFace::Tabs, 20., 12.);
    assert_eq!(saves.pending.len(), 2);
    let mut config = Config::default();
    config.sidebar.size = 18.;
    saves.apply_pending(&mut config);
    assert_eq!(config.sidebar.size, 14.);
    assert_eq!(config.tabs.size, 20.);
    assert_eq!(saves.pending[0].previous, 18.);
}

#[test]
fn failed_batch_preserves_newer_clicks_and_rolls_back_to_the_last_saved_size() {
    let mut saves = FontSizeSaves::default();
    let mut config = Config::default();
    config.sidebar.size = 14.;
    config.tabs.size = 20.;
    saves.queue(FontFace::Sidebar, 14., 13.);
    saves.rollback(
        &[
            Edit {
                face: FontFace::Sidebar,
                size: 13.,
                previous: 12.,
            },
            Edit {
                face: FontFace::Tabs,
                size: 20.,
                previous: 12.,
            },
        ],
        &mut config,
    );
    assert_eq!(config.sidebar.size, 14.);
    assert_eq!(config.tabs.size, 12.);
    let next = std::mem::take(&mut saves.pending);
    saves.rollback(&next, &mut config);
    assert_eq!(config.sidebar.size, 12.);
}
