use super::*;

#[gpui::test]
fn shared_theme_edit_support_does_not_restrict_native_or_follow_choices(cx: &mut TestAppContext) {
    let source = cx.add_window(crate::sidebar::layout_tests::fixture_window);
    cx.update(|cx| {
        let weak = source.update(cx, |_, _, cx| cx.weak_entity()).unwrap();
        open_fixture(weak, cx);
        cx.global::<SettingsWindowHandle>()
            .window
            .unwrap()
            .update(cx, |view, _, cx| {
                view.shared =
                    Some(herdr_settings::Settings::parse_text("[theme]\nname='nord'\n").unwrap());
                view.config.theme = "Follow Herdr".into();
                view.theme = view.shared.as_ref().unwrap().theme(false).unwrap();
                let original = view.theme.clone();
                let main_theme = source.read(cx).unwrap().theme.clone();
                view.accept_theme_choice(
                    themes::Choice {
                        scope: themes::Scope::Herdr,
                        name: "dracula".into(),
                    },
                    cx,
                );
                assert_eq!(view.theme_dirty(), cfg!(unix));
                assert_eq!(theme_pending(cx), cfg!(unix));
                if cfg!(unix) {
                    assert_ne!(view.theme, original);
                } else {
                    assert_eq!(view.theme, original);
                    assert_eq!(source.read(cx).unwrap().theme, main_theme);
                    assert!(view.status.as_ref().unwrap().contains("read-only"));
                    assert!(!view.theme_loading);
                    assert!(!view.saving);
                }
                choose(view, "Nord", cx);
                assert!(view.theme_dirty());
                assert_eq!(view.config.theme, "Nord");
                choose(view, "Follow Herdr", cx);
                assert!(view.theme_dirty());
                assert_eq!(view.config.theme, "Follow Herdr");
            })
            .unwrap();
    });
}

#[gpui::test]
fn external_theme_loads_coalesce_and_only_latest_validated_result_paints(cx: &mut TestAppContext) {
    let source = cx.add_window(crate::sidebar::layout_tests::fixture_window);
    let loads = Arc::new(Mutex::new(Vec::new()));
    let writes = Arc::new(Mutex::new(Vec::new()));
    let settings = cx.update(|cx| {
        let weak = source.update(cx, |_, _, cx| cx.weak_entity()).unwrap();
        open_fixture(weak, cx);
        let settings = cx.global::<SettingsWindowHandle>().window.unwrap();
        settings
            .update(cx, |view, _, cx| {
                let loads = loads.clone();
                let writes = writes.clone();
                view.theme_io = Some(themes::ThemeIo {
                    resolve: Some(Arc::new(move |name| {
                        loads.lock().unwrap().push(name.to_owned());
                        Ok(Theme::builtin(if name == "external-c" {
                            "Dracula"
                        } else {
                            "Nord"
                        })
                        .unwrap())
                    })),
                    write: Arc::new(move |name, _| {
                        writes.lock().unwrap().push(name);
                        Ok(())
                    }),
                    load: Arc::new(|| {
                        let mut loaded = fixture();
                        loaded.config.theme = "external-c".into();
                        loaded.theme = Theme::builtin("Dracula").unwrap();
                        Ok(loaded)
                    }),
                });
                for name in ["external-a", "external-b", "external-c"] {
                    choose(view, name, cx);
                }
                assert_eq!(view.theme, Theme::default());
            })
            .unwrap();
        settings
    });
    cx.run_until_parked();
    assert_eq!(*loads.lock().unwrap(), ["external-a", "external-c"]);
    assert!(writes.lock().unwrap().is_empty());
    cx.update(|cx| {
        settings
            .update(cx, |view, _, cx| {
                choose(view, "Nord", cx);
                choose(view, "external-c", cx);
                assert!(
                    !view.theme_loading,
                    "returning to a validated definition uses the cache"
                );
            })
            .unwrap();
        assert_eq!(
            settings.read(cx).unwrap().theme,
            Theme::builtin("Dracula").unwrap()
        );
        assert_eq!(
            source.read(cx).unwrap().theme,
            Theme::builtin("Dracula").unwrap()
        );
        settings
            .update(cx, |view, window, cx| view.close(window, cx))
            .unwrap();
    });
    cx.run_until_parked();
    assert_eq!(*writes.lock().unwrap(), ["external-c"]);
    assert_eq!(*loads.lock().unwrap(), ["external-a", "external-c"]);
}

#[gpui::test]
fn failed_definition_keeps_close_pending_draft_for_explicit_retry(cx: &mut TestAppContext) {
    let source = cx.add_window(crate::sidebar::layout_tests::fixture_window);
    let loads = Arc::new(AtomicUsize::new(0));
    let settings = cx.update(|cx| {
        let weak = source.update(cx, |_, _, cx| cx.weak_entity()).unwrap();
        open_fixture(weak, cx);
        let settings = cx.global::<SettingsWindowHandle>().window.unwrap();
        settings
            .update(cx, |view, window, cx| {
                let loads = loads.clone();
                view.theme_io = Some(themes::ThemeIo {
                    write: Arc::new(|_, _| panic!("invalid definitions must not be persisted")),
                    load: Arc::new(|| panic!("validation must not reload config")),
                    resolve: Some(Arc::new(move |_| {
                        loads.fetch_add(1, Ordering::SeqCst);
                        Err(crate::Error::MissingHome)
                    })),
                });
                choose(view, "missing-definition", cx);
                assert!(!view.should_close(window, cx));
            })
            .unwrap();
        settings
    });
    cx.run_until_parked();
    cx.run_until_parked();
    assert_eq!(loads.load(Ordering::SeqCst), 1);
    cx.update(|cx| {
        let view = settings.read(cx).unwrap();
        assert!(view.theme_dirty());
        assert!(view.closing.is_none());
        assert!(view.error.as_ref().unwrap().contains("Load theme"));
        source
            .update(cx, |view, _, cx| {
                view.load_gui_config_with(
                    || {
                        let mut config = Config::default();
                        config.ui.size = 23.;
                        Ok((config, Theme::default()))
                    },
                    cx,
                );
            })
            .unwrap();
    });
    cx.run_until_parked();
    assert_eq!(loads.load(Ordering::SeqCst), 1);
    cx.update(|cx| assert_eq!(source.read(cx).unwrap().config.ui.size, 23.));
}

#[gpui::test]
fn shared_selection_preserves_native_override_and_follow_uses_prepared_colors(
    cx: &mut TestAppContext,
) {
    let source = cx.add_window(crate::sidebar::layout_tests::fixture_window);
    cx.update(|cx| {
        let weak = source.update(cx, |_, _, cx| cx.weak_entity()).unwrap();
        open_fixture(weak, cx);
        cx.global::<SettingsWindowHandle>()
            .window
            .unwrap()
            .update(cx, |view, _, cx| {
                view.shared = Some(
                    herdr_settings::Settings::parse_text(
                        "[theme]\nname='nord'\n[theme.custom]\naccent='#123456'\n",
                    )
                    .unwrap(),
                );
                view.saving = true; // Hold the root slot, without scheduling any real I/O.
                view.accept_theme_choice(
                    themes::Choice {
                        scope: themes::Scope::Herdr,
                        name: "dracula".into(),
                    },
                    cx,
                );
                assert_eq!(view.config.theme, "Default");
                assert_eq!(view.theme, Theme::default());
                assert_eq!(source.read(cx).unwrap().theme, Theme::default());
                choose(view, "Follow Herdr", cx);
                let expected = view
                    .shared
                    .as_ref()
                    .unwrap()
                    .theme(view.theme_light)
                    .unwrap();
                assert_eq!(view.theme, expected);
                assert_eq!(view.theme.primary(), 0x123456);
                assert_eq!(source.read(cx).unwrap().theme, expected);
                assert_eq!(source.read(cx).unwrap().config.theme, "Follow Herdr");
            })
            .unwrap();
    });
}

#[gpui::test]
fn explicit_theme_applies_contrast_once_and_shared_callbacks_cannot_restore_old_palette(
    cx: &mut TestAppContext,
) {
    let source = cx.add_window(crate::sidebar::layout_tests::fixture_window);
    let expected = Theme::builtin("Nord")
        .unwrap()
        .with_contrast(crate::contrast::Contrast::High);
    let settings = cx.update(|cx| {
        let weak = source.update(cx, |_, _, cx| cx.weak_entity()).unwrap();
        open_fixture(weak, cx);
        let settings = cx.global::<SettingsWindowHandle>().window.unwrap();
        settings
            .update(cx, |view, _, cx| {
                view.config.contrast = crate::contrast::Contrast::High;
                view.saving = true;
                choose(view, "Nord", cx);
                assert_eq!(view.theme, expected);
                assert_eq!(source.read(cx).unwrap().theme, expected);
                view.shared =
                    Some(herdr_settings::Settings::parse_text("[theme]\nname='nord'").unwrap());
                choose(view, "Follow Herdr", cx);
            })
            .unwrap();
        source
            .update(cx, |view, _, cx| {
                view.settings.shared =
                    Some(herdr_settings::Settings::parse_text("[theme]\nname='dracula'").unwrap());
                view.apply_shared_theme(cx);
            })
            .unwrap();
        settings
    });
    cx.run_until_parked();
    cx.update(|cx| {
        let view = settings.read(cx).unwrap();
        assert_eq!(source.read(cx).unwrap().theme, view.theme);
        assert_eq!(
            cx.global::<crate::app::InitialAppearance>().theme,
            view.theme
        );
    });
}
