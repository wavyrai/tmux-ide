use super::*;

#[gpui::test]
fn singleton_reactivation_and_close_preserve_source(cx: &mut TestAppContext) {
    let source = cx.add_window(crate::sidebar::layout_tests::fixture_window);
    cx.update(|cx| {
        let weak = source.update(cx, |_, _, cx| cx.weak_entity()).unwrap();
        let original = source
            .update(cx, |view, window, cx| (view.menu.page, window.focused(cx)))
            .unwrap();
        open_fixture(weak.clone(), cx);
        let first = cx.global::<SettingsWindowHandle>().window.unwrap();
        open_fixture(weak, cx);
        assert_eq!(cx.windows().len(), 2);
        assert_eq!(cx.global::<SettingsWindowHandle>().window.unwrap(), first);
        first
            .update(cx, |view, window, _| {
                assert_eq!(view.section, Section::Appearance);
                assert!(view.focus.is_focused(window));
                assert!(!view.busy());
                window.remove_window();
            })
            .unwrap();
        assert_eq!(cx.windows(), vec![source.into()]);
        source
            .update(cx, |view, window, cx| {
                assert_eq!(view.menu.page, original.0);
                assert_eq!(window.focused(cx), original.1);
            })
            .unwrap();
    });
}

#[gpui::test]
fn command_w_closes_only_settings(cx: &mut TestAppContext) {
    let source = cx.add_window(crate::sidebar::layout_tests::fixture_window);
    let weak = cx.update(|cx| source.update(cx, |_, _, cx| cx.weak_entity()).unwrap());
    let (view, cx) = cx.add_window_view(|window, cx| {
        cx.bind_keys(key_bindings());
        let mut view = SettingsWindow::new(weak, cx);
        view.theme_io = Some(themes::ThemeIo {
            write: Arc::new(|_, _| panic!("closing without a theme edit must not write")),
            load: Arc::new(|| panic!("closing without a theme edit must not reload")),
            resolve: None,
        });
        window.focus(&view.focus, cx);
        view
    });
    cx.update(|window, cx| {
        window.draw(cx).clear(cx);
        assert!(view.read(cx).focus.is_focused(window));
    });
    cx.simulate_keystrokes("cmd-w");
    assert_eq!(cx.windows(), vec![source.into()]);
}

#[gpui::test]
fn control_w_closes_only_settings(cx: &mut TestAppContext) {
    let source = cx.add_window(crate::sidebar::layout_tests::fixture_window);
    let weak = cx.update(|cx| source.update(cx, |_, _, cx| cx.weak_entity()).unwrap());
    let (_, cx) = cx.add_window_view(|window, cx| {
        crate::bind_keys(cx);
        let mut view = SettingsWindow::new(weak, cx);
        view.theme_io = Some(themes::ThemeIo {
            write: Arc::new(|_, _| panic!("closing without a theme edit must not write")),
            load: Arc::new(|| panic!("closing without a theme edit must not reload")),
            resolve: None,
        });
        window.focus(&view.focus, cx);
        view
    });
    cx.simulate_keystrokes("ctrl-w");
    assert_eq!(cx.windows(), vec![source.into()]);
}

#[gpui::test]
fn settings_shortcut_and_session_shortcuts_do_not_route_to_source(cx: &mut TestAppContext) {
    let source = cx.add_window(crate::sidebar::layout_tests::fixture_window);
    let weak = cx.update(|cx| source.update(cx, |_, _, cx| cx.weak_entity()).unwrap());
    let (view, cx) = cx.add_window_view(|window, cx| {
        crate::bind_keys(cx);
        let view = SettingsWindow::new(weak, cx);
        window.focus(&view.focus, cx);
        view
    });
    cx.simulate_keystrokes("cmd-,");
    cx.simulate_keystrokes("cmd-shift-w");
    cx.update(|_, cx| {
        assert_eq!(cx.windows().len(), 2);
        assert!(source.read(cx).unwrap().menu.page.is_none());
        assert!(view.read(cx).error.is_none());
        source
            .update(cx, |_, window, _| window.remove_window())
            .unwrap();
    });
    cx.simulate_keystrokes("cmd-,");
    assert_eq!(cx.windows().len(), 1);
    view.read_with(cx, |view, _| assert!(!view.busy()));
    cx.simulate_keystrokes("cmd-w");
    assert!(cx.windows().is_empty());
}

#[gpui::test]
fn explicit_open_retargets_after_source_closes_but_not_during_integration_work(
    cx: &mut TestAppContext,
) {
    let first = cx.add_window(crate::sidebar::layout_tests::fixture_window);
    let second = cx.add_window(crate::sidebar::layout_tests::fixture_window);
    let (settings, next) = cx.update(|cx| {
        let original = first.update(cx, |_, _, cx| cx.weak_entity()).unwrap();
        let next = second.update(cx, |_, _, cx| cx.weak_entity()).unwrap();
        open_fixture(original.clone(), cx);
        let settings = cx.global::<SettingsWindowHandle>().window.unwrap();
        first
            .update(cx, |source, _, _| source.integrations.busy = true)
            .unwrap();
        open_fixture(next.clone(), cx);
        assert_eq!(
            settings.read(cx).unwrap().source.entity_id(),
            original.entity_id()
        );
        first
            .update(cx, |_, window, _| window.remove_window())
            .unwrap();
        (settings, next)
    });
    cx.run_until_parked();
    cx.update(|cx| {
        open_fixture(next.clone(), cx);
        assert_eq!(
            cx.global::<SettingsWindowHandle>().window.unwrap(),
            settings
        );
        assert_eq!(
            settings.read(cx).unwrap().source.entity_id(),
            next.entity_id()
        );
        second
            .update(cx, |source, _, _| {
                assert!(!source.integrations.busy);
                assert!(source.menu.page.is_none());
            })
            .unwrap();
    });
}

#[gpui::test]
fn categories_reset_scroll_without_touching_main_menu(cx: &mut TestAppContext) {
    let source = cx.add_window(crate::sidebar::layout_tests::fixture_window);
    cx.update(|cx| {
        let weak = source.update(cx, |_, _, cx| cx.weak_entity()).unwrap();
        open_fixture(weak, cx);
        let settings = cx.global::<SettingsWindowHandle>().window.unwrap();
        for &section in Section::ALL {
            settings
                .update(cx, |view, window, cx| {
                    view.body_scroll.set_offset(point(px(0.), px(-100.)));
                    view.select_section(section, window, cx);
                    assert_eq!(view.section, section);
                    assert_eq!(view.body_scroll.offset(), Point::default());
                    assert!(view.focus.is_focused(window));
                })
                .unwrap();
            source
                .update(cx, |view, _, _| assert!(view.menu.page.is_none()))
                .unwrap();
        }
    });
}

#[gpui::test]
fn new_window_target_survives_source_close_and_tracks_live_source(cx: &mut TestAppContext) {
    use herdr_client::ConnectTarget;
    let source = cx.add_window(crate::sidebar::layout_tests::fixture_window);
    let original = ConnectTarget::Socket("/unused-original.sock".into());
    let current = ConnectTarget::Socket("/unused-current.sock".into());
    let settings = cx.update(|cx| {
        let weak = source
            .update(cx, |view, _, cx| {
                view.endpoints[0].connection.target = original.clone();
                cx.weak_entity()
            })
            .unwrap();
        open_fixture(weak, cx);
        let settings = cx.global::<SettingsWindowHandle>().window.unwrap();
        source
            .update(cx, |view, _, _| {
                view.endpoints[0].connection.target = current.clone()
            })
            .unwrap();
        assert_eq!(
            settings.read(cx).unwrap().additional_window_target(cx),
            Some(current)
        );
        source
            .update(cx, |_, window, _| window.remove_window())
            .unwrap();
        settings
    });
    cx.run_until_parked();
    cx.update(|cx| {
        assert_eq!(
            settings.read(cx).unwrap().additional_window_target(cx),
            Some(original)
        )
    });
}
