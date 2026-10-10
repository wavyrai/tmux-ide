#![allow(clippy::unwrap_used)]
use super::*;
use core::prelude::v1::test;

#[gpui::test]
fn saving_blocks_cancel_replacement_and_reload_until_reconciled(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(crate::sidebar::layout_tests::fixture_window);
    cx.simulate_resize(size(px(800.), px(600.)));
    for success in [true, false] {
        let token = cx.update(|window, cx| {
            view.update(cx, |view, cx| {
                view.config.theme = "Default".into();
                view.theme = Theme::default();
                view.open_theme_picker(window, cx);
                let picker = view.menu.themes.as_mut().unwrap();
                picker.filtered = vec!["Nord".into()];
                picker.selected = 0;
                view.preview_picker_selection(cx);
                let picker = view.menu.themes.as_mut().unwrap();
                let token = (picker.session, picker.request);
                // Hold completion at the disk-write boundary without touching personal config.
                picker.accepting = true;
                picker.saving = true;
                picker.in_flight = Some(token);
                token
            })
        });
        cx.update(|window, cx| window.draw(cx).clear(cx));
        cx.simulate_keystrokes("escape");
        let close = cx.debug_bounds("theme-close").unwrap();
        cx.simulate_click(close.center(), Modifiers::default());
        let avatar = cx.debug_bounds("titlebar-avatar").unwrap();
        cx.simulate_click(avatar.center(), Modifiers::default());
        cx.simulate_mouse_down(
            point(px(5.), px(5.)),
            MouseButton::Left,
            Modifiers::default(),
        );
        cx.update(|window, cx| {
            view.update(cx, |view, cx| {
                assert!(!view.open_menu(window, cx));
                view.open_preferences_fixture(window, cx);
                view.open_keybinds(window, cx);
                view.open_theme_picker(window, cx);
                view.open_palette(crate::palette::Filter::All, window, cx);
                view.show_install_modal(window, cx);
                view.open_app_update(false, window, cx);
                view.open_app_update(true, window, cx);
                assert!(view.update_preview.is_none());
                let snapshot: herdr_client::protocol::ClientShellSnapshot =
                    serde_json::from_str(include_str!(
                        "../../../herdr-protocol/tests/fixtures/endpoint-snapshot-v1.json"
                    ))
                    .unwrap();
                let tab = snapshot.tabs[0].tab_id.clone();
                view.live.snapshot = Some(std::sync::Arc::new(snapshot));
                view.open_tab_menu(&tab, None, Point::default(), window, cx);
                view.open_tab_close(&tab, window, cx);
                view.open_close_confirmation(crate::controls::Command::CloseTab, window, cx);
                view.reload_gui_config(window, cx);
                assert!(view.menu.page == Some(Page::Themes));
                assert_eq!(view.theme, Theme::builtin("Nord").unwrap());
                assert_eq!(view.config.theme, "Default");
                let picker = view.menu.themes.as_ref().unwrap();
                assert_eq!((picker.session, picker.request), token);
                assert!(picker.saving);
                let result = if success {
                    Ok(Theme::builtin("Nord").unwrap())
                } else {
                    Err(crate::Error::MissingHome)
                };
                view.finish_picker_load(token, true, result, window, cx);
                assert!(!view.theme_save_in_flight());
                if success {
                    assert_eq!(view.config.theme, "Nord");
                    assert_eq!(view.theme, Theme::builtin("Nord").unwrap());
                    assert!(view.menu.page.is_none());
                } else {
                    assert!(view.menu.page == Some(Page::Themes));
                    assert!(view.menu.themes.as_ref().unwrap().error.is_some());
                    view.dismiss_menu(window, cx);
                    assert_eq!(view.theme, Theme::default());
                    assert_eq!(view.config.theme, "Default");
                }
            })
        });
    }
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.open_theme_picker(window, cx);
            let picker = view.menu.themes.as_mut().unwrap();
            let token = (picker.session, picker.request);
            picker.in_flight = Some(token);
            picker.filtered = vec!["/pending-theme".into()];
            picker.selected = 0;
            view.apply_picker_theme("/pending-theme", cx);
            assert!(!view.theme_save_in_flight());
            view.dismiss_menu(window, cx);
            view.finish_picker_load(
                token,
                false,
                Ok(Theme::builtin("Nord").unwrap()),
                window,
                cx,
            );
            assert!(view.menu.page.is_none());
            assert_eq!(view.theme, Theme::default());
            assert_eq!(view.config.theme, "Default");
            assert!(view.menu.themes.as_ref().unwrap().in_flight.is_none());
        })
    });
}

#[gpui::test]
fn status_changes_do_not_move_rows_under_pointer(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(crate::sidebar::layout_tests::fixture_window);
    cx.update(|window, cx| view.update(cx, |view, cx| view.open_theme_picker(window, cx)));
    cx.run_until_parked();
    for width in [800., 360.] {
        cx.simulate_resize(size(px(width), px(600.)));
        cx.update(|window, cx| window.draw(cx).clear(cx));
        let row = cx.debug_bounds("theme-row-1").unwrap();
        let status = cx.debug_bounds("theme-status").unwrap();
        // Selection paints as a row: the fill spans the list, not the label.
        assert_eq!(row.size.width, status.size.width);
        assert_eq!(row.left(), status.left());
        cx.simulate_mouse_move(row.center(), None, Modifiers::default());
        for (error, accepting, saving) in [
            (
                Some("Very long theme load failure: ".repeat(40)),
                false,
                false,
            ),
            (None, true, false),
            (None, true, true),
            (None, false, false),
        ] {
            cx.update(|window, cx| {
                view.update(cx, |view, cx| {
                    let picker = view.menu.themes.as_mut().unwrap();
                    picker.error = error;
                    picker.accepting = accepting;
                    picker.saving = saving;
                    cx.notify();
                });
                window.draw(cx).clear(cx);
            });
            assert_eq!(cx.debug_bounds("theme-row-1").unwrap(), row);
            assert_eq!(cx.debug_bounds("theme-status").unwrap(), status);
            view.read_with(cx, |view, _| {
                assert_eq!(view.menu.themes.as_ref().unwrap().selected, 1)
            });
        }
    }
}

#[gpui::test]
fn searched_picker_reopens_on_nonfirst_configured_theme(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(crate::sidebar::layout_tests::fixture_window);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.config.theme = "Nord".into();
            view.theme = Theme::builtin("Nord").unwrap();
            view.open_theme_picker(window, cx);
        })
    });
    cx.run_until_parked();
    cx.simulate_input("Dracula");
    cx.run_until_parked();
    cx.simulate_keystrokes("escape");
    cx.update(|window, cx| view.update(cx, |view, cx| view.open_theme_picker(window, cx)));
    // Drain the programmatic clear's Changed event and discovery completion.
    cx.run_until_parked();
    view.read_with(cx, |view, cx| {
        let picker = view.menu.themes.as_ref().unwrap();
        assert!(picker.search.read(cx).text().is_empty());
        assert!(picker.query.is_empty());
        assert!(picker.selected > 0);
        assert_eq!(picker.filtered[picker.selected], "Nord");
        assert_eq!(view.theme, Theme::builtin("Nord").unwrap());
        assert_eq!(view.config.theme, "Nord");
        assert!(picker.desired.is_none());
    });
}

#[gpui::test]
fn discovery_is_single_flight_across_reopens_and_ignores_old_errors(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(crate::sidebar::layout_tests::fixture_window);
    cx.update(|window, cx| view.update(cx, |view, cx| view.open_theme_picker(window, cx)));
    cx.run_until_parked();
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            let picker = view.menu.themes.as_mut().unwrap();
            let session = picker.session;
            picker.discovering = true;
            for _ in 0..30 {
                view.dismiss_menu(window, cx);
                view.open_theme_picker(window, cx);
                assert!(view.menu.themes.as_ref().unwrap().discovering);
            }
            view.finish_picker_discovery(
                session,
                Ok(vec!["Default".into(), "scan-result".into()]),
                cx,
            );
        })
    });
    cx.run_until_parked();
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            let picker = view.menu.themes.as_mut().unwrap();
            assert!(!picker.discovering);
            assert_eq!(picker.names, ["Default", "scan-result"]);
            let session = picker.session;
            picker.discovering = true;
            view.dismiss_menu(window, cx);
            view.open_theme_picker(window, cx);
            view.finish_picker_discovery(session, Err(crate::Error::MissingHome), cx);
            let picker = view.menu.themes.as_ref().unwrap();
            assert!(!picker.discovering);
            assert!(picker.error.is_none());
        })
    });
}

#[gpui::test]
fn hover_keys_search_preview_and_dismiss_restore_original(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(crate::sidebar::layout_tests::fixture_window);
    cx.simulate_resize(size(px(800.), px(600.)));
    cx.update(|window, cx| view.update(cx, |view, cx| view.open_theme_picker(window, cx)));
    cx.run_until_parked();
    cx.update(|window, cx| {
        view.update(cx, |view, _| {
            let picker = view.menu.themes.as_mut().unwrap();
            picker.names = vec!["Default".into(), "Nord".into(), "Dracula".into()];
            picker.filter("");
        });
        window.draw(cx).clear(cx);
    });
    let row = cx.debug_bounds("theme-row-1").unwrap();
    cx.simulate_mouse_move(row.center(), None, Modifiers::default());
    view.read_with(cx, |view, _| {
        assert_eq!(view.theme, Theme::builtin("Nord").unwrap());
        assert_eq!(view.config.theme, "Default");
        assert_eq!(view.menu.themes.as_ref().unwrap().selected, 1);
    });
    cx.simulate_keystrokes("down");
    view.read_with(cx, |view, _| {
        assert_eq!(view.theme, Theme::builtin("Dracula").unwrap())
    });
    cx.simulate_keystrokes("up");
    view.read_with(cx, |view, _| {
        assert_eq!(view.theme, Theme::builtin("Nord").unwrap())
    });
    cx.simulate_input("Dracula");
    cx.run_until_parked();
    view.read_with(cx, |view, _| {
        assert_eq!(view.theme, Theme::builtin("Dracula").unwrap());
        assert_eq!(view.config.theme, "Default");
        assert!(!view.menu.themes.as_ref().unwrap().accepting);
        assert!(view.menu.themes.as_ref().unwrap().in_flight.is_none());
    });
    cx.simulate_keystrokes("escape");
    view.read_with(cx, |view, _| assert_eq!(view.theme, Theme::default()));

    for dismiss in 0..3 {
        cx.update(|window, cx| {
            view.update(cx, |view, cx| {
                view.open_theme_picker(window, cx);
                let picker = view.menu.themes.as_mut().unwrap();
                picker.filtered = vec!["Nord".into()];
                picker.selected = 0;
                view.preview_picker_selection(cx);
                assert_eq!(view.theme, Theme::builtin("Nord").unwrap());
                if dismiss == 0 {
                    view.open_preferences_fixture(window, cx);
                }
                if dismiss == 1 {
                    view.dismiss_menu(window, cx);
                }
            })
        });
        if dismiss == 2 {
            cx.update(|window, cx| window.draw(cx).clear(cx));
            cx.simulate_mouse_down(
                point(px(5.), px(5.)),
                MouseButton::Left,
                Modifiers::default(),
            );
        }
        view.read_with(cx, |view, _| assert_eq!(view.theme, Theme::default()));
    }
}

#[gpui::test]
fn load_completion_coalesces_and_fences_requests_and_sessions(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(crate::sidebar::layout_tests::fixture_window);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.open_theme_picker(window, cx);
            // Hold the single load slot explicitly. No filesystem or timing guesses.
            let picker = view.menu.themes.as_mut().unwrap();
            let old = (picker.session, picker.request);
            picker.in_flight = Some(old);
            picker.filtered = vec!["file-a".into(), "file-b".into(), "Nord".into()];
            picker.selected = 0;
            view.preview_picker_selection(cx);
            view.menu.themes.as_mut().unwrap().selected = 1;
            view.preview_picker_selection(cx);
            assert_eq!(view.menu.themes.as_ref().unwrap().in_flight, Some(old));
            assert_eq!(
                view.menu.themes.as_ref().unwrap().desired.as_deref(),
                Some("file-b")
            );
            view.menu.themes.as_mut().unwrap().selected = 2;
            view.preview_picker_selection(cx);
            view.finish_picker_load(old, false, Err(crate::Error::MissingHome), window, cx);
            assert_eq!(view.theme, Theme::builtin("Nord").unwrap());
            assert!(view.menu.themes.as_ref().unwrap().error.is_none());
            assert!(view.menu.themes.as_ref().unwrap().in_flight.is_none());

            let picker = view.menu.themes.as_mut().unwrap();
            let old = (picker.session, picker.request);
            picker.in_flight = Some(old);
            view.dismiss_menu(window, cx);
            view.open_theme_picker(window, cx);
            view.finish_picker_load(
                old,
                false,
                Ok(Theme::builtin("Dracula").unwrap()),
                window,
                cx,
            );
            assert_eq!(view.theme, Theme::default());
            assert!(view.menu.themes.as_ref().unwrap().error.is_none());
            assert!(view.menu.themes.as_ref().unwrap().in_flight.is_none());
            // A duplicate/foreign completion cannot release another request's slot.
            view.menu.themes.as_mut().unwrap().in_flight = Some((999, 999));
            view.finish_picker_load(old, false, Err(crate::Error::MissingHome), window, cx);
            assert_eq!(
                view.menu.themes.as_ref().unwrap().in_flight,
                Some((999, 999))
            );
        })
    });
}

#[gpui::test]
fn background_load_runs_latest_target_and_failure_preserves_preview(cx: &mut TestAppContext) {
    let path = std::env::temp_dir().join(format!("herdr-picker-preview-{}", std::process::id()));
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .unwrap();
    use std::io::Write as _;
    file.write_all(b"background=123456").unwrap();
    drop(file);
    let name = path.to_str().unwrap().to_owned();
    let (view, cx) = cx.add_window_view(crate::sidebar::layout_tests::fixture_window);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.open_theme_picker(window, cx);
            let picker = view.menu.themes.as_mut().unwrap();
            let old = (picker.session, picker.request);
            picker.in_flight = Some(old);
            picker.filtered = vec!["/obsolete-theme".into(), name.clone()];
            picker.selected = 0;
            view.preview_picker_selection(cx);
            view.menu.themes.as_mut().unwrap().selected = 1;
            view.preview_picker_selection(cx);
            // Completing an obsolete request starts exactly the latest file load.
            view.finish_picker_load(old, false, Err(crate::Error::MissingHome), window, cx);
            let picker = view.menu.themes.as_ref().unwrap();
            assert_eq!(picker.in_flight, Some((picker.session, picker.request)));
            assert_eq!(view.theme, Theme::default());
        })
    });
    cx.run_until_parked();
    view.read_with(cx, |view, _| {
        assert_eq!(view.theme.background, 0x123456);
        assert_eq!(view.config.theme, "Default");
        assert!(view.menu.themes.as_ref().unwrap().in_flight.is_none());
    });
    std::fs::remove_file(&path).unwrap();
    cx.update(|_, cx| {
        view.update(cx, |view, cx| {
            let picker = view.menu.themes.as_mut().unwrap();
            picker.filtered = vec![name];
            picker.selected = 0;
            picker.desired = None;
            view.preview_picker_selection(cx);
        })
    });
    cx.run_until_parked();
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            assert_eq!(view.theme.background, 0x123456);
            assert!(view.menu.themes.as_ref().unwrap().error.is_some());
            assert_eq!(view.config.theme, "Default");
            view.dismiss_menu(window, cx);
            assert_eq!(view.theme, Theme::default());
        })
    });
}

#[gpui::test]
fn accept_completion_retains_preview_and_failure_remains_cancellable(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(crate::sidebar::layout_tests::fixture_window);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.open_theme_picker(window, cx);
            let picker = view.menu.themes.as_mut().unwrap();
            picker.filtered = vec!["Nord".into()];
            picker.selected = 0;
            view.preview_picker_selection(cx);
            let picker = view.menu.themes.as_mut().unwrap();
            let token = (picker.session, picker.request);
            picker.in_flight = Some(token);
            view.theme_picker_key(
                &KeyDownEvent {
                    keystroke: Keystroke::parse("enter").unwrap(),
                    is_held: false,
                    prefer_character_input: false,
                },
                window,
                cx,
            );
            assert!(view.menu.themes.as_ref().unwrap().accepting);
            assert_eq!(view.config.theme, "Default");
            view.finish_picker_load(token, true, Err(crate::Error::MissingHome), window, cx);
            assert!(view.menu.themes.as_ref().unwrap().error.is_some());
            assert_eq!(view.config.theme, "Default");
            view.dismiss_menu(window, cx);
            assert_eq!(view.theme, Theme::default());

            view.open_theme_picker(window, cx);
            let picker = view.menu.themes.as_mut().unwrap();
            picker.filtered = vec!["Nord".into()];
            picker.selected = 0;
            view.preview_picker_selection(cx);
            let picker = view.menu.themes.as_mut().unwrap();
            let token = (picker.session, picker.request);
            picker.in_flight = Some(token);
            view.apply_picker_theme("Nord", cx);
            view.finish_picker_load(token, true, Ok(Theme::builtin("Nord").unwrap()), window, cx);
            assert!(view.menu.page.is_none());
            assert_eq!(view.config.theme, "Nord");
            assert_eq!(view.theme, Theme::builtin("Nord").unwrap());
            view.dismiss_menu(window, cx);
            assert_eq!(view.theme, Theme::builtin("Nord").unwrap());
        })
    });
}
