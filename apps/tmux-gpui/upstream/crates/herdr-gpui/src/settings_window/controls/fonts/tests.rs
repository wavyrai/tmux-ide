use super::*;
use core::prelude::v1::test;
use std::sync::{Arc, Mutex};

const ROWS: [&str; 4] = [
    "settings-font-row-terminal",
    "settings-font-row-sidebar",
    "settings-font-row-tabs",
    "settings-font-row-ui",
];
const FAMILIES: [&str; 4] = [
    "settings-font-family-terminal",
    "settings-font-family-sidebar",
    "settings-font-family-tabs",
    "settings-font-family-ui",
];
const PLUS: [&str; 4] = [
    "settings-size-terminal-+",
    "settings-size-sidebar-+",
    "settings-size-tabs-+",
    "settings-size-ui-+",
];

fn fixture(window: &mut Window, cx: &mut Context<SettingsWindow>) -> SettingsWindow {
    let source = cx.new(|cx| crate::sidebar::layout_tests::fixture_window(window, cx));
    let mut view = SettingsWindow::new(source.downgrade(), cx);
    view.section = Section::Fonts;
    view.controls.names = (0..472).map(|i| format!("Family {i:03}")).collect();
    view.controls.filtered = filter_fonts(&view.controls.names, "");
    view.controls.discovering = false;
    view.sync_controls(cx);
    window.focus(&view.focus, cx);
    view
}

fn inside(inner: Bounds<Pixels>, outer: Bounds<Pixels>) {
    assert!(
        inner.left() >= outer.left() && inner.right() <= outer.right(),
        "{inner:?} in {outer:?}"
    );
    assert!(
        inner.top() >= outer.top() && inner.bottom() <= outer.bottom(),
        "{inner:?} in {outer:?}"
    );
}

#[gpui::test]
fn compact_rows_and_unclipped_picker_at_both_window_sizes(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(fixture);
    view.update(cx, |view, cx| {
        view.config.terminal.family = "Very long installed font family ".repeat(12);
        cx.notify();
    });
    for (width, height) in [(960., 780.), (680., 560.)] {
        cx.simulate_resize(size(px(width), px(height)));
        cx.update(|window, cx| window.draw(cx).clear(cx));
        assert!(cx.debug_bounds("settings-font-results").is_none());
        assert!(cx.debug_bounds("settings-font-picker").is_none());
        let body = cx.debug_bounds("settings-body").unwrap();
        let mut previous: Option<Bounds<Pixels>> = None;
        for index in 0..4 {
            let row = cx.debug_bounds(ROWS[index]).unwrap();
            inside(row, body);
            assert_eq!(row.size.height, px(52.));
            if let Some(previous) = previous {
                assert_eq!(row.top() - previous.bottom(), px(8.));
            }
            previous = Some(row);
            let family = cx.debug_bounds(FAMILIES[index]).unwrap();
            inside(family, row);
            assert!(family.size.width > px(100.));
            inside(cx.debug_bounds(PLUS[index]).unwrap(), row);
        }
        let button = cx.debug_bounds("settings-font-family-terminal").unwrap();
        cx.simulate_click(button.center(), Modifiers::default());
        cx.update(|window, cx| window.draw(cx).clear(cx));
        let picker = cx.debug_bounds("settings-font-picker").unwrap();
        inside(picker, body);
        inside(cx.debug_bounds("settings-font-results").unwrap(), picker);
        assert_eq!(
            cx.debug_bounds("settings-font-result-0")
                .unwrap()
                .size
                .height,
            px(28.)
        );
        assert!(cx.debug_bounds("settings-font-result-471").is_none());
        view.read_with(cx, |view, cx| {
            assert_eq!(view.controls.search.read(cx).text(), "")
        });
        cx.simulate_keystrokes("escape");
    }
}

#[gpui::test]
fn picker_search_keyboard_refresh_and_dismissal_are_local(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(fixture);
    cx.simulate_resize(size(px(680.), px(560.)));
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.open_control_font_picker(FontTarget::Face(FontFace::Sidebar), window, cx);
            assert!(view.controls.search.read(cx).focus.is_focused(window));
        })
    });
    cx.simulate_input("fAmIlY 47");
    cx.run_until_parked();
    cx.simulate_keystrokes("down");
    view.update(cx, |view, cx| {
        assert_eq!(view.controls.filtered, vec![470, 471]);
        assert_eq!(view.controls.selected, 1);
        view.apply_loaded(
            Ok(super::super::super::Loaded {
                config: view.config.clone(),
                theme: view.theme.clone(),
                shared: None,
                error: None,
            }),
            cx,
        );
        assert_eq!(view.controls.search.read(cx).text(), "fAmIlY 47");
        assert_eq!(view.controls.selected, 1);
        // Browsing remains possible while another root save is pending.
        view.saving = true;
    });
    cx.simulate_keystrokes("enter");
    view.read_with(cx, |view, _| assert!(view.controls.picker.is_some()));
    cx.simulate_keystrokes("up escape");
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            assert!(view.controls.picker.is_none());
            assert!(view.focus.is_focused(window));
            view.open_control_font_picker(FontTarget::All, window, cx);
            assert_eq!(view.controls.filtered.len(), 472);
        })
    });
    cx.update(|window, cx| window.draw(cx).clear(cx));
    // Outside the panel but inside its body-level backdrop.
    cx.simulate_click(point(px(190.), px(50.)), Modifiers::default());
    view.read_with(cx, |view, _| assert!(view.controls.picker.is_none()));
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.open_control_font_picker(FontTarget::All, window, cx);
            view.select_section(Section::General, window, cx);
            assert!(view.controls.picker.is_none());
            view.saving = false;
        })
    });
}

#[gpui::test]
fn selected_row_specimen_uses_face_and_effective_pending_size(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(fixture);
    cx.simulate_resize(size(px(960.), px(780.)));
    view.update(cx, |view, cx| {
        view.saving = true;
        cx.notify();
    });
    for ((face, _), selector) in FACES.into_iter().zip(ROWS) {
        cx.update(|window, cx| window.draw(cx).clear(cx));
        let row = cx.debug_bounds(selector).unwrap();
        cx.simulate_click(
            point(row.left() + px(20.), row.center().y),
            Modifiers::default(),
        );
        view.update(cx, |view, cx| {
            assert_eq!(view.controls.active_face, face);
            let original = face_font(&view.config, face).clone();
            view.step_control_size(face, 1., cx);
            let specimen = view.control_specimen_font();
            assert_eq!(specimen.family, original.family);
            assert_eq!(specimen.font(), original.font());
            assert_eq!(specimen.size, original.size + 1.);
        });
    }
    view.update(cx, |view, _| {
        view.controls.pending_sizes.clear();
        view.saving = false;
    });
    assert_eq!(family_label(".SystemUIFont"), "System font");
}

#[gpui::test]
fn chooser_composition_neither_navigates_commits_nor_dismisses(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(fixture);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.open_control_font_picker(FontTarget::All, window, cx);
            let search = view.controls.search.clone();
            search.update(cx, |input, cx| {
                input.replace_and_mark_text_in_range(None, "Family", Some(6..6), window, cx);
            });
            for key in ["down", "up", "enter", "escape"] {
                view.control_font_key(
                    &KeyDownEvent {
                        keystroke: Keystroke::parse(key).unwrap(),
                        is_held: false,
                        prefer_character_input: false,
                    },
                    window,
                    cx,
                );
                assert_eq!(view.controls.selected, 0);
                assert_eq!(view.controls.picker, Some(FontTarget::All));
                assert!(!view.busy());
            }
            search.update(cx, |input, cx| input.unmark_text(window, cx));
            view.dismiss_control_font_picker(window, cx);
        });
    });
}

#[gpui::test]
fn family_commits_capture_target_and_only_change_families(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(fixture);
    let config = Arc::new(Mutex::new(
        view.read_with(cx, |view, _| view.config.clone()),
    ));
    let writes = Arc::new(Mutex::new(Vec::new()));
    view.update(cx, |view, _| {
        let state = config.clone();
        let recorded = writes.clone();
        let loaded = config.clone();
        view.controls.family_io = Some(FamilyIo {
            write: Arc::new(move |target, family| {
                recorded.lock().unwrap().push((target, family.clone()));
                let mut config = state.lock().unwrap();
                let defaults = Config::default();
                for (face, _) in FACES {
                    if target != FontTarget::All && target != FontTarget::Face(face) {
                        continue;
                    }
                    let default = face_font(&defaults, face).family.clone();
                    let font = match face {
                        FontFace::Terminal => &mut config.terminal,
                        FontFace::Sidebar => &mut config.sidebar,
                        FontFace::Tabs => &mut config.tabs,
                        FontFace::Ui => &mut config.ui,
                    };
                    font.family = family.clone().unwrap_or(default);
                }
                Ok(())
            }),
            load: Arc::new(move || {
                Ok(super::super::super::Loaded {
                    config: loaded.lock().unwrap().clone(),
                    theme: Default::default(),
                    shared: None,
                    error: None,
                })
            }),
        });
    });
    let sizes = view.read_with(cx, |view, _| FACES.map(|(face, _)| face.size(&view.config)));
    for target in FACES
        .map(|(face, _)| FontTarget::Face(face))
        .into_iter()
        .chain([FontTarget::All])
    {
        for family in [Some("Family 471".to_owned()), None] {
            cx.update(|window, cx| {
                view.update(cx, |view, cx| {
                    view.open_control_font_picker(target, window, cx);
                    view.controls.active_face = FontFace::Ui;
                    if family.is_none() {
                        view.commit_control_family(target, None, window, cx);
                    }
                })
            });
            if family.is_some() {
                cx.simulate_input("fAmIlY 471");
                cx.run_until_parked();
                cx.simulate_keystrokes("enter");
            }
            cx.update(|window, cx| {
                view.update(cx, |view, _| {
                    assert!(view.controls.picker.is_none());
                    assert!(view.focus.is_focused(window));
                })
            });
            cx.run_until_parked();
            assert_eq!(
                writes.lock().unwrap().last(),
                Some(&(target, family.clone()))
            );
            view.read_with(cx, |view, _| {
                assert!(!view.busy());
                assert_eq!(FACES.map(|(face, _)| face.size(&view.config)), sizes);
                for (face, _) in FACES {
                    let expected = if family.is_some()
                        && (target == FontTarget::All || target == FontTarget::Face(face))
                    {
                        "Family 471".to_owned()
                    } else {
                        face_font(&Config::default(), face).family.clone()
                    };
                    assert_eq!(face_font(&view.config, face).family, expected);
                }
            });
        }
    }
    assert_eq!(writes.lock().unwrap().len(), 10);
}
