use super::*;

#[gpui::test]
fn layout_clicks_apply_live_without_writing_and_close_commits_only_final(cx: &mut TestAppContext) {
    use crate::config::LayoutMode;
    let first = cx.add_window(crate::sidebar::layout_tests::fixture_window);
    let second = cx.add_window(crate::sidebar::layout_tests::fixture_window);
    let writes = Arc::new(Mutex::new(Vec::new()));
    let weak = cx.update(|cx| first.update(cx, |_, _, cx| cx.weak_entity()).unwrap());
    let (view, cx) = cx.add_window_view(|window, cx| {
        cx.bind_keys(key_bindings());
        let mut view = SettingsWindow::new(weak, cx);
        view.layout_io = Some(recording_layouts(writes.clone(), false));
        window.focus(&view.focus, cx);
        view
    });
    cx.simulate_resize(size(px(960.), px(2200.)));
    let revision = cx.update(|_, cx| layout_load_revision(cx));
    for (mode, selector) in [
        (LayoutMode::Orca, "settings-layout-orca"),
        (LayoutMode::Minimal, "settings-layout-minimal"),
        (LayoutMode::Superset, "settings-layout-superset"),
    ] {
        cx.update(|window, cx| crate::sidebar::layout_tests::full_draw(window, cx).clear(cx));
        let bounds = cx.debug_bounds(selector).unwrap();
        cx.simulate_click(bounds.center(), Default::default());
        cx.run_until_parked();
        assert!(writes.lock().unwrap().is_empty());
        view.read_with(cx, |view, cx| {
            assert_eq!(view.layout_intent, Some(mode));
            assert_eq!(view.config.layout.mode, mode);
            assert!(!view.busy());
            assert!(view.save_completion.is_none());
            for main in [first, second] {
                assert_eq!(main.read(cx).unwrap().config.layout.mode, mode);
            }
            assert_eq!(
                cx.global::<crate::app::InitialAppearance>()
                    .config
                    .layout
                    .mode,
                mode
            );
        });
    }
    cx.simulate_keystrokes("cmd-w");
    cx.run_until_parked();
    assert_eq!(*writes.lock().unwrap(), [LayoutMode::Superset]);
    assert_eq!(cx.windows().len(), 2);
    view.read_with(cx, |_, cx| {
        let mut stale = Config::default();
        apply_loaded_layout(&mut stale, revision, cx);
        assert_eq!(stale.layout.mode, LayoutMode::Superset);
        let mut fresh = Config::default();
        apply_loaded_layout(&mut fresh, layout_load_revision(cx), cx);
        assert_eq!(fresh.layout.mode, Config::default().layout.mode);
    });
}

#[gpui::test]
fn layout_draft_survives_settings_and_main_reloads_and_other_saves(cx: &mut TestAppContext) {
    use crate::config::LayoutMode;
    let main = cx.add_window(crate::sidebar::layout_tests::fixture_window);
    let writes = Arc::new(Mutex::new(Vec::new()));
    let settings = cx.update(|cx| {
        let weak = main
            .update(cx, |view, _, cx| {
                view.load_gui_config_with(|| Ok((Config::default(), Theme::default())), cx);
                cx.weak_entity()
            })
            .unwrap();
        open_fixture(weak, cx);
        let settings = cx.global::<SettingsWindowHandle>().window.unwrap();
        settings
            .update(cx, |view, _, cx| {
                view.layout_io = Some(recording_layouts(writes.clone(), false));
                view.save_with(
                    || Ok(()),
                    || {
                        let mut loaded = fixture();
                        loaded.config.ui.size = 23.;
                        Ok(loaded)
                    },
                    false,
                    cx,
                );
                view.accept_layout_choice(LayoutMode::Orca, cx);
            })
            .unwrap();
        settings
    });
    cx.run_until_parked();
    cx.update(|cx| {
        let view = settings.read(cx).unwrap();
        assert_eq!(view.config.ui.size, 23.);
        assert_eq!(view.config.layout.mode, LayoutMode::Orca);
        assert_eq!(main.read(cx).unwrap().config.layout.mode, LayoutMode::Orca);
        settings
            .update(cx, |view, _, cx| view.reload_with(fixture_load, cx))
            .unwrap();
    });
    cx.run_until_parked();
    cx.update(|cx| {
        let view = settings.read(cx).unwrap();
        assert_eq!(view.config.layout.mode, LayoutMode::Orca);
        assert_eq!(view.layout_intent, Some(LayoutMode::Orca));
        assert_eq!(
            cx.global::<crate::app::InitialAppearance>()
                .config
                .layout
                .mode,
            LayoutMode::Orca
        );
    });
    assert!(writes.lock().unwrap().is_empty());
}

#[gpui::test]
fn layout_close_failure_retains_live_draft_until_explicit_retry(cx: &mut TestAppContext) {
    use crate::config::LayoutMode;
    let main = cx.add_window(crate::sidebar::layout_tests::fixture_window);
    let writes = Arc::new(Mutex::new(Vec::new()));
    let settings = cx.update(|cx| {
        let weak = main.update(cx, |_, _, cx| cx.weak_entity()).unwrap();
        open_fixture(weak, cx);
        let settings = cx.global::<SettingsWindowHandle>().window.unwrap();
        settings
            .update(cx, |view, window, cx| {
                view.layout_io = Some(recording_layouts(writes.clone(), true));
                view.accept_layout_choice(LayoutMode::Orca, cx);
                assert!(!view.should_close(window, cx));
                assert!(!view.should_close(window, cx));
                view.accept_layout_choice(LayoutMode::Minimal, cx);
            })
            .unwrap();
        settings
    });
    cx.run_until_parked();
    assert_eq!(*writes.lock().unwrap(), [LayoutMode::Orca]);
    cx.update(|cx| {
        settings
            .update(cx, |view, _, cx| {
                assert!(view.closing.is_none());
                assert!(!view.busy());
                assert!(view.error.as_ref().unwrap().contains("Save settings"));
                assert_eq!(view.layout_intent, Some(LayoutMode::Orca));
                assert_eq!(view.config.layout.mode, LayoutMode::Orca);
                assert_eq!(main.read(cx).unwrap().config.layout.mode, LayoutMode::Orca);
                view.reload_with(fixture_load, cx);
            })
            .unwrap();
    });
    cx.run_until_parked();
    assert_eq!(*writes.lock().unwrap(), [LayoutMode::Orca]);
    cx.update(|cx| {
        settings
            .update(cx, |view, window, cx| {
                view.layout_io = Some(recording_layouts(writes.clone(), false));
                view.close(window, cx);
            })
            .unwrap()
    });
    cx.run_until_parked();
    cx.update(|cx| assert!(settings.read(cx).is_err()));
    assert_eq!(
        *writes.lock().unwrap(),
        [LayoutMode::Orca, LayoutMode::Orca]
    );
}
