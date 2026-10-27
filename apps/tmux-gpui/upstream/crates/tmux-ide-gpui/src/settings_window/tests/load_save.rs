use super::*;

#[gpui::test]
fn footer_reload_stays_compact_and_ignores_busy_clicks(cx: &mut TestAppContext) {
    let main = cx.add_window(crate::sidebar::layout_tests::fixture_window);
    let weak = cx.update(|cx| main.update(cx, |_, _, cx| cx.weak_entity()).unwrap());
    let (view, cx) = cx.add_window_view(|_, cx| {
        let mut view = SettingsWindow::new(weak, cx);
        view.section = Section::General;
        view.error = Some(
            "A long settings error that must wrap without squeezing the Reload button. ".repeat(4),
        );
        view
    });
    let mut button_size = None;
    for width in [960., 680., 480.] {
        cx.simulate_resize(size(px(width), px(560.)));
        cx.update(|window, cx| crate::sidebar::layout_tests::full_draw(window, cx).clear(cx));
        let button = cx.debug_bounds("settings-footer-reload").unwrap();
        let status = cx.debug_bounds("settings-footer-status").unwrap();
        assert!(button.size.width >= px(50.));
        assert!(button.size.height >= px(24.) && button.size.height <= px(28.));
        assert!(button.right() <= px(width - 16.));
        assert!(button.bottom() <= px(560. - 8.));
        assert!(status.right() + px(12.) <= button.left());
        assert!(status.size.width > px(0.));
        assert_eq!(*button_size.get_or_insert(button.size), button.size);
    }
    for busy in 0..3 {
        view.update(cx, |view, cx| {
            view.loading = busy == 0;
            view.saving = busy == 1;
            view.quitting = busy == 2;
            cx.notify();
        });
        cx.update(|window, cx| crate::sidebar::layout_tests::full_draw(window, cx).clear(cx));
        let button = cx.debug_bounds("settings-footer-reload").unwrap();
        cx.simulate_click(button.center(), Default::default());
        cx.run_until_parked();
        view.read_with(cx, |view, _| {
            assert_eq!(view.loading, busy == 0);
            assert_eq!(view.saving, busy == 1);
            assert_eq!(view.quitting, busy == 2);
            assert!(view.error.is_some(), "busy reload must not clear the error");
        });
    }
}

#[gpui::test]
fn failed_load_keeps_validated_preferences_and_allows_retry(cx: &mut TestAppContext) {
    let source = cx.add_window(crate::sidebar::layout_tests::fixture_window);
    let settings = cx.update(|cx| {
        let weak = source.update(cx, |_, _, cx| cx.weak_entity()).unwrap();
        open_fixture(weak, cx);
        let settings = cx.global::<SettingsWindowHandle>().window.unwrap();
        settings
            .update(cx, |view, _, cx| {
                view.config.ui.size = 19.;
                view.reload_with(|| Err(crate::Error::MissingHome), cx);
                view.reload_with(|| panic!("loads must be serialized"), cx);
                assert!(view.busy());
            })
            .unwrap();
        settings
    });
    cx.run_until_parked();
    cx.update(|cx| {
        settings
            .update(cx, |view, _, cx| {
                assert_eq!(view.config.ui.size, 19.);
                assert!(
                    view.error
                        .as_ref()
                        .unwrap()
                        .contains("keeping current preferences")
                );
                assert!(!view.busy());
                view.reload_with(|| Ok(fixture()), cx);
            })
            .unwrap();
    });
    cx.run_until_parked();
    cx.update(|cx| {
        settings
            .update(cx, |view, _, _| {
                assert_eq!(view.config.ui.size, Config::default().ui.size);
                assert!(view.error.is_none());
            })
            .unwrap();
    });
}

#[gpui::test]
fn accepted_save_survives_both_windows_closing_and_reopen_reuses_model(cx: &mut TestAppContext) {
    let source = cx.add_window(crate::sidebar::layout_tests::fixture_window);
    let writes = Arc::new(AtomicUsize::new(0));
    let reconciliations = Arc::new(AtomicUsize::new(0));
    let retained = cx.update(|cx| {
        let weak = source.update(cx, |_, _, cx| cx.weak_entity()).unwrap();
        open_fixture(weak.clone(), cx);
        source
            .update(cx, |_, window, _| window.remove_window())
            .unwrap();
        let settings = cx.global::<SettingsWindowHandle>().window.unwrap();
        let writes = writes.clone();
        let reconciliations = reconciliations.clone();
        let retained = settings
            .update(cx, |view, window, cx| {
                view.save_with(
                    move || {
                        writes.fetch_add(1, Ordering::SeqCst);
                        Ok(())
                    },
                    move || {
                        reconciliations.fetch_add(1, Ordering::SeqCst);
                        Ok(fixture())
                    },
                    false,
                    cx,
                );
                view.save_with(
                    || panic!("writes must be serialized"),
                    || Ok(fixture()),
                    false,
                    cx,
                );
                assert!(view.saving);
                window.remove_window();
                cx.weak_entity()
            })
            .unwrap();
        open_fixture(weak, cx);
        let reopened = cx.global::<SettingsWindowHandle>().window.unwrap();
        reopened
            .update(cx, |view, window, cx| {
                assert_eq!(cx.entity_id(), retained.entity_id());
                assert!(view.saving);
                window.remove_window();
            })
            .unwrap();
        retained
    });
    cx.run_until_parked();
    assert_eq!(writes.load(Ordering::SeqCst), 1);
    assert_eq!(reconciliations.load(Ordering::SeqCst), 1);
    assert!(retained.upgrade().is_none());
    cx.update(|cx| assert!(cx.windows().is_empty()));
}

#[gpui::test]
fn follow_appearance_resolves_prepared_settings_without_source_or_disk(cx: &mut TestAppContext) {
    let source = cx.add_window(crate::sidebar::layout_tests::fixture_window);
    let settings = cx.update(|cx| {
        let weak = source.update(cx, |_, _, cx| cx.weak_entity()).unwrap();
        open_fixture(weak, cx);
        source
            .update(cx, |_, window, _| window.remove_window())
            .unwrap();
        cx.global::<SettingsWindowHandle>().window.unwrap()
    });
    cx.run_until_parked();
    cx.update(|cx| {
        settings
            .update(cx, |view, _, cx| {
                let shared =
                    herdr_settings::Settings::parse_text("[theme]\nname = 'catppuccin'").unwrap();
                let light = matches!(
                    cx.window_appearance(),
                    WindowAppearance::Light | WindowAppearance::VibrantLight
                );
                let expected = shared
                    .theme(light)
                    .unwrap()
                    .with_contrast(crate::contrast::Contrast::High);
                let mut loaded = fixture();
                loaded.config.theme = "Follow Herdr".into();
                loaded.config.contrast = crate::contrast::Contrast::High;
                loaded.shared = Some(shared);
                view.apply_loaded(Ok(loaded), cx);
                assert_eq!(view.theme, expected);
                cx.set_global(crate::app::InitialAppearance::default());
                view.apply_window_appearance(cx);
                assert_eq!(cx.global::<crate::app::InitialAppearance>().theme, expected);
                assert_eq!(view.config.theme, "Follow Herdr");
                assert!(!view.busy());
                assert!(view.error.is_none());
                assert!(view.source.upgrade().is_none());
            })
            .unwrap();
    });
}

#[gpui::test]
fn sizes_accepted_behind_a_load_survive_closing_the_window(cx: &mut TestAppContext) {
    let source = cx.add_window(crate::sidebar::layout_tests::fixture_window);
    let writes = Arc::new(Mutex::new(Vec::new()));
    let weak = cx.update(|cx| {
        let source = source.update(cx, |_, _, cx| cx.weak_entity()).unwrap();
        open_fixture(source, cx);
        let settings = cx.global::<SettingsWindowHandle>().window.unwrap();
        settings
            .update(cx, |view, window, cx| {
                view.size_io = Some(recording_sizes(writes.clone()));
                view.reload_with(fixture_load, cx);
                view.accept_control_size(FontFace::Terminal, 19., cx);
                view.accept_control_size(FontFace::Terminal, 21., cx);
                view.accept_control_size(FontFace::Sidebar, 17., cx);
                assert!(view.loading);
                assert!(writes.lock().unwrap().is_empty());
                window.remove_window();
                cx.weak_entity()
            })
            .unwrap()
    });
    cx.run_until_parked();
    assert_eq!(
        *writes.lock().unwrap(),
        vec![vec![(FontFace::Terminal, 21.), (FontFace::Sidebar, 17.)]]
    );
    assert!(weak.upgrade().is_none());
}

#[gpui::test]
fn save_refresh_does_not_overwrite_main_theme_preview(cx: &mut TestAppContext) {
    let source = cx.add_window(crate::sidebar::layout_tests::fixture_window);
    let preview = Theme::builtin("Nord").unwrap();
    cx.update(|cx| {
        let weak = source
            .update(cx, |view, _, cx| {
                view.menu.page = Some(crate::menu::Page::Themes);
                view.theme = preview.clone();
                cx.weak_entity()
            })
            .unwrap();
        open_fixture(weak, cx);
        cx.global::<SettingsWindowHandle>()
            .window
            .unwrap()
            .update(cx, |view, _, cx| {
                view.save_with(|| Ok(()), fixture_load, false, cx);
            })
            .unwrap();
    });
    cx.run_until_parked();
    cx.update(|cx| {
        source
            .update(cx, |view, _, _| {
                assert_eq!(view.theme, preview);
                assert_eq!(view.menu.page, Some(crate::menu::Page::Themes));
                assert!(view.config_load.is_none());
                assert!(view.settings.task.is_none());
            })
            .unwrap()
    });
}

#[gpui::test]
fn reload_publishes_baseline_and_rebinds_only_changed_keys(cx: &mut TestAppContext) {
    let source = cx.add_window(crate::sidebar::layout_tests::fixture_window);
    cx.update(|cx| {
        cx.set_global(crate::app::InitialAppearance::default());
        cx.bind_keys([KeyBinding::new("ctrl-alt-z", Close, Some("SettingsWindow"))]);
        let weak = source.update(cx, |_, _, cx| cx.weak_entity()).unwrap();
        open_fixture(weak, cx);
        cx.global::<SettingsWindowHandle>()
            .window
            .unwrap()
            .update(cx, |view, _, cx| {
                let mut loaded = fixture();
                loaded.config.ui.size = 19.;
                loaded.config.theme = "Nord".into();
                loaded.theme = Theme::builtin("Nord").unwrap();
                view.apply_loaded(Ok(loaded), cx);
                assert_eq!(
                    cx.global::<crate::app::InitialAppearance>().config.ui.size,
                    19.
                );
                assert_eq!(
                    cx.global::<crate::app::InitialAppearance>().theme,
                    view.theme
                );
                let keys = cx.key_bindings();
                assert_eq!(keys.borrow().bindings_for_action(&Close).count(), 1);
                let mut loaded = fixture();
                loaded.config.keybindings = crate::keymap::Keymap::with_overrides(
                    &std::collections::BTreeMap::from([(
                        "settings".into(),
                        crate::keymap::Binding::One("ctrl-alt-p".into()),
                    )]),
                    &Default::default(),
                    &crate::keymap::DaemonKeys::default(),
                )
                .unwrap();
                view.apply_loaded(Ok(loaded), cx);
                assert_eq!(
                    cx.global::<crate::app::InitialAppearance>()
                        .config
                        .keybindings
                        .primary(crate::controls::Command::Settings),
                    "ctrl-alt-p"
                );
                assert_eq!(
                    keys.borrow().bindings_for_action(&Close).count(),
                    key_bindings().len()
                );
            })
            .unwrap();
    });
}
