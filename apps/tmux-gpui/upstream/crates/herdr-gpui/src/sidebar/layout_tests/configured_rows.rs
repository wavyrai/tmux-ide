use super::*;

#[gpui::test]
fn configured_sidebar_rows_render_all_lines_within_the_row(cx: &mut gpui::TestAppContext) {
    use crate::config::LayoutMode;
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = fixture_window(window, cx);
        view.live.snapshot = Some(Arc::new(snapshot(2)));
        view.config.sidebar_layout = toml::from_str(
            r#"
            [agents]
            rows = [["state_icon", "workspace"], ["agent"], ["state_text"]]
            [spaces]
            rows = [["workspace"], ["state_text"], ["branch"]]
        "#,
        )
        .unwrap();
        view
    });
    cx.simulate_resize(size(px(800.), px(900.)));
    cx.run_until_parked();
    for mode in LayoutMode::ALL {
        for width in [160., 320.] {
            view.update(cx, |view, cx| {
                view.config.layout.mode = mode;
                view.sidebar_width = Some(width);
                cx.notify();
            });
            cx.update(|window, cx| {
                cx.default_global::<TextProbes>().0.clear();
                full_draw(window, cx).clear(cx);
                let probes = &cx.global::<TextProbes>().0;
                for text in ["herdr", "Claude Code", "working", "main"] {
                    assert!(probes.contains_key(text), "{mode:?}: missing {text}");
                }
            });
            assert!(cx.debug_bounds("status-agent-p0").is_none());
            for (key, name, detail, last) in [
                ("row-herdr", "name-herdr", "detail-herdr", "line-herdr-2"),
                (
                    "row-agent-p0",
                    "name-agent-p0",
                    "detail-agent-p0",
                    "line-agent-p0-2",
                ),
            ] {
                let row = cx.debug_bounds(key).unwrap();
                let first = cx.debug_bounds(name).unwrap();
                let second = cx.debug_bounds(detail).unwrap();
                let third = cx.debug_bounds(last).unwrap();
                assert!(first.bottom() <= second.top(), "{mode:?}: {key}");
                assert!(second.bottom() <= third.top(), "{mode:?}: {key}");
                assert!(third.bottom() <= row.bottom(), "{mode:?}: {key}");
                for line in [first, second, third] {
                    assert!(line.left() >= row.left(), "{mode:?}: {key}");
                    assert!(line.right() <= row.right(), "{mode:?}: {key}");
                }
            }
        }
    }
}

/// Configured rows replace each layout's text, not its frame: Superset keeps
/// its icon slot, every layout grows with the configured lines, and a config
/// that does not lead with `state_icon` gives the status room to the text.
#[gpui::test]
fn configured_rows_keep_each_layouts_frame(cx: &mut gpui::TestAppContext) {
    use crate::config::LayoutMode;
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = fixture_window(window, cx);
        view.live.snapshot = Some(Arc::new(snapshot(2)));
        view.sidebar_width = Some(320.);
        view
    });
    cx.simulate_resize(size(px(800.), px(900.)));
    cx.run_until_parked();
    let configure = |rows: &str, view: &Entity<HerdrWindow>, cx: &mut gpui::VisualTestContext| {
        view.update(cx, |view, cx| {
            view.config.sidebar_layout =
                toml::from_str(&format!("[agents]\nrows = {rows}\n[spaces]\nrows = {rows}"))
                    .unwrap();
            cx.notify();
        });
        cx.run_until_parked();
    };
    for mode in [LayoutMode::Superset, LayoutMode::Orca, LayoutMode::Minimal] {
        view.update(cx, |view, cx| {
            view.config.layout.mode = mode;
            cx.notify();
        });
        configure(r#"[["state_icon", "workspace"]]"#, &view, cx);
        let one: Vec<_> = ["row-herdr", "row-agent-p0", "name-herdr", "name-agent-p0"]
            .map(|key| cx.debug_bounds(key).unwrap())
            .into();
        if mode == LayoutMode::Superset {
            for key in ["icon-herdr", "icon-agent-p0"] {
                assert!(cx.debug_bounds(key).is_some(), "{mode:?}: {key}");
            }
        }
        configure(
            r#"[["state_icon", "workspace"], ["workspace"], ["state_text"]]"#,
            &view,
            cx,
        );
        for (index, key) in ["row-herdr", "row-agent-p0"].into_iter().enumerate() {
            let three = cx.debug_bounds(key).unwrap();
            assert!(
                three.size.height > one[index].size.height,
                "{mode:?}: {key} did not grow"
            );
        }
        configure(r#"[["workspace"]]"#, &view, cx);
        for (index, key) in ["name-herdr", "name-agent-p0"].into_iter().enumerate() {
            let left = cx.debug_bounds(key).unwrap().left();
            let leading = one[index + 2].left();
            if mode == LayoutMode::Superset {
                assert_eq!(left, leading, "{mode:?}: {key} moved off the slot");
            } else {
                assert!(left < leading, "{mode:?}: {key} kept the status room");
            }
        }
    }
}

#[gpui::test]
fn empty_configured_rows_keep_only_the_upstream_fallback(cx: &mut gpui::TestAppContext) {
    let (view, cx) = cx.add_window_view(fixture_window);
    for rows in [
        "[]",
        "[[\"$missing\"]]",
        "[[{ token = \"workspace\", rules = [{ contains = \"\", hide = true }] }]]",
    ] {
        view.update(cx, |view, cx| {
            view.config.sidebar_layout =
                toml::from_str(&format!("[agents]\nrows = {rows}\n[spaces]\nrows = {rows}"))
                    .unwrap();
            cx.notify();
        });
        cx.update(|window, cx| {
            cx.default_global::<TextProbes>().0.clear();
            full_draw(window, cx).clear(cx);
            let probes = &cx.global::<TextProbes>().0;
            for text in ["herdr", "Claude Code", "main"] {
                assert!(!probes.contains_key(text), "{rows}: unexpected {text}");
            }
        });
        for key in ["row-herdr", "row-agent-p0"] {
            assert!(cx.debug_bounds(key).unwrap().size.height > px(0.));
        }
        assert!(cx.debug_bounds("detail-agent-p0").is_none());
    }
}

#[gpui::test]
fn configured_inline_status_is_centered_in_its_glyph_budget(cx: &mut gpui::TestAppContext) {
    let (view, cx) = cx.add_window_view(fixture_window);
    let tolerance = cx.update(|window, _| px(1. / window.scale_factor()));
    for (size, style) in [12., 20., 36.]
        .into_iter()
        .flat_map(|size| ["dots", "symbols"].map(|style| (size, style)))
    {
        view.update(cx, |view, cx| {
            view.config.sidebar.size = size;
            view.sidebar_width = Some(160.);
            view.settings.shared = Some(
                crate::herdr_settings::Settings::parse_text(&format!(
                    "[ui]\nstatus_indicators = '{style}'\n"
                ))
                .unwrap(),
            );
            view.config.sidebar_layout.agents =
                toml::from_str(r#"rows = [["workspace", "state_icon"]]"#).unwrap();
            cx.notify();
        });
        cx.run_until_parked();
        let cell = cx.debug_bounds("inline-status-cell").unwrap();
        let mark = cx.debug_bounds("inline-status-mark").unwrap();
        assert!(mark.size.width <= cell.size.width);
        assert_eq!(
            mark.size.width,
            px(if style == "symbols" {
                size
            } else {
                super::super::STATUS_WIDTH
            })
        );
        assert!(
            (cell.center().x - mark.center().x).abs() <= tolerance,
            "size={size}, cell={cell:?}, mark={mark:?}"
        );
        assert!(
            (cell.center().y - mark.center().y).abs() <= tolerance,
            "size={size}, cell={cell:?}, mark={mark:?}"
        );
    }
}
