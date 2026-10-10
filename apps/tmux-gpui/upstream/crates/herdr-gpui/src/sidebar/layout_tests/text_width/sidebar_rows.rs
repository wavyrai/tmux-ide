//! Initial text allocation, row geometry, divider resize, collapse toggling,
//! and scaled row checks.
use super::*;
use gpui::{MouseButton, MouseDownEvent};

pub(super) fn check_text_allocation(cx: &mut gpui::VisualTestContext) {
    cx.simulate_resize(size(px(800.), px(600.)));
    cx.run_until_parked();
    cx.update(|window, cx| {
        let _ = full_draw(window, cx);
    });

    cx.update(|_, cx| {
        for (input, (bounds, rendered, width)) in &cx.global::<TextProbes>().0 {
            eprintln!(
                "text {input:?}: bounds={bounds:?}, rendered={rendered:?}, glyph width={width:?}"
            );
            assert!(
                *width <= bounds.size.width,
                "glyphs must fit the allocation"
            );
        }
        // Each part of an agent's line is painted on its own, so the tab can
        // stay muted beside its workspace.
        for input in ["herdr", "main", "tab 1", "Claude Code"] {
            let (bounds, rendered, _) = &cx.global::<TextProbes>().0[input];
            assert_eq!(
                rendered, input,
                "short label must not ellipsize: {bounds:?}"
            );
        }
        for input in [
            "herdr-gpui-sidebar-rendering-regression-investigation",
            "fix/sidebar-label-width-and-overflow-regression",
        ] {
            let (bounds, rendered, width) = &cx.global::<TextProbes>().0[input];
            assert!(bounds.size.width > px(150.));
            assert!(*width > px(150.), "long labels must use available width");
            assert_eq!(bounds.size.height, px(16.));
            assert!(
                rendered.ends_with('\u{2026}'),
                "long label must ellipsize: {rendered:?}"
            );
            let prefix = rendered.trim_end_matches('\u{2026}');
            assert!(prefix.len() > 10 && input.starts_with(prefix));
            assert!(rendered.len() < input.len());
            assert!(!rendered.contains('\n'));
        }
    });
}

pub(super) fn check_row_geometry(cx: &mut gpui::VisualTestContext) {
    let sidebar = cx.debug_bounds("sidebar").unwrap();
    let spaces = cx.debug_bounds("spaces-scroll").unwrap();
    let agents = cx.debug_bounds("agents-scroll").unwrap();
    assert_eq!(sidebar.size.width, px(232.));
    let icon = cx.debug_bounds("github-herdr").unwrap();
    let title = cx.debug_bounds("name-herdr").unwrap();
    let detail = cx.debug_bounds("detail-herdr").unwrap();
    assert_eq!(icon.size, size(px(12.), px(12.)));
    assert_eq!(title.left(), icon.right() + px(6.));
    assert_eq!(icon.left(), detail.left());
    assert_eq!(title.right(), detail.right());
    assert!(cx.debug_bounds("github-agent-launcher").is_some());
    assert!(cx.debug_bounds("github-sidebar-child").is_none());
    assert!(cx.debug_bounds("github-review").is_none());
    let footer = cx.debug_bounds("device-footer").unwrap();
    assert!(spaces.size.height + footer.size.height / 2. > px(200.));
    assert!(agents.size.height + footer.size.height / 2. > px(200.));
    assert!(agents.bottom() <= footer.top());
    let parent = cx.debug_bounds("name-agent-launcher").unwrap();
    for (name, detail) in [
        ("name-sidebar-child", "detail-sidebar-child"),
        (
            "name-sidebar-child-with-a-long-readable-branch-name",
            "detail-sidebar-child-with-a-long-readable-branch-name",
        ),
    ] {
        let name = cx.debug_bounds(name).unwrap();
        let detail = cx.debug_bounds(detail).unwrap();
        assert_eq!(
            name.left(),
            parent.left() + px(crate::sidebar::CHILD_INDENT - crate::sidebar::ICON_RESERVE)
        );
        assert_eq!(
            name.size.width,
            px(crate::sidebar::LABEL_WIDTH
                - crate::sidebar::CHILD_INDENT
                - crate::sidebar::ARROW_RESERVE)
        );
        assert_eq!(name.right(), parent.right());
        assert_eq!(detail.size.width, name.size.width);
        assert_eq!(name.size.height, px(16.));
    }

    for (row, column, name, detail) in [
        ("row-herdr", "column-herdr", "name-herdr", "detail-herdr"),
        (
            "row-herdr-gpui-sidebar-rendering-regression-investigation",
            "column-herdr-gpui-sidebar-rendering-regression-investigation",
            "name-herdr-gpui-sidebar-rendering-regression-investigation",
            "detail-herdr-gpui-sidebar-rendering-regression-investigation",
        ),
        (
            "row-agent-p0",
            "column-agent-p0",
            "name-agent-p0",
            "detail-agent-p0",
        ),
        (
            "row-agent-p1",
            "column-agent-p1",
            "name-agent-p1",
            "detail-agent-p1",
        ),
    ] {
        let row_bounds = cx.debug_bounds(row).unwrap();
        let column_bounds = cx.debug_bounds(column).unwrap();
        let name_bounds = cx.debug_bounds(name).unwrap();
        let detail_bounds = cx.debug_bounds(detail).unwrap();
        eprintln!(
            "{row}: row={row_bounds:?}, column={column_bounds:?}, name={name_bounds:?}, detail={detail_bounds:?}"
        );
        assert!(name_bounds.size.width > px(150.), "{name}: {name_bounds:?}");
        assert!(
            detail_bounds.size.width > px(150.),
            "{detail}: {detail_bounds:?}"
        );
        assert_eq!(name_bounds.size.height, px(16.), "single-line name");
        assert_eq!(detail_bounds.size.height, px(16.), "single-line detail");
        assert_eq!(row_bounds.size.height, px(40.));
        assert!(name_bounds.right() <= sidebar.right() - px(12.));
        assert!(detail_bounds.right() <= sidebar.right() - px(12.));
        assert!(
            row_bounds.bottom() <= sidebar.bottom(),
            "visible initial rows"
        );
    }
}

pub(super) fn check_sidebar_resize(
    fixture: &Entity<SidebarFixture>,
    cx: &mut gpui::VisualTestContext,
) {
    // Drag beyond the divider, then back to a narrower allocation. Text must
    // be remeasured in both directions rather than retaining truncated runs.
    for target in [400., 160., 480.] {
        let divider = cx.debug_bounds("sidebar-resize").unwrap();
        let start = divider.center();
        let old_width = cx.debug_bounds("sidebar").unwrap().size.width;
        let end = point(start.x + px(target) - old_width, start.y);
        cx.simulate_mouse_down(start, MouseButton::Left, Modifiers::default());
        cx.simulate_mouse_move(end, MouseButton::Left, Modifiers::default());
        cx.simulate_mouse_up(end, MouseButton::Left, Modifiers::default());
        cx.update(|window, cx| {
            fixture.update(cx, |_, cx| cx.notify());
            let _ = full_draw(window, cx);
        });
        assert_eq!(cx.debug_bounds("sidebar").unwrap().size.width, px(target));
        let label = cx.debug_bounds("name-herdr").unwrap();
        assert_eq!(
            label.size.width,
            px(crate::sidebar::LABEL_WIDTH + target - 232. - crate::sidebar::ICON_RESERVE)
        );
        let parent = cx.debug_bounds("name-agent-launcher").unwrap();
        let child = cx.debug_bounds("name-sidebar-child").unwrap();
        assert_eq!(
            parent.size.width,
            label.size.width - px(crate::sidebar::ARROW_RESERVE)
        );
        assert_eq!(
            child.size.width,
            parent.size.width - px(crate::sidebar::CHILD_INDENT) + px(crate::sidebar::ICON_RESERVE)
        );
        assert_eq!(child.right(), parent.right());
        cx.update(|_, cx| {
            for (text, (bounds, rendered, glyph_width)) in &cx.global::<TextProbes>().0 {
                // GPUI rounds available text width to physical pixels.
                assert!(*glyph_width <= bounds.size.width + px(1.), "width={target}, text={text:?}, rendered={rendered:?}, bounds={bounds:?}, glyphs={glyph_width:?}");
            }
        });
        cx.simulate_mouse_move(point(px(600.), start.y), None, Modifiers::default());
        cx.update(|window, cx| {
            fixture.update(cx, |_, cx| cx.notify());
            let _ = full_draw(window, cx);
        });
        assert_eq!(cx.debug_bounds("sidebar").unwrap().size.width, px(target));
    }
    cx.simulate_resize(size(px(640.), px(600.)));
    cx.update(|window, cx| {
        let _ = full_draw(window, cx);
    });
    assert_eq!(cx.debug_bounds("sidebar").unwrap().size.width, px(400.));
    cx.simulate_resize(size(px(800.), px(600.)));
    cx.update(|window, cx| {
        let _ = full_draw(window, cx);
    });
    assert_eq!(cx.debug_bounds("sidebar").unwrap().size.width, px(480.));

    let position = cx.debug_bounds("sidebar-resize").unwrap().center();
    cx.simulate_event(MouseDownEvent {
        position,
        button: MouseButton::Left,
        click_count: 2,
        ..Default::default()
    });
    cx.update(|window, cx| {
        fixture.update(cx, |_, cx| cx.notify());
        let _ = full_draw(window, cx);
    });
    assert_eq!(cx.debug_bounds("sidebar").unwrap().size.width, px(232.));
}

pub(super) fn check_collapse_toggle(
    view: &Entity<HerdrWindow>,
    cx: &mut gpui::VisualTestContext,
) -> ClientShellSnapshot {
    let before = cx.update(|_, cx| {
        view.update(cx, |view, _| {
            let snapshot = Arc::make_mut(view.live.snapshot.as_mut().unwrap());
            snapshot.focused_workspace_id = Some("w4".into());
            for workspace in &mut snapshot.workspaces {
                workspace.focused = workspace.workspace_id == "w4";
            }
            view.marked = "selection must survive toggle".into();
            snapshot.clone()
        })
    });
    for collapsed in [true, false] {
        let arrow = cx.debug_bounds("collapse-3").unwrap();
        cx.simulate_click(arrow.center(), Default::default());
        cx.update(|window, cx| {
            cx.default_global::<TextProbes>().0.clear();
            window.refresh();
            full_draw(window, cx).clear(cx);
            let view = view.read(cx);
            assert_eq!(view.live.snapshot.as_deref(), Some(&before));
            assert_eq!(view.marked, "selection must survive toggle");
            assert!(cx.global::<TextProbes>().0.contains_key(if collapsed {
                "\u{25b8}"
            } else {
                "\u{25be}"
            }));
            assert_eq!(view.collapsed_repos.contains(REPO_KEY), collapsed);
            assert_eq!(
                !cx.global::<TextProbes>().0.contains_key("sidebar-child"),
                collapsed
            );
        });
    }
    before
}

pub(super) fn check_scaled_sidebar(view: &Entity<HerdrWindow>, cx: &mut gpui::VisualTestContext) {
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.config.sidebar.size = 24.;
            view.marked = "composition".into();
            view.open_keybinds(window, cx);
            assert!(view.marked.is_empty());
        });
        full_draw(window, cx).clear(cx);
        assert!(!view.read(cx).focus.is_focused(window));
    });
    let line_height = cx.update(|_, cx| crate::sidebar::line_height(&view.read(cx).config.sidebar));
    assert_eq!(
        cx.debug_bounds("row-herdr").unwrap().size.height,
        px(2. * line_height + 8.)
    );
    assert_eq!(
        cx.debug_bounds("name-herdr").unwrap().size.height,
        px(line_height)
    );
    let title = cx.debug_bounds("name-herdr").unwrap();
    let detail = cx.debug_bounds("detail-herdr").unwrap();
    let icon = cx.debug_bounds("github-herdr").unwrap();
    assert_eq!(title.bottom(), detail.top());
    assert_eq!(detail.size.height, px(line_height));
    assert_eq!(
        title.size.width,
        px(crate::sidebar::LABEL_WIDTH - crate::sidebar::ICON_RESERVE)
    );
    assert_eq!(title.right(), detail.right());
    assert_eq!(icon.center().y, title.center().y);
    cx.simulate_keystrokes("escape");
    cx.update(|window, cx| assert!(view.read(cx).focus.is_focused(window)));
}
