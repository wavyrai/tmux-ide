use super::*;
use core::prelude::v1::test;

mod line_height;
mod window_commands;

fn records() -> Vec<Arc<Record>> {
    [
        (Level::WARN, "slow paint elapsed_ms=32"),
        (Level::INFO, "slow transport elapsed_ms=8"),
        (Level::WARN, "unrelated message"),
    ]
    .into_iter()
    .map(|(level, line)| Arc::new(Record::fixture(level, line)))
    .collect()
}

#[test]
fn concrete_default_fonts_and_shared_native_decoration() {
    let appearance = Appearance::default();
    assert_eq!(
        appearance.config.terminal.family,
        if cfg!(target_os = "linux") {
            "DejaVu Sans Mono"
        } else if cfg!(windows) {
            "Cascadia Mono"
        } else {
            "Menlo"
        }
    );
    let options = crate::titlebar::options("Logs");
    assert_eq!(options.title.unwrap().as_ref(), "Logs");
    assert_eq!(options.appears_transparent, cfg!(target_os = "macos"));
    assert_eq!(
        options.traffic_light_position,
        cfg!(target_os = "macos").then(|| point(px(9.), px(9.)))
    );
}

#[gpui::test]
fn picker_preview_and_cancel_keep_console_appearance_in_sync(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(crate::sidebar::layout_tests::fixture_window);
    let original = view.read_with(cx, |view, _| view.theme.clone());
    cx.update(|window, cx| {
        view.update(cx, |view, cx| view.open_theme_picker(window, cx));
    });
    cx.simulate_input("Nord");
    cx.run_until_parked();
    cx.update(|_, cx| {
        assert_eq!(
            cx.global::<Appearance>().theme,
            Theme::builtin("Nord").unwrap()
        );
        assert_eq!(view.read(cx).theme, cx.global::<Appearance>().theme);
        assert_eq!(view.read(cx).config.theme, "Default");
    });
    cx.update(|window, cx| {
        view.update(cx, |view, cx| view.dismiss_menu(window, cx));
        assert_eq!(view.read(cx).theme, original);
        assert_eq!(cx.global::<Appearance>().theme, original);
    });
}

#[gpui::test]
fn appearance_updates_open_paused_console_and_geometry(cx: &mut TestAppContext) {
    let mut config = Config {
        theme: "Nord".into(),
        ..Config::default()
    };
    cx.update(|cx| set_appearance(&config, &config.theme(false).unwrap(), cx));
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = LogWindow::new(window, cx);
        view.following = false;
        view.generation = Some(diagnostics::generation());
        view.rows = records();
        view.scroll.reset(view.rows.len());
        view.selected = Some(view.rows[0].clone());
        view
    });
    for name in ["Nord", "Catppuccin Latte", "Dracula"] {
        config.theme = name.into();
        config.terminal.family = "DejaVu Sans Mono".into();
        config.terminal.size = 20.;
        config.ui.size = 16.;
        let theme = config.theme(false).unwrap();
        cx.update(|_, cx| set_appearance(&config, &theme, cx));
        cx.run_until_parked();
        view.read_with(cx, |view, _| {
            assert_eq!(view.appearance.theme, theme);
            assert_eq!(view.appearance.config.ui.family, config.ui.family);
            assert_eq!(view.appearance.config.ui.size, 16.);
            assert_eq!(view.appearance.config.terminal.family, "DejaVu Sans Mono");
            assert!(!view.following);
            assert_eq!(view.rows.len(), 3);
            assert!(view.selected.is_some());
            assert_eq!(
                severity_color(&theme, Level::ERROR),
                palette_color(&theme, 1)
            );
            assert_eq!(
                severity_color(&theme, Level::WARN),
                palette_color(&theme, 3)
            );
            assert_eq!(
                severity_color(&theme, Level::INFO),
                palette_color(&theme, 2)
            );
            assert_eq!(
                severity_color(&theme, Level::DEBUG),
                palette_color(&theme, 4)
            );
            assert_eq!(
                severity_color(&theme, Level::TRACE),
                palette_color(&theme, 5)
            );
        });
        for (width, height) in [(1100., 650.), (620., 360.)] {
            cx.simulate_resize(size(px(width), px(height)));
            cx.run_until_parked();
            cx.update(|window, cx| {
                window.refresh();
                window.draw(cx).clear(cx);
            });
            let search = cx.debug_bounds("theme-search").unwrap();
            #[cfg(target_os = "macos")]
            {
                let header = cx.debug_bounds("titlebar").unwrap();
                assert_eq!(
                    header,
                    Bounds::new(point(px(0.), px(0.)), size(px(width), px(34.)))
                );
                assert!(search.top() >= header.bottom());
            }
            let first = cx.debug_bounds("log-row-0").unwrap();
            assert!(first.size.height >= px(config.terminal.line_height() + 1.));
            assert!(first.top() >= search.bottom());
            let detail = cx.debug_bounds("log-detail").unwrap();
            assert_eq!(detail.size.height, px((height * 0.2).min(100.)));
            view.read_with(cx, |view, _| {
                assert!(detail.top() >= view.scroll.viewport_bounds().bottom());
            });
            assert!(detail.bottom() <= px(height));
            for selector in ["minimum-level", "follow", "copy", "export"] {
                let bounds = cx.debug_bounds(selector).unwrap();
                assert!(bounds.left() >= px(0.) && bounds.right() <= px(width));
                assert!(
                    bounds.bottom() <= first.top(),
                    "{name} {width}x{height} {selector}: {bounds:?}, row: {first:?}"
                );
            }
        }
    }
}

#[gpui::test]
fn narrow_layout_renders_search_and_virtualized_rows(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = LogWindow::new(window, cx);
        view.following = false;
        view.generation = Some(diagnostics::generation());
        view.retained = (0..5000)
            .map(|index| Arc::new(Record::fixture(Level::INFO, format!("fixture row {index}"))))
            .collect();
        view.rows = view.retained.clone();
        view.scroll.reset(view.rows.len());
        view
    });
    cx.simulate_resize(size(px(620.), px(650.)));
    cx.run_until_parked();
    cx.update(|window, cx| window.draw(cx).clear(cx));
    let search = cx.debug_bounds("theme-search").unwrap();
    assert!(search.size.width > px(500.));
    assert!(search.size.height > px(0.));
    assert!(search.left() >= px(0.) && search.right() <= px(620.));
    let first = cx.debug_bounds("log-row-0").unwrap();
    let tenth = cx.debug_bounds("log-row-10").unwrap();
    assert_eq!(first.size.height, px(22.));
    assert!(first.top() >= search.bottom());
    assert_eq!(tenth.top() - first.top(), px(220.));
    assert!(tenth.bottom() < px(650.));
    assert!(cx.debug_bounds("log-row-4999").is_none());
    for selector in ["minimum-level", "follow", "copy", "export"] {
        let bounds = cx.debug_bounds(selector).unwrap();
        assert!(
            bounds.left() >= px(0.) && bounds.right() <= px(620.),
            "{selector}: {bounds:?}"
        );
    }
    view.update(cx, |view, cx| {
        view.scroll.scroll_to(ListOffset {
            item_ix: 5000,
            offset_in_item: px(0.),
        });
        cx.notify();
    });
    cx.run_until_parked();
    cx.update(|window, cx| {
        window.refresh();
        window.draw(cx).clear(cx);
    });
    let last = cx.debug_bounds("log-row-4999").unwrap();
    assert!(last.top() > search.bottom() && last.bottom() < px(650.));
    cx.simulate_input("fixture");
    view.read_with(cx, |view, cx| {
        assert_eq!(view.search.read(cx).text(), "fixture")
    });
}

#[gpui::test]
fn wrapped_rows_reflow_keep_columns_and_tail_without_changing_exports(cx: &mut TestAppContext) {
    let body = "x".repeat(160);
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = LogWindow::new(window, cx);
        view.following = false;
        view.generation = Some(diagnostics::generation());
        view.retained = (0..5000)
            .map(|index| {
                Arc::new(Record::fixture(
                    LEVELS[index % LEVELS.len()],
                    if index == 1 || index == 4999 {
                        body.clone()
                    } else {
                        "short".into()
                    },
                ))
            })
            .collect();
        view.rows = view.retained.clone();
        view.scroll.reset(view.rows.len());
        view
    });
    let mut heights = Vec::new();
    for (width, font_size) in [(1100., 14.), (620., 14.), (620., 20.), (1100., 14.)] {
        let mut config = Config::default();
        config.terminal.size = font_size;
        cx.update(|_, cx| set_appearance(&config, &Theme::default(), cx));
        cx.simulate_resize(size(px(width), px(850.)));
        cx.run_until_parked();
        cx.update(|window, cx| {
            window.refresh();
            window.draw(cx).clear(cx);
        });
        let short = cx.debug_bounds("log-row-0").unwrap();
        let long = cx.debug_bounds("log-row-1").unwrap();
        let short_body = cx.debug_bounds("log-body-0").unwrap();
        let long_body = cx.debug_bounds("log-body-1").unwrap();
        let info_body = cx.debug_bounds("log-body-2").unwrap();
        assert!(long.size.height > short.size.height);
        assert_eq!(long_body.left(), short_body.left());
        assert_eq!(info_body.left(), short_body.left());
        assert!(long_body.right() <= px(width));
        assert_eq!(short.bottom(), long.top());
        assert!(cx.debug_bounds("log-row-4999").is_none());
        heights.push(long.size.height);
    }
    assert!(heights[1] > heights[0]);
    assert!(heights[2] > heights[1]);
    assert_eq!(heights[3], heights[0]);

    // Tail must reach the bottom of the final wrapped row, not its first line.
    view.update(cx, |view, cx| {
        view.following = true;
        cx.notify();
    });
    for width in [620., 1100.] {
        cx.simulate_resize(size(px(width), px(850.)));
        cx.run_until_parked();
        cx.update(|window, cx| {
            window.refresh();
            window.draw(cx).clear(cx);
        });
        let last = cx.debug_bounds("log-row-4999").unwrap();
        view.read_with(cx, |view, _| {
            assert!((last.bottom() - view.scroll.viewport_bounds().bottom()).abs() < px(1.));
            assert!(view.scroll.bounds_for_item(0).is_none());
        });
    }
    let offset = view.read_with(cx, |view, _| view.scroll.logical_scroll_top());
    let follow = cx.debug_bounds("follow").unwrap();
    cx.simulate_click(follow.center(), Modifiers::default());
    cx.executor().advance_clock(Duration::from_millis(250));
    cx.run_until_parked();
    view.read_with(cx, |view, _| {
        assert!(!view.following);
        let paused = view.scroll.logical_scroll_top();
        assert_eq!(paused.item_ix, offset.item_ix);
        assert_eq!(paused.offset_in_item, offset.offset_in_item);
    });
    cx.simulate_click(follow.center(), Modifiers::default());
    cx.run_until_parked();
    view.read_with(cx, |view, _| assert!(view.following));
    let position = view.read_with(cx, |view, _| view.scroll.viewport_bounds().center());
    cx.simulate_event(ScrollWheelEvent {
        position,
        delta: ScrollDelta::Pixels(point(px(0.), px(120.))),
        touch_phase: TouchPhase::Moved,
        ..Default::default()
    });
    cx.run_until_parked();
    view.read_with(cx, |view, _| {
        assert!(!view.following);
        assert_eq!(view.retained.len(), 5000);
    });
    view.update(cx, |view, cx| {
        view.search
            .update(cx, |input, cx| input.set_text_selected("xxx", cx));
    });
    cx.executor().advance_clock(Duration::from_millis(250));
    cx.run_until_parked();
    view.update(cx, |view, cx| {
        assert_eq!(view.rows.len(), 2);
        assert_eq!(view.scroll.item_count(), 2);
        assert!(Arc::ptr_eq(&view.rows[1], &view.retained[4999]));
        view.share(false, cx);
    });
    cx.run_until_parked();
    cx.update(|_, cx| {
        let text = cx.read_from_clipboard().unwrap().text().unwrap();
        let rows = exported_records(&text);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].level, Level::DEBUG);
        assert_eq!(rows[1].level, Level::ERROR);
        assert!(rows.iter().all(|row| row.message == body));
    });
}

#[gpui::test]
fn paused_filter_changes_preserve_retained_snapshot(cx: &mut TestAppContext) {
    let retained = records();
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = LogWindow::new(window, cx);
        view.following = false;
        view.generation = Some(diagnostics::generation());
        view.retained = retained.clone();
        view.rows = retained.clone();
        view.scroll.reset(view.rows.len());
        view.dropped = 17;
        view
    });
    cx.run_until_parked();
    cx.update(|window, cx| window.draw(cx).clear(cx));
    cx.simulate_input("SLOW");
    cx.executor().advance_clock(Duration::from_millis(250));
    cx.run_until_parked();
    view.read_with(cx, |view, _| {
        assert!(!view.following);
        assert_eq!(view.rows.len(), 2);
        assert!(Arc::ptr_eq(&view.rows[0], &retained[0]));
        assert!(Arc::ptr_eq(&view.rows[1], &retained[1]));
    });
    cx.update(|window, cx| window.draw(cx).clear(cx));
    let select = cx.debug_bounds("minimum-level").unwrap();
    cx.simulate_click(select.center(), Modifiers::default());
    cx.run_until_parked();
    cx.update(|window, cx| window.draw(cx).clear(cx));
    let warn = cx.debug_bounds("level-option-3").unwrap();
    cx.simulate_click(warn.center(), Modifiers::default());
    cx.executor().advance_clock(Duration::from_millis(250));
    cx.run_until_parked();
    view.read_with(cx, |view, _| {
        assert!(!view.following);
        assert_eq!(view.minimum, Level::WARN);
        assert_eq!(view.rows.len(), 1);
        assert!(Arc::ptr_eq(&view.rows[0], &retained[0]));
        assert_eq!(view.dropped, 17);
        assert_eq!(view.retained.len(), retained.len());
        assert!(
            view.retained
                .iter()
                .zip(&retained)
                .all(|(a, b)| Arc::ptr_eq(a, b))
        );
    });
}

#[gpui::test]
fn copy_uses_current_query_and_levels_before_rows_refresh(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = LogWindow::new(window, cx);
        view.following = false;
        view.generation = Some(diagnostics::generation());
        view.retained = records();
        // The visible rows deliberately omit the record the current filter wants.
        view.rows = vec![view.retained[2].clone()];
        view.scroll.reset(view.rows.len());
        view.dropped = 23;
        view
    });
    cx.run_until_parked();
    view.update(cx, |view, cx| {
        view.search
            .update(cx, |input, cx| input.set_text_selected("SLOW", cx));
        view.minimum = Level::WARN;
        assert_eq!(view.rows[0].message, "unrelated message");
        view.share(false, cx);
        assert!(view.exporting);
    });
    cx.run_until_parked();
    cx.update(|_, cx| {
        let text = cx.read_from_clipboard().unwrap().text().unwrap();
        let metadata: serde_json::Value =
            serde_json::from_str(text.lines().next().unwrap()).unwrap();
        assert_eq!(metadata["dropped"], 23);
        let rows = exported_records(&text);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].message, "slow paint elapsed_ms=32");
        assert_eq!(rows[0].level, Level::WARN);
        assert!(!view.read(cx).exporting);
        assert_eq!(
            view.read(cx).status,
            "Filtered logs copied. Review before sharing."
        );
    });
}

#[gpui::test]
fn shortcuts_focus_search_and_close_only_log_window(cx: &mut TestAppContext) {
    let other = cx.add_window(|_, cx| SearchInput::new(cx));
    let (view, cx) = cx.add_window_view(|window, cx| {
        crate::bind_keys(cx);
        LogWindow::new(window, cx)
    });
    cx.update(|window, cx| {
        window.focus(&view.read(cx).focus.clone(), cx);
        window.draw(cx).clear(cx);
        assert!(!view.read(cx).search.read(cx).focus.is_focused(window));
    });
    cx.simulate_keystrokes("cmd-f");
    cx.update(|window, cx| assert!(view.read(cx).search.read(cx).focus.is_focused(window)));
    cx.simulate_keystrokes("cmd-w");
    assert!(cx.windows() == vec![other.into()]);
}

#[gpui::test]
fn log_window_is_singleton(cx: &mut TestAppContext) {
    cx.update(|cx| {
        open(cx);
        open(cx);
    });
    cx.update(|cx| {
        assert_eq!(cx.windows().len(), 1);
        let handle = cx.default_global::<LogWindowHandle>().0;
        if let Some(handle) = handle {
            assert!(handle.update(cx, |_, _, cx| open(cx)).is_ok());
        }
    });
    cx.update(|cx| assert_eq!(cx.windows().len(), 1));
}
#[test]
fn search_levels_and_export_preserve_full_lines() {
    let records = vec![
        Arc::new(Record::fixture(Level::WARN, "slow paint elapsed_ms=32")),
        Arc::new(Record::fixture(Level::TRACE, "connected")),
    ];
    let rows = filtered(records.clone(), "SLOW", Level::TRACE);
    assert_eq!(rows.len(), 1);
    let text = export_text(&rows, 7).unwrap();
    assert!(text.contains("\"dropped\":7"));
    assert_eq!(exported_records(&text)[0], *rows[0]);
    assert!(filtered(records, "", Level::ERROR).is_empty());
}

fn exported_records(text: &str) -> Vec<Record> {
    text.lines()
        .skip(1)
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

#[test]
fn structured_filters_and_minimum_severity_apply_to_json_exports() {
    let records: Vec<_> = LEVELS
        .iter()
        .map(|level| {
            let mut record = Record::fixture(*level, "paint finished");
            record.namespace = "herdr_gpui".into();
            record.target = "herdr_gpui::terminal_painter".into();
            record.fields.insert("elapsed_ms".into(), 32.into());
            Arc::new(record)
        })
        .collect();
    for (index, minimum) in LEVELS.iter().enumerate() {
        let rows = filtered(
            records.clone(),
            "namespace:HERDR_GPUI target:terminal_painter elapsed_ms=32 finished",
            *minimum,
        );
        assert_eq!(rows.len(), 5 - index);
        assert_eq!(rows[0].level, *minimum);
        let exported = exported_records(&export_text(&rows, 0).unwrap());
        assert_eq!(exported.len(), 5 - index);
        assert_eq!(exported[0].fields["elapsed_ms"], 32);
    }
    // Matching strings in message/fields must not satisfy structured filters.
    let mut impostor = Record::fixture(Level::ERROR, "herdr_gpui::terminal_painter");
    impostor.namespace = "herdr_client".into();
    impostor.target = "herdr_client::worker".into();
    let records = vec![Arc::new(impostor)];
    assert!(filtered(records.clone(), "namespace:herdr_gpui", Level::TRACE).is_empty());
    assert!(filtered(records.clone(), "target:terminal_painter", Level::TRACE).is_empty());
    assert_eq!(filtered(records, "terminal_painter", Level::TRACE).len(), 1);
    assert!(filtered(Vec::new(), "", Level::TRACE).is_empty());
    let empty = export_text(&[], 0).unwrap();
    assert_eq!(empty.lines().count(), 1);
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(empty.trim()).unwrap()["type"],
        "metadata"
    );
}

#[gpui::test]
fn level_dropdown_keyboard_dismissal_focus_and_input_isolation(cx: &mut TestAppContext) {
    cx.update(|cx| cx.bind_keys(key_bindings()));
    let (view, cx) = cx.add_window_view(LogWindow::new);
    cx.simulate_resize(size(px(620.), px(360.)));
    cx.run_until_parked();
    cx.simulate_keystrokes("cmd-l enter");
    cx.run_until_parked();
    cx.update(|window, cx| {
        window.draw(cx).clear(cx);
        assert!(view.read(cx).menu_focus.is_focused(window));
    });
    let menu = cx.debug_bounds("level-menu").unwrap();
    assert!(menu.left() >= px(0.) && menu.right() <= px(620.));
    assert!(menu.top() >= px(0.) && menu.bottom() <= px(360.));
    cx.simulate_keystrokes("down down enter");
    cx.update(|window, cx| {
        let view = view.read(cx);
        assert_eq!(view.minimum, Level::INFO);
        assert!(view.level_menu.is_none());
        assert!(view.level_focus.is_focused(window));
    });
    cx.simulate_keystrokes("enter down x escape");
    cx.update(|window, cx| {
        let view = view.read(cx);
        assert_eq!(view.minimum, Level::INFO);
        assert!(view.level_menu.is_none());
        assert_eq!(view.search.read(cx).text(), "");
        assert!(view.level_focus.is_focused(window));
    });
    cx.simulate_keystrokes("enter end home down enter");
    view.read_with(cx, |view, _| assert_eq!(view.minimum, Level::DEBUG));
    cx.simulate_keystrokes("enter");
    cx.run_until_parked();
    cx.update(|window, cx| window.draw(cx).clear(cx));
    cx.simulate_click(point(px(600.), px(340.)), Modifiers::default());
    view.read_with(cx, |view, _| assert!(view.level_menu.is_none()));
    cx.simulate_keystrokes("shift-tab");
    cx.update(|window, cx| assert!(view.read(cx).search.read(cx).focus.is_focused(window)));
}
