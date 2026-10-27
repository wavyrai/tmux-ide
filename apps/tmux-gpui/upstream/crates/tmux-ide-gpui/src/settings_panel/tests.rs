use super::*;
use core::prelude::v1::test;

#[core::prelude::v1::test]
fn tabs_cycle_in_both_directions() {
    for (index, tab) in Tab::ALL.into_iter().enumerate() {
        assert_eq!(tab.next(false), Tab::ALL[(index + 1) % Tab::ALL.len()]);
        assert_eq!(tab.next(true).next(false), tab);
    }
    assert_eq!(Tab::General.next(false), Tab::Theme);
    assert_eq!(Tab::Theme.next(true), Tab::General);
}

#[gpui::test]
fn general_retains_layout_summary_and_sound_uses_explicit_preview(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(crate::sidebar::layout_tests::fixture_window);
    cx.simulate_resize(size(px(800.), px(600.)));
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.open_menu(window, cx);
            view.menu.page = Some(crate::menu::Page::Preferences);
            view.config.layout.mode =
                crate::config::LayoutMode::from(crate::config::Density::Compact);
            view.config.layout.sidebar_gap = 16.;
            view.select_settings_tab(Tab::General, window, cx);
        });
        window.draw(cx).clear(cx);
    });
    for selector in ["preferences-layout", "preferences-sidebar-gap"] {
        assert!(cx.debug_bounds(selector).is_some(), "{selector}");
    }
    assert!(cx.debug_bounds("sound-preview").is_none());
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.select_settings_tab(Tab::Sound, window, cx);
        });
        window.draw(cx).clear(cx);
    });
    assert!(cx.debug_bounds("sound-preview").is_some());
    assert!(cx.debug_bounds("preferences-layout").is_none());
    assert!(cx.debug_bounds("preferences-shared-path").is_none());
    assert!(cx.debug_bounds("preferences-reload-shared").is_none());
}

#[gpui::test]
#[allow(clippy::unwrap_used)]
fn followed_theme_updates_startup_cache_without_persisting_session_font_size(
    cx: &mut TestAppContext,
) {
    let (view, cx) = cx.add_window_view(crate::sidebar::layout_tests::fixture_window);
    let shared = Settings::parse_text("[theme]\nname = 'nord'").unwrap();
    let expected = shared.theme(false).unwrap();
    view.update(cx, |view, cx| {
        view.settings.shared = Some(shared);
        view.load_gui_config_with(
            || {
                Ok((
                    crate::config::Config {
                        theme: "Follow Herdr".into(),
                        ..Default::default()
                    },
                    Default::default(),
                ))
            },
            cx,
        );
    });
    cx.run_until_parked();
    view.read_with(cx, |view, cx| {
        assert_eq!(view.theme, expected);
        assert_eq!(cx.global::<crate::app::InitialAppearance>().theme, expected);
    });
    let shared = Settings::parse_text("[theme]\nname = 'dracula'").unwrap();
    let expected = shared.theme(false).unwrap();
    view.update(cx, |view, cx| {
        let saved_size = cx
            .global::<crate::app::InitialAppearance>()
            .config
            .terminal
            .size;
        view.config.terminal.size = 28.;
        view.settings.shared = Some(shared);
        view.apply_shared_theme(cx);
        let appearance = cx.global::<crate::app::InitialAppearance>();
        assert_eq!(appearance.theme, expected);
        assert_eq!(appearance.config.terminal.size, saved_size);
    });
}

#[gpui::test]
#[allow(clippy::unwrap_used)]
fn followed_theme_applies_contrast_to_a_fresh_palette(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(crate::sidebar::layout_tests::fixture_window);
    view.update(cx, |view, cx| {
        let shared = Settings::parse_text("[theme]\nname = 'nord'").unwrap();
        let light = matches!(
            cx.window_appearance(),
            WindowAppearance::Light | WindowAppearance::VibrantLight
        );
        let fresh = shared.theme(light).unwrap();
        view.settings.shared = Some(shared);
        view.config.theme = "Follow Herdr".into();
        for contrast in [
            crate::contrast::Contrast::High,
            crate::contrast::Contrast::High,
            crate::contrast::Contrast::Standard,
        ] {
            view.config.contrast = contrast;
            view.apply_shared_theme(cx);
            assert_eq!(view.theme, fresh.clone().with_contrast(contrast));
        }
    });
}

/// Herdr's `ui.agent_panel_sort` picks the order, also on a config reload,
/// until a toggle, now or stored from an earlier run, overrides it.
#[gpui::test]
#[allow(clippy::unwrap_used)]
fn the_daemon_sort_seeds_the_agents_panel_until_toggled(cx: &mut TestAppContext) {
    use crate::preferences::{AgentSort, Chrome};
    let (view, visual) = cx.add_window_view(crate::sidebar::layout_tests::fixture_window);
    let load = |cx: &mut VisualTestContext, sort: &'static str| {
        view.update(cx, |view, cx| {
            view.load_shared_settings_with(
                move || {
                    Ok(Settings::parse_text(&format!(
                        "[ui]\nagent_panel_sort = '{sort}'"
                    ))?)
                },
                cx,
            );
        });
        cx.run_until_parked();
        view.read_with(cx, |view, _| (view.agent_sort, view.agent_sort_modified))
    };
    assert_eq!(load(visual, "priority"), (AgentSort::Priority, false));
    // Stored chrome without a toggle leaves the daemon's choice alone.
    view.update(visual, |view, _| {
        view.apply_stored_chrome(Chrome::default())
    });
    assert_eq!(load(visual, "priority"), (AgentSort::Priority, false));
    assert_eq!(load(visual, "spaces"), (AgentSort::Grouped, false));
    assert_eq!(load(visual, "priority"), (AgentSort::Priority, false));
    // A toggle is the user's from then on; a reload no longer moves it.
    view.update(visual, |view, _| {
        view.agent_sort = view.agent_sort.toggled();
        view.agent_sort_modified = true;
    });
    assert_eq!(load(visual, "priority"), (AgentSort::Grouped, true));

    // A toggle stored by an earlier run wins whichever arrives first.
    let (view, cx) = cx.add_window_view(crate::sidebar::layout_tests::fixture_window);
    view.update(cx, |view, cx| {
        view.load_shared_settings_with(
            || Ok(Settings::parse_text("[ui]\nagent_panel_sort = 'priority'")?),
            cx,
        );
    });
    cx.run_until_parked();
    view.update(cx, |view, _| {
        view.apply_stored_chrome(Chrome {
            agent_sort: Some(AgentSort::Grouped),
            ..Chrome::default()
        });
        assert_eq!(view.agent_sort, AgentSort::Grouped);
        assert!(view.agent_sort_modified);
    });
}

#[gpui::test]
fn first_shared_load_honors_sidebar_start_collapsed_once(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(crate::sidebar::layout_tests::fixture_window);
    let load =
        || Settings::parse_text("[ui]\nsidebar_start_collapsed = true\n").map_err(Into::into);
    view.update(cx, |view, cx| view.load_shared_settings_with(load, cx));
    cx.run_until_parked();
    view.update(cx, |view, cx| {
        assert!(!view.sidebar_visible);
        view.toggle_sidebar();
        // A config reload is not a startup.
        view.load_shared_settings_with(load, cx);
    });
    cx.run_until_parked();
    view.read_with(cx, |view, _| assert!(view.sidebar_visible));
}

#[gpui::test]
fn failed_load_is_bounded_and_keeps_native_appearance(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(crate::sidebar::layout_tests::fixture_window);
    view.update(cx, |view, cx| {
        view.load_shared_settings_with(|| Err(crate::Error::MissingHome), cx);
        view.load_shared_settings_with(|| panic!("only one shared load at a time"), cx);
        assert!(view.settings.task.is_some());
        assert!(!view.settings.ready());
    });
    cx.run_until_parked();
    view.read_with(cx, |view, _| {
        assert!(view.settings.loaded);
        assert!(view.settings.task.is_none());
        assert!(view.settings.error.is_some());
        assert!(!view.settings.ready());
        assert!(view.settings.status.is_none());
        assert_eq!(view.config.theme, "Default");
    });
}

#[gpui::test]
fn native_edits_serialize_and_do_not_clear_shared_save_status(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(crate::sidebar::layout_tests::fixture_window);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.settings.status = Some("Saved to local file".into());
            view.settings.error = Some("shared conflict".into());
            view.save_native_settings_with(|| Err(crate::Error::MissingHome), cx);
            view.save_native_settings_with(|| panic!("second native write started"), cx);
            view.load_gui_config(cx);
            view.open_theme_picker(window, cx);
            assert!(view.native_settings_save_in_flight());
            assert!(view.config_load.is_none());
            assert!(view.menu.page != Some(crate::menu::Page::Themes));
        })
    });
    cx.run_until_parked();
    view.read_with(cx, |view, _| {
        assert!(!view.native_settings_save_in_flight());
        assert!(view.settings.native_error.is_some());
        assert_eq!(view.settings.status.as_deref(), Some("Saved to local file"));
        assert_eq!(view.settings.error.as_deref(), Some("shared conflict"));
    });
}

#[gpui::test]
fn shared_reload_keeps_saved_status(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(crate::sidebar::layout_tests::fixture_window);
    view.update(cx, |view, cx| {
        view.settings.status = Some("Saved to local file".into());
        view.settings.native_status = Some("GUI config saved and applied".into());
        view.load_shared_settings_with(|| Err(crate::Error::MissingHome), cx);
    });
    cx.run_until_parked();
    view.read_with(cx, |view, _| {
        assert_eq!(view.settings.status.as_deref(), Some("Saved to local file"));
        assert_eq!(
            view.settings.native_status.as_deref(),
            Some("GUI config saved and applied")
        );
    });
}

#[gpui::test]
fn font_tab_reads_loaded_config_without_separate_drafts(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(crate::sidebar::layout_tests::fixture_window);
    for reenter in [false, true] {
        cx.update(|window, cx| {
            view.update(cx, |view, cx| {
                if reenter {
                    view.select_settings_tab(Tab::Font, window, cx);
                    view.select_settings_tab(Tab::General, window, cx);
                }
                let mut config = view.config.clone();
                config.sidebar.family = if reenter {
                    "Saved Sidebar"
                } else {
                    "Loaded Sidebar"
                }
                .into();
                config.sidebar.size = if reenter { 23. } else { 19. };
                view.load_gui_config_with(move || Ok((config, Default::default())), cx);
                view.settings.native_reloading = reenter;
                // Completion cannot run until this UI update returns. No disk writes are needed.
                view.select_settings_tab(Tab::Font, window, cx);
                assert!(view.config_load.is_some());
            })
        });
        cx.run_until_parked();
        view.read_with(cx, |view, _| {
            assert!(!view.native_settings_save_in_flight());
            assert!(view.config_load.is_none());
            assert_eq!(
                view.config.sidebar.family,
                if reenter {
                    "Saved Sidebar"
                } else {
                    "Loaded Sidebar"
                }
            );
            assert_eq!(view.config.sidebar.size, if reenter { 23. } else { 19. });
        });
    }
}

#[gpui::test]
fn font_controls_are_only_on_font_tab(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(crate::sidebar::layout_tests::fixture_window);
    cx.simulate_resize(size(px(800.), px(600.)));
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.open_menu(window, cx);
            view.menu.page = Some(crate::menu::Page::Preferences);
        });
        window.draw(cx).clear(cx);
    });
    let Some(font_tab) = cx.debug_bounds("preferences-tab-Font") else {
        panic!("Font tab is missing");
    };
    cx.simulate_click(font_tab.center(), Modifiers::default());
    cx.update(|window, cx| window.draw(cx).clear(cx));
    view.read_with(cx, |view, _| assert_eq!(view.settings.tab, Tab::Font));
    for selector in [
        "preferences-font-all-choose",
        "preferences-font-sidebar-size",
        "preferences-font-sidebar-increase",
    ] {
        assert!(cx.debug_bounds(selector).is_some(), "{selector}");
    }
    assert!(cx.debug_bounds("preferences-shared-path").is_none());
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.select_settings_tab(Tab::General, window, cx)
        });
        window.draw(cx).clear(cx);
    });
    assert!(cx.debug_bounds("preferences-font-all-choose").is_none());
    assert!(cx.debug_bounds("preferences-high-contrast").is_some());
}

#[gpui::test]
fn native_theme_save_blocks_both_font_workflows(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(crate::sidebar::layout_tests::fixture_window);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.open_menu(window, cx);
            view.menu.page = Some(crate::menu::Page::Preferences);
            view.select_settings_tab(Tab::Font, window, cx);
            view.settings.native_reloading = true;
            let original = view.config.sidebar.size;
            view.set_font_size(crate::config::FontFace::Sidebar, original + 1., cx);
            view.open_font_picker(crate::font_picker::FontTarget::All, window, cx);
            assert_eq!(view.config.sidebar.size, original);
            assert!(!view.font_size_saves.is_busy());
            assert_eq!(view.menu.page, Some(crate::menu::Page::Preferences));
        });
    });
}

mod appearance_report;
mod system_theme;
mod theme_reload;
