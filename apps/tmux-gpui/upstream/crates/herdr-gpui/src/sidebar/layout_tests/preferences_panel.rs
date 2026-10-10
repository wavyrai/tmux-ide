use super::*;

/// Preferences lists every feature flag, in both states: the config file is
/// the only place a flag is turned on.
#[gpui::test]
fn preferences_list_feature_flags(cx: &mut gpui::TestAppContext) {
    let (view, cx) = cx.add_window_view(|window, cx| {
        crate::bind_keys(cx);
        fixture_window(window, cx)
    });
    cx.simulate_resize(size(px(900.), px(1200.)));
    for enabled in [false, true] {
        cx.update(|window, cx| {
            view.update(cx, |view, cx| {
                view.config.features.sidebar_hover_menu = enabled;
                view.open_preferences_fixture(window, cx);
                view.select_settings_tab(crate::settings_panel::Tab::General, window, cx);
            });
            full_draw(window, cx).clear(cx);
        });
        let body = cx.debug_bounds("preferences-body").unwrap();
        for (id, label, _) in crate::preferences::feature_rows(&Default::default()) {
            let bounds = cx.debug_bounds(id).unwrap_or_else(|| panic!("{label} row"));
            // Other settings can place feature flags below the initial viewport.
            cx.update(|window, cx| {
                let scroll = &view.read(cx).menu.preferences_scroll;
                scroll.set_offset(
                    scroll.offset() + point(px(0.), body.center().y - bounds.center().y),
                );
                window.refresh();
                full_draw(window, cx).clear(cx);
            });
            let bounds = cx.debug_bounds(id).unwrap_or_else(|| panic!("{label} row"));
            assert!(
                body.contains(&bounds.center()),
                "{label} row outside the body"
            );
        }
    }
}

#[gpui::test]
fn preferences_tabs_stay_on_one_row_and_font_input_keeps_native_focus(
    cx: &mut gpui::TestAppContext,
) {
    use crate::settings_panel::Tab;
    let (view, cx) = cx.add_window_view(|window, cx| {
        crate::bind_keys(cx);
        fixture_window(window, cx)
    });
    cx.simulate_resize(size(px(320.), px(400.)));
    cx.update(|window, cx| {
        let focus = view.read(cx).focus.clone();
        window.focus(&focus, cx);
        window.draw(cx).clear(cx);
    });
    // Opening the modal changes the focus tree; paint it before routing the next key.
    cx.update(|window, cx| {
        view.update(cx, |view, cx| view.open_preferences_fixture(window, cx));
        window.draw(cx).clear(cx);
        assert!(view.read(cx).menu.page == Some(crate::menu::Page::Preferences));
        assert!(view.read(cx).menu.focus.is_focused(window));
    });
    cx.simulate_keystrokes("shift-tab");
    cx.update(|window, cx| {
        assert_eq!(view.read(cx).settings.tab, Tab::General);
        window.draw(cx).clear(cx);
    });
    let panel = cx.debug_bounds("menu-panel").unwrap();
    let tabs = cx.debug_bounds("preferences-tabs").unwrap();
    assert!(tabs.left() >= panel.left() && tabs.right() <= panel.right());
    let first = cx.debug_bounds("preferences-tab-Theme").unwrap();
    for selector in [
        "preferences-tab-Theme",
        "preferences-tab-Indicators",
        "preferences-tab-Sound",
        "preferences-tab-Toasts",
        "preferences-tab-Integrations",
        "preferences-tab-Font",
        "preferences-tab-General",
    ] {
        let bounds = cx.debug_bounds(selector).unwrap();
        assert_eq!(bounds.top(), first.top(), "tabs must never wrap");
        assert_eq!(bounds.size.height, first.size.height);
    }
    let selected = cx.debug_bounds("preferences-tab-General").unwrap();
    assert!(selected.left() >= tabs.left() && selected.right() <= tabs.right());
    assert!(view.read_with(cx, |view, _| view.settings.tabs_scroll.offset().x < px(0.)));
    cx.simulate_keystrokes("tab");
    cx.update(|window, cx| {
        assert_eq!(view.read(cx).settings.tab, Tab::Theme);
        view.update(cx, |view, cx| {
            view.select_settings_tab(Tab::Font, window, cx)
        });
        window.draw(cx).clear(cx);
    });
    assert!(cx.debug_bounds("preferences-font-terminal").is_some());
    let input = cx.debug_bounds("preferences-font-sidebar-size").unwrap();
    cx.simulate_click(input.center(), Default::default());
    cx.simulate_keystrokes("cmd-a 1 8 tab");
    cx.update(|_, cx| assert_eq!(view.read(cx).settings.tab, Tab::Font));
    // Escape first leaves the editor, then Tab resumes section navigation.
    cx.simulate_keystrokes("escape");
    cx.simulate_keystrokes("tab");
    cx.update(|_, cx| assert_eq!(view.read(cx).settings.tab, Tab::General));
    cx.simulate_keystrokes("escape");
    cx.update(|window, cx| assert!(view.read(cx).focus.is_focused(window)));
}

#[gpui::test]
fn preferences_tabs_fit_desktop_and_shared_details_only_appear_in_general(
    cx: &mut gpui::TestAppContext,
) {
    use crate::settings_panel::Tab;
    let (view, cx) = cx.add_window_view(fixture_window);
    cx.simulate_resize(size(px(1200.), px(850.)));
    for font_size in [12., 16.] {
        cx.update(|window, cx| {
            view.update(cx, |view, cx| {
                view.config.ui.size = font_size;
                view.menu.page = Some(crate::menu::Page::Preferences);
                view.select_settings_tab(Tab::Theme, window, cx);
            });
            window.draw(cx).clear(cx);
        });
        let tabs = cx.debug_bounds("preferences-tabs").unwrap();
        let first = cx.debug_bounds("preferences-tab-Theme").unwrap();
        let last = cx.debug_bounds("preferences-tab-General").unwrap();
        assert_eq!(first.top(), last.top());
        assert!(first.left() >= tabs.left() && last.right() <= tabs.right());
    }
    for tab in [
        Tab::Theme,
        Tab::Indicators,
        Tab::Sound,
        Tab::Toasts,
        Tab::General,
    ] {
        cx.update(|window, cx| {
            view.update(cx, |view, cx| view.select_settings_tab(tab, window, cx));
            window.draw(cx).clear(cx);
        });
        assert_eq!(
            cx.debug_bounds("preferences-shared-path").is_some(),
            tab == Tab::General,
        );
        assert_eq!(
            cx.debug_bounds("preferences-reload-shared").is_some(),
            tab == Tab::General,
        );
    }
}
