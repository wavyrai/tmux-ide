//! The in-app menu's font size rows, and the baseline a config load moves.
//! These live beside the menu because they reach its own items and dispatch.

#![allow(clippy::unwrap_used)]

use gpui::{Modifiers, point, px};

use crate::{
    config::{Config, FONT_SIZE_STEP},
    settings_panel::Tab,
    sidebar::layout_tests::fixture_window,
};

/// On Linux GPUI attaches no OS menu bar, so these rows are the only menu that
/// reaches the font size commands there.
#[gpui::test]
fn the_in_app_menu_applies_a_size_and_dismisses(cx: &mut gpui::TestAppContext) {
    let (view, cx) = cx.add_window_view(fixture_window);
    let start = view.read_with(cx, |view, _| view.config.terminal.size);

    view.read_with(cx, |view, _| {
        let items = view.menu_items();
        for item in [
            "increase font size",
            "decrease font size",
            "reset font size",
        ] {
            assert!(items.contains(&item), "{item} missing from {items:?}");
        }
        // Other tests locate these two rows by selector; keep their places.
        assert_eq!(items[0], "settings");
        assert_eq!(items[1], "shortcuts");
    });

    for (item, expected) in [
        ("increase font size", start + FONT_SIZE_STEP),
        ("decrease font size", start),
        ("reset font size", start),
    ] {
        cx.update(|window, cx| {
            view.update(cx, |view, cx| {
                view.open_menu(window, cx);
                view.activate_menu(item, window, cx);
            })
        });
        view.read_with(cx, |view, _| {
            assert_eq!(view.config.terminal.size, expected, "{item}");
            assert!(view.menu.page.is_none(), "{item} left the menu open");
        });
    }
}

#[gpui::test]
fn clicking_font_size_rows_changes_size(cx: &mut gpui::TestAppContext) {
    let (view, cx) = cx.add_window_view(fixture_window);
    let start = view.read_with(cx, |view, _| view.config.terminal.size);
    for (item, expected) in [
        ("menu-increase font size", start + FONT_SIZE_STEP),
        ("menu-decrease font size", start),
        ("menu-reset font size", start),
    ] {
        cx.update(|window, cx| {
            view.update(cx, |view, cx| {
                view.open_menu(window, cx);
                view.menu.anchor = point(px(56.), px(480.));
            });
            window.draw(cx).clear(cx);
        });
        let bounds = cx.debug_bounds(item).unwrap();
        cx.simulate_click(bounds.center(), Modifiers::default());
        view.read_with(cx, |view, _| {
            assert_eq!(view.config.terminal.size, expected, "{item}: {bounds:?}");
            assert!(view.menu.page.is_none(), "{item} did not dismiss the menu");
        });
    }
}

#[gpui::test]
fn preferences_render_font_size_controls(cx: &mut gpui::TestAppContext) {
    let (view, cx) = cx.add_window_view(fixture_window);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.open_preferences_fixture(window, cx);
            view.select_settings_tab(Tab::Font, window, cx);
        });
        window.draw(cx).clear(cx);
    });
    for selector in [
        "preferences-font-sidebar-decrease",
        "preferences-font-sidebar-increase",
        "preferences-font-tabs-decrease",
        "preferences-font-tabs-increase",
        "preferences-font-terminal-decrease",
        "preferences-font-terminal-increase",
        "preferences-font-ui-decrease",
        "preferences-font-ui-increase",
    ] {
        assert!(cx.debug_bounds(selector).is_some(), "missing {selector}");
    }
}

#[gpui::test]
fn editable_font_size_cancels_on_escape_and_rejects_invalid_input(cx: &mut gpui::TestAppContext) {
    let (view, cx) = cx.add_window_view(fixture_window);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.open_preferences_fixture(window, cx);
            view.select_settings_tab(Tab::Font, window, cx);
        });
        window.draw(cx).clear(cx);
    });
    let size = cx.debug_bounds("preferences-font-sidebar-size").unwrap();
    cx.simulate_click(size.center(), Modifiers::default());
    view.update(cx, |view, cx| {
        let editor = view.menu.font_size_editor.as_ref().unwrap();
        editor
            .input
            .update(cx, |input, cx| input.set_text_selected("49", cx));
    });
    cx.simulate_keystrokes("enter");
    view.read_with(cx, |view, _| {
        assert!(view.menu.font_size_editor.is_none());
        assert!(view.config_load.is_none());
        assert_eq!(view.config.sidebar.size, 12.);
    });
    cx.update(|window, cx| window.draw(cx).clear(cx));
    let size = cx.debug_bounds("preferences-font-sidebar-size").unwrap();
    cx.simulate_click(size.center(), Modifiers::default());
    cx.simulate_keystrokes("escape");
    view.read_with(cx, |view, _| {
        assert!(view.menu.font_size_editor.is_none());
        assert!(view.config_load.is_none());
        assert_eq!(view.menu.page, Some(super::Page::Preferences));
    });
    cx.update(|window, cx| window.draw(cx).clear(cx));
    let size = cx.debug_bounds("preferences-font-sidebar-size").unwrap();
    cx.simulate_click(size.center(), Modifiers::default());
    view.update(cx, |view, cx| {
        let editor = view.menu.font_size_editor.as_ref().unwrap();
        editor
            .input
            .update(cx, |input, cx| input.set_text_selected("not a size", cx));
    });
    let label = cx.debug_bounds("preferences-font-sidebar").unwrap();
    cx.simulate_click(
        point(label.left() + px(15.), label.center().y),
        Modifiers::default(),
    );
    view.read_with(cx, |view, _| {
        assert!(view.menu.font_size_editor.is_none());
        assert!(view.config_load.is_none());
        assert_eq!(view.config.sidebar.size, 12.);
    });
}

#[gpui::test]
fn leaving_font_size_field_restores_menu_keyboard_focus(cx: &mut gpui::TestAppContext) {
    let (view, cx) = cx.add_window_view(fixture_window);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.open_preferences_fixture(window, cx);
            view.select_settings_tab(Tab::Font, window, cx);
        });
        window.draw(cx).clear(cx);
    });
    let size = cx.debug_bounds("preferences-font-sidebar-size").unwrap();
    cx.simulate_click(size.center(), Modifiers::default());
    view.read_with(cx, |view, _| {
        assert!(view.menu.font_size_editor.is_some());
    });
    cx.update(|window, cx| window.draw(cx).clear(cx));
    let label = cx.debug_bounds("preferences-font-sidebar").unwrap();
    cx.simulate_click(
        point(label.left() + px(15.), label.center().y),
        Modifiers::default(),
    );
    cx.update(|window, cx| window.draw(cx).clear(cx));
    view.read_with(cx, |view, _| {
        assert!(view.menu.font_size_editor.is_none());
        assert!(view.config_load.is_none());
        assert_eq!(view.menu.page, Some(super::Page::Preferences));
    });
    cx.simulate_keystrokes("escape");
    view.read_with(cx, |view, _| {
        assert!(
            view.menu.page.is_none(),
            "Escape should dismiss Preferences"
        );
    });
}

#[gpui::test]
fn a_font_at_the_limit_cannot_be_increased_or_start_a_save(cx: &mut gpui::TestAppContext) {
    let (view, cx) = cx.add_window_view(fixture_window);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.config.sidebar.size = *crate::config::FONT_SIZE_RANGE.end();
            view.open_preferences_fixture(window, cx);
            view.select_settings_tab(Tab::Font, window, cx);
        });
        window.draw(cx).clear(cx);
    });
    let button = cx
        .debug_bounds("preferences-font-sidebar-increase")
        .unwrap();
    cx.simulate_click(button.center(), Modifiers::default());
    view.read_with(cx, |view, _| {
        assert_eq!(
            view.config.sidebar.size,
            *crate::config::FONT_SIZE_RANGE.end()
        );
        assert!(view.config_load.is_none());
        assert!(!view.font_size_saves.is_busy());
        assert_eq!(view.menu.page, Some(super::Page::Preferences));
    });
}

#[gpui::test]
fn a_reload_moves_the_baseline_and_discards_a_session_size(cx: &mut gpui::TestAppContext) {
    let (view, cx) = cx.add_window_view(fixture_window);
    let start = view.read_with(cx, |view, _| view.config.terminal.size);
    let configured = start + 5.0;
    let load = move || {
        let mut config = Config::default();
        config.terminal.size = configured;
        let theme = config.theme(false)?;
        Ok((config, theme))
    };

    view.update(cx, |view, cx| view.load_gui_config_with(load, cx));
    cx.run_until_parked();
    view.read_with(cx, |view, _| {
        assert_eq!(view.configured_terminal_size, configured);
        assert_eq!(view.config.terminal.size, configured);
    });

    // Reset now follows the file, not the size the window started with.
    view.update(cx, |view, cx| {
        view.set_terminal_font_size(view.config.terminal.size - FONT_SIZE_STEP, cx);
        view.set_terminal_font_size(view.configured_terminal_size, cx);
        assert_eq!(view.config.terminal.size, configured);
        // A session size is never written back, so a reload drops it.
        view.set_terminal_font_size(view.config.terminal.size + FONT_SIZE_STEP, cx);
        view.load_gui_config_with(load, cx);
    });
    cx.run_until_parked();
    view.read_with(cx, |view, _| {
        assert_eq!(view.config.terminal.size, configured);
    });
}
