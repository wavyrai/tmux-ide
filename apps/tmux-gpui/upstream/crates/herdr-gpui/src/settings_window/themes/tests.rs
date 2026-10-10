#![allow(clippy::unwrap_used)]
use super::*;
use core::prelude::v1::test;

mod scrolling;

#[test]
fn shared_scope_editability_matches_platform_support() {
    assert!(Scope::App.editable());
    assert_eq!(Scope::Herdr.editable(), cfg!(unix));
}

pub(super) fn fixture(window: &mut Window, cx: &mut Context<SettingsWindow>) -> SettingsWindow {
    let source = cx.new(|cx| crate::sidebar::layout_tests::fixture_window(window, cx));
    let mut view = SettingsWindow::new(source.downgrade(), cx);
    view.themes.names = (0..400)
        .map(|index| format!("Catalog {index:03}"))
        .collect();
    view.themes.filter(None);
    // Hold the worker slot so these tests never discover or read personal files.
    view.themes.running = Some(0);
    view.themes.grid.running = true;
    view.theme_loading = true;
    view.theme_io = Some(ThemeIo {
        write: std::sync::Arc::new(|_, _| Ok(())),
        load: std::sync::Arc::new(|| Ok(super::super::tests::fixture())),
        resolve: None,
    });
    view
}

#[test]
fn full_catalog_and_unicode_tokens_are_not_capped() {
    let names: Vec<_> = (0..400)
        .map(|index| format!("Catalog {index:03}"))
        .collect();
    assert_eq!(
        filter_names(names.iter().map(String::as_str), "").len(),
        400
    );
    assert_eq!(
        filter_names(names.iter().map(String::as_str), "399 CATALOG"),
        ["Catalog 399"]
    );
    assert_eq!(
        filter_names(["Été 東京 Night", "Other"], "東京 ÉTÉ"),
        ["Été 東京 Night"]
    );
    assert!(filter_names(["Nord"], "not found").is_empty());
}

#[gpui::test]
fn source_chips_preserve_search_identity_and_draft_without_writing(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(fixture);
    view.update(cx, |view, cx| {
        assert!(view.themes.ghostty_enabled && view.themes.herdr_enabled);
        assert_eq!(
            view.themes.filtered.len(),
            400 + herdr_settings::THEME_NAMES.len()
        );
        view.themes.names = vec!["Nord".into(), "Nord Light".into(), "/native/file".into()];
        view.themes
            .search
            .update(cx, |search, cx| search.set_text_selected("nord", cx));
    });
    cx.run_until_parked();
    view.update(cx, |view, cx| {
        assert_eq!(
            view.themes.filtered,
            [
                Choice {
                    scope: Scope::App,
                    name: "Nord".into()
                },
                Choice {
                    scope: Scope::Herdr,
                    name: "nord".into()
                },
                Choice {
                    scope: Scope::App,
                    name: "Nord Light".into()
                },
            ]
        );
        view.select_settings_theme(0, cx);
    });
    let (intent, theme, config_theme, revision) = view.read_with(cx, |view, _| {
        (
            view.theme_intent.as_ref().unwrap().choice.clone(),
            view.theme.clone(),
            view.config.theme.clone(),
            view.theme_revision,
        )
    });
    // Each click is an independent toggle, including the all-disabled state.
    for (id, ghostty, herdr, selected) in [
        ("theme-scope-herdr", true, false, Some(Scope::App)),
        ("theme-scope-herdr", true, true, Some(Scope::App)),
        ("theme-scope-app", false, true, Some(Scope::Herdr)),
        ("theme-scope-app", true, true, Some(Scope::Herdr)),
        ("theme-scope-herdr", true, false, Some(Scope::App)),
        ("theme-scope-app", false, false, None),
        ("theme-scope-herdr", false, true, Some(Scope::Herdr)),
    ] {
        cx.update(|window, cx| window.draw(cx).clear(cx));
        let bounds = cx.debug_bounds(id).unwrap();
        cx.simulate_click(bounds.center(), Modifiers::default());
        cx.update(|window, cx| window.draw(cx).clear(cx));
        view.read_with(cx, |view, cx| {
            assert_eq!(view.themes.ghostty_enabled, ghostty);
            assert_eq!(view.themes.herdr_enabled, herdr);
            assert_eq!(view.themes.choice().map(|choice| choice.scope), selected);
            assert_eq!(view.themes.query, "nord");
            assert_eq!(view.themes.search.read(cx).text(), "nord");
            assert_eq!(view.theme_intent.as_ref().unwrap().choice, intent);
            assert_eq!(view.theme_revision, revision);
            assert_eq!(view.theme, theme);
            assert_eq!(view.config.theme, config_theme);
            assert!(!view.saving && !view.theme_saving);
            if selected.is_none() {
                assert!(view.themes.filtered.is_empty());
            }
        });
        assert!(cx.debug_bounds("theme-scope-app").is_some());
        assert!(cx.debug_bounds("theme-scope-herdr").is_some());
        if selected.is_none() {
            assert!(cx.debug_bounds("settings-theme-empty").is_some());
        }
    }
}

#[gpui::test]
fn combined_cards_save_only_on_close_to_their_own_destination(cx: &mut TestAppContext) {
    use std::sync::{Arc, Mutex};
    for scope in [Scope::App, Scope::Herdr] {
        let writes = Arc::new(Mutex::new(Vec::new()));
        let recorded = writes.clone();
        let (view, visual) = cx.add_window_view(fixture);
        visual.update(|window, cx| {
            view.update(cx, |view, cx| {
                view.shared = herdr_settings::Settings::parse_text("").ok();
                view.theme_loading = false;
                view.theme_io.as_mut().unwrap().write = Arc::new(move |name, shared| {
                    recorded.lock().unwrap().push((name, shared.is_some()));
                    Ok(())
                });
                view.themes.names = vec!["Nord".into()];
                view.themes.query = "nord".into();
                view.themes.filter(None);
                let index = view
                    .themes
                    .filtered
                    .iter()
                    .position(|choice| choice.scope == scope)
                    .unwrap();
                view.select_settings_theme(index, cx);
                if !scope.editable() {
                    assert!(!view.theme_dirty());
                    return;
                }
                assert_eq!(view.theme_intent.as_ref().unwrap().choice.scope, scope);
                view.toggle_theme_source(scope, cx);
                assert!(writes.lock().unwrap().is_empty());
                assert!(!view.should_close(window, cx));
            });
        });
        visual.run_until_parked();
        let expected = if scope.editable() {
            vec![(
                if scope == Scope::App { "Nord" } else { "nord" }.to_owned(),
                scope == Scope::Herdr,
            )]
        } else {
            Vec::new()
        };
        assert_eq!(*writes.lock().unwrap(), expected);
    }
}

#[gpui::test]
fn selection_filter_and_contrast_fence_old_preview(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(fixture);
    view.update(cx, |view, cx| {
        let original = view.theme.clone();
        view.themes.preview = Some(original.clone());
        let index = view
            .themes
            .filtered
            .iter()
            .position(|choice| choice.name == "Catalog 399")
            .unwrap();
        view.select_settings_theme(index, cx);
        assert_eq!(view.themes.choice().unwrap().name, "Catalog 399");
        assert_eq!(view.themes.running, Some(0));
        view.themes.query = "398 catalog".into();
        view.themes.filter(None);
        view.request_theme_preview(cx);
        view.themes.contrast = Contrast::High;
        view.request_theme_preview(cx);
        view.themes
            .finish_preview(0, "obsolete".into(), Ok(Theme::builtin("Nord").unwrap()));
        assert_eq!(view.themes.preview.as_ref(), Some(&original));
        assert_eq!(view.themes.loaded, None);
        assert_eq!(view.themes.choice().unwrap().name, "Catalog 398");
        let revision = view.themes.revision;
        view.themes.running = Some(revision);
        view.themes.finish_preview(
            revision,
            "Catalog 398".into(),
            Err(crate::Error::MissingHome),
        );
        assert!(view.themes.preview_error.is_some());
        assert_eq!(view.themes.preview.as_ref(), Some(&original));
        assert_eq!(view.theme, original);
        view.themes.query = "no matches".into();
        view.themes.filter(None);
        view.request_theme_preview(cx);
        assert!(view.themes.choice().is_none());
        assert!(view.themes.running.is_none());
    });
}

#[gpui::test]
fn reload_preserves_query_choice_and_fences_contrast(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(fixture);
    view.update(cx, |view, cx| {
        view.themes
            .search
            .update(cx, |search, cx| search.set_text_selected("catalog 39", cx));
    });
    cx.run_until_parked();
    view.update(cx, |view, cx| {
        view.select_settings_theme(8, cx);
        let choice = view.themes.choice();
        let revision = view.themes.revision;
        view.config.theme = "/custom/explicit-theme".into();
        view.config.contrast = Contrast::High;
        view.sync_theme_browser(cx);
        assert_eq!(view.themes.choice(), choice);
        assert_eq!(view.themes.query, "catalog 39");
        assert_eq!(view.themes.search.read(cx).text(), "catalog 39");
        assert_eq!(view.themes.contrast, Contrast::High);
        assert!(view.themes.names.contains(&view.config.theme));
        assert!(view.themes.revision > revision);
        assert_eq!(view.themes.running, Some(0));
        assert!(view.themes.loaded.is_none());
    });
}

#[gpui::test]
fn scope_switch_cannot_accept_native_preview_for_shared_choice(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(fixture);
    view.update(cx, |view, cx| {
        view.shared = Some(
            herdr_settings::Settings::parse_text("[theme.custom]\naccent='#123456'\n").unwrap(),
        );
        view.themes.ghostty_enabled = false;
        view.themes.query = "nord".into();
        view.themes.filter(None);
        view.request_theme_preview(cx);
        view.themes
            .finish_preview(0, "Nord".into(), Ok(Theme::builtin("Nord").unwrap()));
        assert!(view.themes.preview.is_none());
        view.drive_theme_preview(cx);
        let running = view.themes.running;
        view.themes
            .finish_preview(0, "foreign completion".into(), Ok(Theme::default()));
        assert_eq!(view.themes.running, running);
    });
    cx.run_until_parked();
    view.read_with(cx, |view, _| {
        assert_eq!(view.themes.preview_name.as_deref(), Some("nord"));
        assert_eq!(view.themes.preview.as_ref().unwrap().primary(), 0x123456);
        assert_eq!(view.themes.loaded, Some(view.themes.revision));
        assert_eq!(view.themes.choice().unwrap().scope, Scope::Herdr);
    });
}

#[gpui::test]
fn row_click_and_keyboard_accept_intent_while_validation_is_held(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(fixture);
    view.update(cx, |view, _| {
        view.themes.herdr_enabled = false;
        view.themes.filter(None);
    });
    cx.simulate_resize(size(px(960.), px(1000.)));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    let row = cx.debug_bounds("settings-theme-row-1").unwrap();
    cx.simulate_click(row.center(), Modifiers::default());
    cx.update(|window, cx| {
        view.read_with(cx, |view, cx| {
            assert!(view.themes.search.read(cx).focus.is_focused(window));
            assert_eq!(view.themes.selected, Some(1));
        })
    });
    cx.simulate_keystrokes("down enter");
    view.read_with(cx, |view, _| {
        assert_eq!(view.themes.selected, Some(5));
        assert!(!view.saving);
        assert_eq!(view.config.theme, Config::default().theme);
        assert_eq!(
            view.theme_intent.as_ref().unwrap().choice.name,
            "Catalog 005"
        );
    });
    cx.simulate_keystrokes("escape");
    assert!(cx.debug_bounds("settings-theme-search").is_some());
}

#[gpui::test]
fn worker_loads_only_latest_search_preview_without_applying_it(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(fixture);
    view.update(cx, |view, cx| {
        view.themes.names = vec!["Nord".into(), "Dracula".into()];
        view.themes.herdr_enabled = false;
        view.themes.filter(None);
        view.themes.selected = Some(0);
        view.request_theme_preview(cx);
        view.themes.selected = Some(1);
        view.request_theme_preview(cx);
        assert_eq!(view.themes.running, Some(0));
        view.themes
            .finish_preview(0, "old".into(), Err(crate::Error::MissingHome));
        view.drive_theme_preview(cx);
        assert_eq!(view.themes.running, Some(view.themes.revision));
    });
    cx.run_until_parked();
    view.read_with(cx, |view, _| {
        assert_eq!(view.themes.preview_name.as_deref(), Some("Nord"));
        assert_eq!(view.themes.preview, Theme::builtin("Nord"));
        assert_eq!(view.themes.loaded, Some(view.themes.revision));
        assert!(view.themes.running.is_none());
        assert_eq!(view.config.theme, Config::default().theme);
        assert_eq!(view.theme, Theme::default());
    });
}

#[gpui::test]
fn normal_window_keeps_preview_search_list_and_actions_visible(cx: &mut TestAppContext) {
    let (_, cx) = cx.add_window_view(fixture);
    cx.simulate_resize(size(px(960.), px(780.)));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    let preview = cx.debug_bounds("settings-theme-preview").unwrap();
    let search = cx.debug_bounds("settings-theme-search").unwrap();
    let list = cx.debug_bounds("settings-theme-list").unwrap();
    let actions = cx.debug_bounds("settings-theme-actions").unwrap();
    assert_eq!(preview.size.height, px(225.));
    assert_eq!(search.size.height, px(32.));
    assert_eq!(list.size.height, px(LIST_HEIGHT));
    assert!(preview.bottom() <= search.top());
    assert!(search.bottom() <= list.top());
    assert!(list.bottom() <= actions.top());
    assert!(actions.bottom() <= px(780.), "actions: {actions:?}");
    let follow = cx.debug_bounds("theme-follow").unwrap();
    let contrast = cx.debug_bounds("theme-contrast").unwrap();
    assert_eq!(
        follow.center().y,
        contrast.center().y,
        "actions share a midline"
    );
    assert!(
        follow.size.height < contrast.size.height,
        "the button keeps its own height"
    );
}

#[gpui::test]
fn list_materializes_only_visible_rows_and_scrolls_to_last(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(fixture);
    cx.simulate_resize(size(px(960.), px(1000.)));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    assert!(cx.debug_bounds("settings-theme-row-0").is_some());
    assert!(cx.debug_bounds("settings-theme-row-399").is_none());
    view.update(cx, |view, cx| view.select_settings_theme(399, cx));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    assert!(cx.debug_bounds("settings-theme-row-399").is_some());
    assert!(cx.debug_bounds("settings-theme-row-0").is_none());
    let visible = (0..400)
        .filter(|index| {
            cx.debug_bounds(Box::leak(
                format!("settings-theme-row-{index}").into_boxed_str(),
            ))
            .is_some()
        })
        .count();
    assert!(
        visible <= ((LIST_HEIGHT / ROW_HEIGHT).ceil() as usize + 2) * 4,
        "{visible} materialized rows"
    );
    cx.simulate_resize(size(px(680.), px(1000.)));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    assert!(cx.debug_bounds("settings-theme-row-399").is_some());
    view.read_with(cx, |view, _| assert_eq!(view.themes.grid.columns, 2));
    view.update(cx, |view, cx| {
        view.themes.query = "399".into();
        view.themes.filter(None);
        view.request_theme_preview(cx);
    });
    cx.update(|window, cx| window.draw(cx).clear(cx));
    assert!(cx.debug_bounds("settings-theme-row-0").is_some());
    view.read_with(cx, |view, _| {
        assert_eq!(
            view.themes.filtered,
            [Choice {
                scope: Scope::App,
                name: "Catalog 399".into()
            }]
        )
    });
}

#[gpui::test]
fn composition_navigation_and_escape_remain_in_search(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(fixture);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.themes.names = vec!["東京 Night".into(), "東京 Day".into()];
            view.themes.search.update(cx, |search, cx| {
                search.replace_and_mark_text_in_range(None, "東京", Some(2..2), window, cx);
            });
        })
    });
    cx.run_until_parked();
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            assert_eq!(view.themes.filtered.len(), 2);
            let revision = view.themes.revision;
            for key in ["up", "down", "enter", "escape"] {
                view.theme_browser_key(
                    &KeyDownEvent {
                        keystroke: Keystroke::parse(key).unwrap(),
                        is_held: false,
                        prefer_character_input: false,
                    },
                    window,
                    cx,
                );
            }
            assert_eq!(view.themes.revision, revision);
            assert_eq!(view.themes.search.read(cx).text(), "東京");
            view.themes
                .search
                .update(cx, |search, cx| search.unmark_text(window, cx));
            view.theme_browser_key(
                &KeyDownEvent {
                    keystroke: Keystroke::parse("escape").unwrap(),
                    is_held: false,
                    prefer_character_input: false,
                },
                window,
                cx,
            );
            assert_eq!(view.themes.search.read(cx).text(), "");
        })
    });
}

#[test]
fn shared_preview_preserves_overrides_and_never_mutates_settings() {
    let settings = herdr_settings::Settings::parse_text("[theme]\nname='nord'\nauto_switch=true\nlight_name='one-light'\n[theme.custom]\naccent='#123456'\n").unwrap();
    let before = settings.theme(true).unwrap();
    for name in herdr_settings::THEME_NAMES {
        let preview = settings.preview_theme(name, true).unwrap();
        assert_eq!(preview.primary(), 0x123456);
    }
    assert!(
        settings
            .preview_theme("Ghostty external theme", false)
            .is_err()
    );
    assert_eq!(settings.theme_name, "nord");
    assert_eq!(settings.theme(true).unwrap(), before);
    let plain =
        herdr_settings::Settings::parse_text("[theme]\nauto_switch=true\nlight_name='one-light'\n")
            .unwrap();
    let expected = herdr_settings::Settings::parse_text("[theme]\nname='nord'\n").unwrap();
    assert_eq!(
        plain.preview_theme("nord", true).unwrap(),
        expected.theme(true).unwrap()
    );
}

mod system;
