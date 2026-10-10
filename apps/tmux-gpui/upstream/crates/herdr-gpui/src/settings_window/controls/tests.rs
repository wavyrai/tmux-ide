use super::*;
use core::prelude::v1::test;

mod session_restore;

pub(super) fn skill_fixture(
    window: &mut Window,
    cx: &mut Context<SettingsWindow>,
) -> SettingsWindow {
    let source = cx.new(|cx| crate::sidebar::layout_tests::fixture_window(window, cx));
    let mut view = SettingsWindow::new(source.downgrade(), cx);
    view.section = Section::General;
    view
}

pub(super) fn skill_load() -> crate::Result<super::super::Loaded> {
    Ok(super::super::Loaded {
        config: Config::default(),
        theme: Default::default(),
        shared: None,
        error: None,
    })
}

#[gpui::test]
fn notification_delivery_columns_align_without_overflow(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(skill_fixture);
    for font_size in [12., 24., 48.] {
        for width in [680., 960.] {
            cx.simulate_resize(size(px(width), px(2200.)));
            view.update(cx, |view, cx| {
                view.section = Section::Notifications;
                view.config.ui.size = font_size;
                cx.notify();
            });
            cx.update(|window, cx| crate::sidebar::layout_tests::full_draw(window, cx).clear(cx));
            let body = cx.debug_bounds("settings-body").unwrap();
            let mut columns = None;
            let mut previous_bottom = body.top();
            for selectors in [
                [
                    "settings-delivery-Off",
                    "delivery-label-Off",
                    "delivery-radio-Off",
                    "delivery-note-Off",
                ],
                [
                    "settings-delivery-Herdr",
                    "delivery-label-Herdr",
                    "delivery-radio-Herdr",
                    "delivery-note-Herdr",
                ],
                [
                    "settings-delivery-Terminal",
                    "delivery-label-Terminal",
                    "delivery-radio-Terminal",
                    "delivery-note-Terminal",
                ],
                [
                    "settings-delivery-System",
                    "delivery-label-System",
                    "delivery-radio-System",
                    "delivery-note-System",
                ],
            ] {
                let [row, name, radio, note] =
                    selectors.map(|selector| cx.debug_bounds(selector).unwrap());
                let current = (radio.left(), note.left());
                assert_eq!(*columns.get_or_insert(current), current);
                assert_eq!(name.size.width, px(font_size * 5.));
                assert_eq!(radio.size, size(px(14.), px(14.)));
                assert_eq!(radio.left() - name.right(), px(12.));
                assert_eq!(note.left() - radio.right(), px(12.));
                assert!(note.size.width > px(0.));
                assert!(row.left() >= body.left() && row.right() <= body.right());
                assert!(row.top() >= previous_bottom);
                for child in [name, radio, note] {
                    assert!(child.left() >= row.left() && child.right() <= row.right());
                    assert!(child.top() >= row.top() && child.bottom() <= row.bottom());
                }
                previous_bottom = row.bottom();
            }
            if width == 680. {
                let note = cx.debug_bounds("delivery-note-System").unwrap();
                assert!(note.size.height > px(18.), "narrow descriptions must wrap");
            }
        }
    }
}

#[gpui::test]
fn general_shows_shared_tab_bar_and_copy_controls_and_holds_them_while_busy(
    cx: &mut TestAppContext,
) {
    let (view, cx) = cx.add_window_view(skill_fixture);
    cx.simulate_resize(size(px(960.), px(2200.)));
    view.update(cx, |view, cx| {
        view.shared = Some(
            crate::herdr_settings::Settings::parse_text(
                "[ui]\ncopy_on_select = false\ntab_bar_position = 'bottom'",
            )
            .unwrap(),
        );
        view.saving = true;
        cx.notify();
    });
    cx.update(|window, cx| crate::sidebar::layout_tests::full_draw(window, cx).clear(cx));
    for id in [
        "settings-tab-bar-top",
        "settings-tab-bar-bottom",
        "settings-hide-single-tab-bar",
        "settings-copy-on-select",
        "settings-pane-history",
    ] {
        let control = cx.debug_bounds(id).unwrap();
        // A save in flight owns the shared snapshot: clicks wait for it.
        cx.simulate_click(control.center(), Default::default());
        view.read_with(cx, |view, _| {
            assert!(view.save_completion.is_none(), "{id}");
            let shared = view.shared.as_ref().unwrap();
            assert!(!shared.copy_on_select);
            assert_eq!(shared.tab_bar_position, TabBarPosition::Bottom);
            assert!(!shared.hide_tab_bar_when_single_tab);
            assert!(!shared.pane_history);
        });
    }
}

#[gpui::test]
fn show_agents_is_in_appearance_and_disabled_during_saves(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(skill_fixture);
    cx.simulate_resize(size(px(960.), px(2200.)));
    cx.update(|window, cx| crate::sidebar::layout_tests::full_draw(window, cx).clear(cx));
    assert!(cx.debug_bounds("settings-show-agents").is_none());
    for show in [false, true] {
        view.update(cx, |view, cx| {
            view.section = Section::Appearance;
            view.config.show_agents = show;
            view.saving = true;
            cx.notify();
        });
        cx.update(|window, cx| crate::sidebar::layout_tests::full_draw(window, cx).clear(cx));
        let button = cx.debug_bounds("settings-show-agents").unwrap();
        cx.simulate_click(button.center(), Default::default());
        view.update(cx, |view, cx| {
            assert_eq!(view.config.show_agents, show);
            assert!(view.save_completion.is_none());
            view.saving = false;
            view.accept_layout_choice(LayoutMode::Orca, cx);
            // Exercise reconciliation without touching personal configuration.
            view.save_with(
                || Ok(()),
                move || {
                    let mut loaded = skill_load()?;
                    loaded.config.show_agents = !show;
                    Ok(loaded)
                },
                false,
                cx,
            );
        });
        cx.run_until_parked();
        view.read_with(cx, |view, _| {
            assert_eq!(view.config.show_agents, !show);
            assert_eq!(view.layout_intent, Some(LayoutMode::Orca));
            assert_eq!(view.config.layout.mode, LayoutMode::Orca);
            assert!(!view.busy());
        });
    }
}

#[gpui::test]
fn sidebar_chooser_wraps_and_sample_controls_never_save(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(skill_fixture);
    cx.update(|window, cx| crate::sidebar::layout_tests::full_draw(window, cx).clear(cx));
    assert!(cx.debug_bounds("sidebar-preview").is_none());
    view.update(cx, |view, cx| {
        view.section = Section::Appearance;
        cx.notify();
    });
    let original = view.read_with(cx, |view, _| view.config.layout.mode);
    for width in [680., 960.] {
        cx.simulate_resize(size(px(width), px(2200.)));
        view.update(cx, |view, cx| {
            view.controls.sidebar_preview = Default::default();
            cx.notify();
        });
        cx.update(|window, cx| crate::sidebar::layout_tests::full_draw(window, cx).clear(cx));
        let body = cx.debug_bounds("settings-body").unwrap();
        let panel = cx.debug_bounds("sidebar-preview").unwrap();
        assert!(panel.right() <= body.right());
        let mut previous = None;
        for selector in [
            "settings-layout-normal",
            "settings-layout-compact",
            "settings-layout-comfortable",
            "settings-layout-normal-rounded",
            "settings-layout-compact-rounded",
            "settings-layout-comfortable-rounded",
            "settings-layout-superset",
            "settings-layout-orca",
            "settings-layout-minimal",
        ] {
            let bounds = cx.debug_bounds(selector).unwrap();
            if let Some(bottom) = previous {
                assert!(bounds.top() >= bottom);
            }
            previous = Some(bounds.bottom());
        }
        for selector in [
            "preview-width-320",
            "row-Settings window",
            "row-preview-agent-0",
            "collapse-0",
        ] {
            let bounds = cx.debug_bounds(selector).unwrap();
            cx.simulate_click(bounds.center(), Default::default());
            cx.update(|window, cx| crate::sidebar::layout_tests::full_draw(window, cx).clear(cx));
            view.read_with(cx, |view, _| {
                assert!(!view.busy());
                assert!(view.save_completion.is_none());
                assert_eq!(view.config.layout.mode, original);
            });
        }
        assert_eq!(
            cx.debug_bounds("sidebar-preview").unwrap().size.width,
            px(320.)
        );
    }
    view.update(cx, |view, cx| {
        view.saving = true;
        view.error = Some("Existing error".into());
        cx.notify();
    });
    cx.update(|window, cx| crate::sidebar::layout_tests::full_draw(window, cx).clear(cx));
    let choice = cx.debug_bounds("settings-layout-orca").unwrap();
    cx.simulate_click(choice.center(), Default::default());
    view.update(cx, |view, _| {
        assert_eq!(view.layout_intent, Some(LayoutMode::Orca));
        assert!(view.save_completion.is_none());
        assert_eq!(view.error.as_deref(), Some("Existing error"));
        view.saving = false;
    });
}

#[gpui::test]
fn appearance_scroll_reaches_sidebar_preview(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(skill_fixture);
    for width in [680., 960.] {
        cx.simulate_resize(size(px(width), px(560.)));
        view.update(cx, |view, cx| {
            view.section = Section::Appearance;
            view.body_scroll.set_offset(Point::default());
            cx.notify();
        });
        cx.update(|window, cx| crate::sidebar::layout_tests::full_draw(window, cx).clear(cx));
        let panel = cx.debug_bounds("sidebar-preview").unwrap();
        let body = cx.debug_bounds("settings-body").unwrap();
        assert!(panel.top() > body.bottom());
        view.update(cx, |view, cx| {
            view.body_scroll
                .set_offset(point(px(0.), body.top() - panel.top()));
            cx.notify();
        });
        cx.update(|window, cx| crate::sidebar::layout_tests::full_draw(window, cx).clear(cx));
        let row = cx.debug_bounds("row-Settings window").unwrap();
        assert!(row.top() >= body.top() && row.bottom() <= body.bottom());
        cx.simulate_click(row.center(), Default::default());
        view.read_with(cx, |view, _| {
            assert!(!view.busy());
            assert!(view.save_completion.is_none());
            assert!(view.layout_intent.is_none());
        });
    }
}

#[gpui::test]
fn sidebar_layout_draft_survives_other_save_failure(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(skill_fixture);
    view.update(cx, |view, cx| {
        view.accept_layout_choice(LayoutMode::Orca, cx);
        view.save_with(|| Err(crate::Error::MissingHome), skill_load, false, cx);
        assert_eq!(view.layout_intent, Some(LayoutMode::Orca));
        assert!(view.busy());
        view.sync_controls(cx);
        assert_eq!(view.layout_intent, Some(LayoutMode::Orca));
    });
    cx.run_until_parked();
    view.read_with(cx, |view, _| {
        assert!(!view.busy());
        assert!(view.error.is_some());
        assert_eq!(view.layout_intent, Some(LayoutMode::Orca));
        assert_eq!(view.config.layout.mode, LayoutMode::Orca);
    });
}

#[gpui::test]
fn browser_skill_general_card_tracks_choice_without_a_source(cx: &mut TestAppContext) {
    cx.update(|cx| cx.set_global(AgentSkill::unasked()));
    let (view, cx) = cx.add_window_view(skill_fixture);
    cx.simulate_resize(size(px(960.), px(1200.)));
    for choice in [None, Some(Choice::Installed), Some(Choice::Declined)] {
        cx.update(|window, cx| {
            if let Some(choice) = choice {
                AgentSkill::choose(choice, cx);
            }
            view.update(cx, |view, cx| {
                assert!(view.source.upgrade().is_none());
                cx.notify();
            });
            window.draw(cx).clear(cx);
        });
        assert_eq!(
            cx.debug_bounds("settings-install-browser-skill").is_some(),
            choice != Some(Choice::Installed)
        );
        assert_eq!(
            cx.debug_bounds("settings-remove-browser-skill").is_some(),
            choice == Some(Choice::Installed)
        );
    }
    // Busy buttons must not invoke the real installer even when clicked.
    view.update(cx, |view, cx| {
        view.saving = true;
        cx.notify();
    });
    cx.update(|window, cx| window.draw(cx).clear(cx));
    let button = cx.debug_bounds("settings-install-browser-skill").unwrap();
    cx.simulate_click(button.center(), Modifiers::default());
    view.update(cx, |view, cx| {
        assert_eq!(AgentSkill::choice(cx), Some(Choice::Declined));
        assert!(view.save_completion.is_none());
        view.saving = false;
    });
}

#[gpui::test]
fn browser_skill_choice_changes_only_after_success_and_serializes(cx: &mut TestAppContext) {
    cx.update(|cx| cx.set_global(AgentSkill::unasked()));
    let (view, cx) = cx.add_window_view(skill_fixture);
    for (choice, succeeds, expected) in [
        (Choice::Installed, false, None),
        (Choice::Installed, true, Some(Choice::Installed)),
        (Choice::Declined, false, Some(Choice::Installed)),
        (Choice::Declined, true, Some(Choice::Declined)),
    ] {
        view.update(cx, |view, cx| {
            let before = AgentSkill::choice(cx);
            view.save_skill_with(
                choice,
                move || {
                    if succeeds {
                        Ok(())
                    } else {
                        Err(crate::Error::MissingHome)
                    }
                },
                skill_load,
                cx,
            );
            assert!(view.busy());
            assert_eq!(AgentSkill::choice(cx), before);
            view.save_skill_with(
                choice,
                || panic!("overlapping skill operation"),
                skill_load,
                cx,
            );
        });
        cx.run_until_parked();
        view.read_with(cx, |view, cx| {
            assert!(!view.busy());
            assert_eq!(AgentSkill::choice(cx), expected);
            assert_eq!(view.error.is_some(), !succeeds);
            assert_eq!(
                view.status.as_deref(),
                (!succeeds).then_some("Save failed; reloaded current preferences")
            );
        });
    }
    // A successful file operation remains successful if config reload fails.
    view.update(cx, |view, cx| {
        view.save_skill_with(
            Choice::Installed,
            || Ok(()),
            || Err(crate::Error::MissingHome),
            cx,
        );
    });
    cx.run_until_parked();
    view.read_with(cx, |view, cx| {
        assert_eq!(AgentSkill::choice(cx), Some(Choice::Installed));
        assert!(view.error.is_some());
    });
}

#[test]
fn font_filter_keeps_all_four_hundred_families_and_matches_case_insensitively() {
    let names: Vec<_> = (0..400).map(|i| format!("Family {i:03}")).collect();
    assert_eq!(filter_fonts(&names, "").len(), 400);
    assert_eq!(
        filter_fonts(&names, " FAMILY 39 "),
        (390..400).collect::<Vec<_>>()
    );
    assert_eq!(filter_fonts(&names, "Family 399"), vec![399]);
    assert!(filter_fonts(&names, "missing").is_empty());
}

#[test]
fn size_steps_are_integral_bounded_and_reject_non_finite_values() {
    assert_eq!(stepped_size(8., -1.), Some(8.));
    assert_eq!(stepped_size(48., 1.), Some(48.));
    assert_eq!(stepped_size(14.2, 1.), Some(15.));
    for invalid in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
        assert_eq!(stepped_size(invalid, 1.), None);
        assert_eq!(stepped_size(14., invalid), None);
    }
}

#[test]
fn rapid_size_intents_coalesce_without_erasing_other_faces() {
    let mut pending = Vec::new();
    queue_size(&mut pending, FontFace::Sidebar, 15.);
    queue_size(&mut pending, FontFace::Terminal, 18.);
    queue_size(&mut pending, FontFace::Sidebar, 16.);
    assert_eq!(
        pending,
        vec![(FontFace::Sidebar, 16.), (FontFace::Terminal, 18.)]
    );
}

#[gpui::test]
fn busy_size_clicks_survive_config_refresh_without_starting_a_write(cx: &mut TestAppContext) {
    let (source, cx) = cx.add_window_view(crate::sidebar::layout_tests::fixture_window);
    let settings = cx.new(|cx| SettingsWindow::new(source.downgrade(), cx));
    settings.update(cx, |settings, cx| {
        settings.saving = true;
        settings.controls.saving_sizes = vec![(FontFace::Sidebar, 20.)];
        for _ in 0..20 {
            settings.step_control_size(FontFace::Sidebar, 1., cx);
        }
        settings.step_control_size(FontFace::Terminal, 1., cx);
        settings.config.sidebar.size = 12.;
        settings.sync_controls(cx);
        assert_eq!(
            settings.controls.size(FontFace::Sidebar, &settings.config),
            40.
        );
        assert_eq!(settings.controls.pending_sizes.len(), 2);
        assert_eq!(
            settings.controls.saving_sizes,
            vec![(FontFace::Sidebar, 20.)]
        );
        // Keep the test entirely in memory: completion and persistence are
        // exercised by the root save tests, not the user's configuration.
        settings.controls.pending_sizes.clear();
        settings.saving = false;
        settings.sync_controls(cx);
        assert_eq!(
            settings.controls.size(FontFace::Sidebar, &settings.config),
            12.
        );
    });
}

#[test]
fn numeric_size_accepts_only_bounded_ascii_integers() {
    for (text, expected) in [
        ("8", Some(8.)),
        (" 48 ", Some(48.)),
        ("24", Some(24.)),
        ("7", None),
        ("49", None),
        ("12.5", None),
        ("-12", None),
        ("", None),
        ("２４", None),
        ("NaN", None),
        ("999999", None),
    ] {
        assert_eq!(parse_size(text), expected, "{text:?}");
    }
}

fn numeric_fixture(window: &mut Window, cx: &mut Context<SettingsWindow>) -> SettingsWindow {
    let source = cx.new(|cx| crate::sidebar::layout_tests::fixture_window(window, cx));
    let mut view = SettingsWindow::new(source.downgrade(), cx);
    view.section = Section::Fonts;
    // Accepted intents remain in memory while assertions inspect the queue.
    view.saving = true;
    view.controls.discovering = false;
    window.focus(&view.focus, cx);
    view
}

#[gpui::test]
fn numeric_enter_blur_and_escape_use_the_same_size_queue(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(numeric_fixture);
    cx.update(|window, _| window.activate_window());
    cx.run_until_parked();
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.begin_control_size_edit(FontFace::Terminal, window, cx);
        })
    });
    cx.simulate_input("23");
    cx.simulate_keystrokes("enter");
    view.read_with(cx, |view, _| {
        assert!(view.controls.size_editor.is_none());
        assert_eq!(view.controls.pending_sizes, vec![(FontFace::Terminal, 23.)]);
    });
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.begin_control_size_edit(FontFace::Terminal, window, cx);
        })
    });
    cx.simulate_input("41");
    cx.simulate_keystrokes("escape");
    view.read_with(cx, |view, _| {
        assert_eq!(view.controls.pending_sizes, vec![(FontFace::Terminal, 23.)])
    });
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.begin_control_size_edit(FontFace::Sidebar, window, cx);
        })
    });
    cx.simulate_input("18");
    cx.update(|window, cx| window.draw(cx).clear(cx));
    cx.run_until_parked();
    cx.update(|window, cx| window.focus(&view.read(cx).focus.clone(), cx));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    cx.run_until_parked();
    view.update(cx, |view, _| {
        assert!(view.controls.size_editor.is_none());
        assert_eq!(
            view.take_pending_control_sizes(),
            vec![(FontFace::Terminal, 23.), (FontFace::Sidebar, 18.)]
        );
    });
}

#[gpui::test]
fn numeric_invalid_and_composition_do_not_enqueue_writes(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(numeric_fixture);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.begin_control_size_edit(FontFace::Ui, window, cx);
        })
    });
    cx.simulate_input("99");
    cx.simulate_keystrokes("enter");
    view.read_with(cx, |view, _| {
        assert!(view.controls.size_editor.as_ref().unwrap().invalid);
        assert!(view.controls.pending_sizes.is_empty());
    });
    cx.simulate_keystrokes("escape");
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.begin_control_size_edit(FontFace::Ui, window, cx);
            let input = view.controls.size_editor.as_ref().unwrap().input.clone();
            input.update(cx, |input, cx| {
                input.replace_and_mark_text_in_range(None, "二十四", Some(3..3), window, cx)
            });
            for key in ["enter", "escape"] {
                view.control_size_key(
                    &KeyDownEvent {
                        keystroke: Keystroke::parse(key).unwrap(),
                        is_held: false,
                        prefer_character_input: false,
                    },
                    window,
                    cx,
                );
                assert!(view.controls.size_editor.is_some());
                assert!(view.controls.pending_sizes.is_empty());
            }
            input.update(cx, |input, cx| input.unmark_text(window, cx));
            assert!(!view.finish_control_size_edit(true, cx));
            assert!(view.finish_control_size_edit(false, cx));
            assert!(view.controls.pending_sizes.is_empty());
        })
    });
}
