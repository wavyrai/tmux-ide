use super::*;

#[gpui::test]
fn keyboard_close_writes_final_draft_once_and_browsing_never_reloads_config(
    cx: &mut TestAppContext,
) {
    let source = cx.add_window(crate::sidebar::layout_tests::fixture_window);
    let weak = cx.update(|cx| source.update(cx, |_, _, cx| cx.weak_entity()).unwrap());
    let writes = Arc::new(Mutex::new(Vec::new()));
    let reloads = Arc::new(AtomicUsize::new(0));
    let (view, cx) = cx.add_window_view(|window, cx| {
        cx.bind_keys(key_bindings());
        let mut view = SettingsWindow::new(weak, cx);
        let mut io = recording_themes(writes.clone(), false);
        let load = io.load.clone();
        let reloads = reloads.clone();
        io.load = Arc::new(move || {
            reloads.fetch_add(1, Ordering::SeqCst);
            load()
        });
        view.theme_io = Some(io);
        window.focus(&view.focus, cx);
        view
    });
    for name in ["Default", "Dracula", "Nord"] {
        view.update(cx, |view, cx| choose(view, name, cx));
        cx.run_until_parked();
        assert!(writes.lock().unwrap().is_empty());
        assert_eq!(reloads.load(Ordering::SeqCst), 0);
        view.read_with(cx, |view, _| assert!(view.theme_dirty()));
    }
    cx.simulate_keystrokes("cmd-w");
    cx.run_until_parked();
    assert_eq!(*writes.lock().unwrap(), ["Nord"]);
    assert_eq!(reloads.load(Ordering::SeqCst), 1);
    assert_eq!(cx.windows(), [source.into()]);
}

#[gpui::test]
fn non_theme_save_preserves_draft_and_reapplies_contrast_once(cx: &mut TestAppContext) {
    let source = cx.add_window(crate::sidebar::layout_tests::fixture_window);
    let writes = Arc::new(Mutex::new(Vec::new()));
    let settings = cx.update(|cx| {
        let weak = source.update(cx, |_, _, cx| cx.weak_entity()).unwrap();
        open_fixture(weak, cx);
        let settings = cx.global::<SettingsWindowHandle>().window.unwrap();
        settings
            .update(cx, |view, _, cx| {
                view.theme_io = Some(recording_themes(writes.clone(), false));
                choose(view, "Nord", cx);
                view.save_with(
                    || Ok(()),
                    || {
                        let mut loaded = fixture();
                        loaded.config.ui.size = 22.;
                        loaded.config.contrast = crate::contrast::Contrast::High;
                        Ok(loaded)
                    },
                    false,
                    cx,
                );
            })
            .unwrap();
        settings
    });
    cx.run_until_parked();
    assert!(writes.lock().unwrap().is_empty());
    cx.update(|cx| {
        let view = settings.read(cx).unwrap();
        assert_eq!(view.config.ui.size, 22.);
        assert_eq!(view.config.theme, "Nord");
        let expected = Theme::builtin("Nord")
            .unwrap()
            .with_contrast(crate::contrast::Contrast::High);
        assert_eq!(view.theme, expected);
        assert_eq!(source.read(cx).unwrap().theme, expected);
        assert!(view.theme_dirty());
        assert!(!view.saving);
    });
}

#[gpui::test]
fn close_while_latest_external_choice_loads_saves_only_that_choice(cx: &mut TestAppContext) {
    let source = cx.add_window(crate::sidebar::layout_tests::fixture_window);
    let writes = Arc::new(Mutex::new(Vec::new()));
    let loads = Arc::new(Mutex::new(Vec::new()));
    let settings = cx.update(|cx| {
        let weak = source.update(cx, |_, _, cx| cx.weak_entity()).unwrap();
        open_fixture(weak, cx);
        let settings = cx.global::<SettingsWindowHandle>().window.unwrap();
        settings
            .update(cx, |view, window, cx| {
                let writes = writes.clone();
                let loads = loads.clone();
                view.theme_io = Some(themes::ThemeIo {
                    write: Arc::new(move |name, _| {
                        writes.lock().unwrap().push(name);
                        Ok(())
                    }),
                    resolve: Some(Arc::new(move |name| {
                        loads.lock().unwrap().push(name.to_owned());
                        Ok(Theme::builtin("Nord").unwrap())
                    })),
                    load: Arc::new(|| {
                        let mut loaded = fixture();
                        loaded.config.theme = "external-c".into();
                        loaded.theme = Theme::builtin("Nord").unwrap();
                        Ok(loaded)
                    }),
                });
                for name in ["external-a", "external-b", "external-c"] {
                    choose(view, name, cx);
                }
                assert!(!view.should_close(window, cx));
                assert!(!view.saving);
                assert!(view.theme_loading);
            })
            .unwrap();
        settings
    });
    cx.run_until_parked();
    assert_eq!(*loads.lock().unwrap(), ["external-a", "external-c"]);
    assert_eq!(*writes.lock().unwrap(), ["external-c"]);
    cx.update(|cx| {
        assert!(settings.read(cx).is_err());
        assert_eq!(
            source.read(cx).unwrap().theme,
            Theme::builtin("Nord").unwrap()
        );
        assert!(!theme_pending(cx));
    });
}

#[gpui::test]
fn theme_draft_paints_all_windows_and_allows_non_theme_reload(cx: &mut TestAppContext) {
    let first = cx.add_window(crate::sidebar::layout_tests::fixture_window);
    let second = cx.add_window(crate::sidebar::layout_tests::fixture_window);
    let writes = Arc::new(Mutex::new(Vec::new()));
    cx.update(|cx| {
        cx.set_global(crate::app::InitialAppearance::default());
        let source = first
            .update(cx, |view, _, cx| {
                view.config.terminal.size = 29.;
                view.load_gui_config_with(
                    || {
                        let mut config = Config::default();
                        config.ui.size = 21.;
                        Ok((config, Theme::default()))
                    },
                    cx,
                );
                cx.weak_entity()
            })
            .unwrap();
        second
            .update(cx, |view, _, _| view.config.ui.size = 23.)
            .unwrap();
        open_fixture(source, cx);
        cx.global::<SettingsWindowHandle>()
            .window
            .unwrap()
            .update(cx, |view, _, cx| {
                view.theme_io = Some(recording_themes(writes.clone(), false));
                choose(view, "Nord", cx);
                assert!(!view.saving);
                assert!(view.theme_dirty());
                assert_eq!(view.theme, Theme::builtin("Nord").unwrap());
                assert!(writes.lock().unwrap().is_empty());
            })
            .unwrap();
        for main in [first, second] {
            assert_eq!(
                main.read(cx).unwrap().theme,
                Theme::builtin("Nord").unwrap()
            );
            assert_eq!(main.read(cx).unwrap().config.theme, "Nord");
        }
        assert_eq!(first.read(cx).unwrap().config.terminal.size, 29.);
        assert_eq!(second.read(cx).unwrap().config.ui.size, 23.);
        assert_eq!(
            cx.global::<crate::app::InitialAppearance>().theme,
            Theme::builtin("Nord").unwrap()
        );
    });
    cx.run_until_parked();
    assert!(writes.lock().unwrap().is_empty());
    cx.update(|cx| {
        assert!(theme_pending(cx));
        assert_eq!(first.read(cx).unwrap().config.ui.size, 21.);
        assert_eq!(second.read(cx).unwrap().config.ui.size, 23.);
        assert_eq!(
            first.read(cx).unwrap().theme,
            Theme::builtin("Nord").unwrap()
        );
    });
}

#[gpui::test]
fn native_close_saves_only_final_theme_after_current_root_save(cx: &mut TestAppContext) {
    let source = cx.add_window(crate::sidebar::layout_tests::fixture_window);
    let writes = Arc::new(Mutex::new(Vec::new()));
    cx.update(|cx| {
        let weak = source.update(cx, |_, _, cx| cx.weak_entity()).unwrap();
        open_fixture(weak, cx);
        cx.global::<SettingsWindowHandle>()
            .window
            .unwrap()
            .update(cx, |view, window, cx| {
                view.theme_io = Some(recording_themes(writes.clone(), false));
                view.save_with(|| Ok(()), fixture_load, false, cx);
                choose(view, "Nord", cx);
                choose(view, "Dracula", cx);
                choose(view, "Default", cx);
                assert_eq!(view.theme, Theme::default());
                assert!(writes.lock().unwrap().is_empty());
                assert!(!view.should_close(window, cx));
                assert!(!view.should_close(window, cx));
            })
            .unwrap();
    });
    cx.run_until_parked();
    assert_eq!(*writes.lock().unwrap(), ["Default"]);
    cx.update(|cx| {
        assert!(!theme_pending(cx));
        assert_eq!(source.read(cx).unwrap().theme, Theme::default());
        assert!(
            cx.global::<SettingsWindowHandle>()
                .model
                .as_ref()
                .unwrap()
                .upgrade()
                .is_none()
        );
    });
}

#[gpui::test]
fn theme_close_failure_keeps_window_and_draft_without_retrying(cx: &mut TestAppContext) {
    let source = cx.add_window(crate::sidebar::layout_tests::fixture_window);
    let writes = Arc::new(Mutex::new(Vec::new()));
    let settings = cx.update(|cx| {
        let weak = source.update(cx, |_, _, cx| cx.weak_entity()).unwrap();
        open_fixture(weak, cx);
        let settings = cx.global::<SettingsWindowHandle>().window.unwrap();
        settings
            .update(cx, |view, window, cx| {
                view.theme_io = Some(recording_themes(writes.clone(), true));
                choose(view, "Nord", cx);
                assert_eq!(view.theme, Theme::builtin("Nord").unwrap());
                view.close(window, cx);
            })
            .unwrap();
        settings
    });
    cx.run_until_parked();
    assert_eq!(*writes.lock().unwrap(), ["Nord"]);
    cx.update(|cx| {
        let view = settings.read(cx).unwrap();
        assert_eq!(view.theme, Theme::builtin("Nord").unwrap());
        assert!(view.error.as_ref().unwrap().contains("Save settings"));
        assert!(!view.saving);
        assert!(theme_pending(cx));
        assert!(view.theme_dirty());
        assert!(view.closing.is_none());
        assert_eq!(
            source.read(cx).unwrap().theme,
            Theme::builtin("Nord").unwrap()
        );
        assert_eq!(
            cx.global::<crate::app::InitialAppearance>().theme,
            Theme::builtin("Nord").unwrap()
        );
    });
    cx.run_until_parked();
    assert_eq!(*writes.lock().unwrap(), ["Nord"]);
    cx.update(|cx| {
        settings
            .update(cx, |view, window, cx| {
                view.theme_io = Some(recording_themes(writes.clone(), false));
                view.close(window, cx);
            })
            .unwrap()
    });
    cx.run_until_parked();
    cx.update(|cx| assert!(settings.read(cx).is_err()));
    assert_eq!(*writes.lock().unwrap(), ["Nord", "Nord"]);
}

#[gpui::test]
fn accepted_close_survives_source_close_and_reactivation_and_fences_late_theme_reads(
    cx: &mut TestAppContext,
) {
    let source = cx.add_window(crate::sidebar::layout_tests::fixture_window);
    let writes = Arc::new(Mutex::new(Vec::new()));
    let (settings, revision) = cx.update(|cx| {
        let weak = source.update(cx, |_, _, cx| cx.weak_entity()).unwrap();
        open_fixture(weak.clone(), cx);
        let settings = cx.global::<SettingsWindowHandle>().window.unwrap();
        source
            .update(cx, |_, window, _| window.remove_window())
            .unwrap();
        let revision = theme_load_revision(cx);
        settings
            .update(cx, |view, window, cx| {
                view.theme_io = Some(recording_themes(writes.clone(), false));
                choose(view, "Nord", cx);
                view.close(window, cx);
                assert!(view.saving);
            })
            .unwrap();
        open_fixture(weak, cx);
        assert_eq!(cx.global::<SettingsWindowHandle>().window, Some(settings));
        (settings, revision)
    });
    cx.run_until_parked();
    assert_eq!(*writes.lock().unwrap(), ["Nord"]);
    cx.update(|cx| {
        assert!(settings.read(cx).is_err());
        assert!(!theme_pending(cx));
        let mut config = Config::default();
        config.ui.size = 25.;
        let mut theme = Theme::default();
        apply_loaded_theme(&mut config, &mut theme, revision, cx);
        assert_eq!(config.ui.size, 25.);
        assert_eq!(config.theme, "Nord");
        assert_eq!(theme, Theme::builtin("Nord").unwrap());
    });
}

#[gpui::test]
fn theme_selection_cancels_main_picker_and_preserves_focus(cx: &mut TestAppContext) {
    let source = cx.add_window(crate::sidebar::layout_tests::fixture_window);
    let writes = Arc::new(Mutex::new(Vec::new()));
    cx.update(|cx| {
        let weak = source
            .update(cx, |view, window, cx| {
                view.open_theme_picker(window, cx);
                cx.weak_entity()
            })
            .unwrap();
        open_fixture(weak, cx);
        cx.global::<SettingsWindowHandle>()
            .window
            .unwrap()
            .update(cx, |view, _, cx| {
                view.theme_io = Some(recording_themes(writes, false));
                choose(view, "Nord", cx);
            })
            .unwrap();
        source
            .update(cx, |view, window, cx| {
                assert!(view.menu.page.is_none());
                assert_eq!(view.theme, Theme::builtin("Nord").unwrap());
                view.dismiss_menu(window, cx);
                assert_eq!(view.theme, Theme::builtin("Nord").unwrap());
            })
            .unwrap();
    });
    cx.run_until_parked();
}
