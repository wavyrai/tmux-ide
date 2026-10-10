use super::*;
use crate::config::SidebarOverrides;

/// Where things landed in a two-host sidebar whose first local workspace is
/// `herdr` and whose worktree group holds `sidebar-child`.
struct Measure {
    workspace: f32,
    worktree: f32,
    row_height: f32,
}

fn draw(
    cx: &mut gpui::TestAppContext,
    mode: crate::config::LayoutMode,
    overrides: SidebarOverrides,
) -> Measure {
    let (_fixture, cx) = cx.add_window_view(|window, cx| {
        let view = cx.new(|cx| {
            let mut view = fixture_window(window, cx);
            view.config.layout.mode = mode;
            view.config.sidebar_style.overrides = overrides;
            let mut remote = crate::endpoint::Endpoint::new(
                "ssh:test".into(),
                "Remote".into(),
                ConnectTarget::Ssh {
                    target: "unused".into(),
                    session: "default".into(),
                },
                true,
            );
            remote.live.snapshot = view.live.snapshot.clone();
            view.endpoints.push(remote);
            view
        });
        cx.observe(&view, |_, _, cx| cx.notify()).detach();
        SidebarFixture(view)
    });
    cx.simulate_resize(size(px(800.), px(600.)));
    cx.run_until_parked();
    cx.update(|window, cx| full_draw(window, cx).clear(cx));
    Measure {
        workspace: left(cx, "name-herdr"),
        worktree: left(cx, "name-sidebar-child"),
        row_height: f32::from(cx.debug_bounds("workspace-local-w0").unwrap().size.height),
    }
}

fn left(cx: &mut gpui::VisualTestContext, selector: &'static str) -> f32 {
    f32::from(
        cx.debug_bounds(selector)
            .unwrap_or_else(|| panic!("missing {selector}"))
            .left(),
    )
}

/// `indent` sets how far each nesting level steps in, in every layout:
/// workspaces move by it, and worktrees, nested twice, by double. Labels
/// are measured against the same row at `indent = 0`, since a parent's
/// icon slot puts its label further right than a child's.
#[gpui::test]
fn indent_override_sets_every_nesting_level(cx: &mut gpui::TestAppContext) {
    for mode in crate::config::LayoutMode::ALL {
        let flat = draw(
            cx,
            mode,
            SidebarOverrides {
                indent: Some(0.),
                ..SidebarOverrides::default()
            },
        );
        let wide = draw(
            cx,
            mode,
            SidebarOverrides {
                indent: Some(40.),
                ..SidebarOverrides::default()
            },
        );
        assert_eq!(
            wide.workspace - flat.workspace,
            40.,
            "{mode}: workspaces step in by indent"
        );
        assert_eq!(
            wide.worktree - flat.worktree,
            80.,
            "{mode}: worktrees step in by indent twice"
        );
    }
}

/// Vertical spacing keys grow a row's height by what they add, and the gap
/// moves the label away from its status dot; neither touches the other.
#[gpui::test]
fn padding_and_gap_overrides_change_row_geometry(cx: &mut gpui::TestAppContext) {
    let mode = crate::config::LayoutMode::default();
    let base = draw(cx, mode, SidebarOverrides::default());
    let padded = draw(
        cx,
        mode,
        SidebarOverrides {
            row_padding: Some(6.),
            ..SidebarOverrides::default()
        },
    );
    assert_eq!(padded.row_height - base.row_height, 12.);
    assert_eq!(padded.workspace, base.workspace);
    let gapped = draw(
        cx,
        mode,
        SidebarOverrides {
            gap: Some(20.),
            ..SidebarOverrides::default()
        },
    );
    // The normal preset's gap is 6.
    assert_eq!(gapped.workspace - base.workspace, 14.);
    assert_eq!(gapped.row_height, base.row_height);
}

/// The band's extremes leave no room between a parent's label column and a
/// child's dot. Then the flat layouts draw no tree lines at all, instead of a
/// box with a negative width, and a comfortable indent keeps them.
#[gpui::test]
fn tree_lines_give_way_when_the_indent_leaves_no_room(cx: &mut gpui::TestAppContext) {
    let mode = crate::config::LayoutMode::default();
    for (indent, gap) in [(0., None), (24., Some(32.)), (16., Some(8.))] {
        let overrides = SidebarOverrides {
            indent: Some(indent),
            gap,
            ..SidebarOverrides::default()
        };
        let (_fixture, cx) = cx.add_window_view(|window, cx| {
            let view = cx.new(|cx| {
                let mut view = fixture_window(window, cx);
                view.config.layout.mode = mode;
                view.config.sidebar_style.overrides = overrides;
                view
            });
            cx.observe(&view, |_, _, cx| cx.notify()).detach();
            SidebarFixture(view)
        });
        cx.simulate_resize(size(px(800.), px(600.)));
        cx.run_until_parked();
        cx.update(|window, cx| full_draw(window, cx).clear(cx));
        assert!(cx.debug_bounds("name-sidebar-child").is_some());
        assert!(
            cx.debug_bounds("tree-sidebar-child")
                .is_none_or(|tree| tree.size.width > px(0.)),
            "indent {indent}, gap {gap:?}: tree box has no width"
        );
    }
    let (_fixture, cx) = cx.add_window_view(|window, cx| {
        let view = cx.new(|cx| {
            let mut view = fixture_window(window, cx);
            view.config.layout.mode = mode;
            view.config.sidebar_style.overrides = SidebarOverrides {
                indent: Some(40.),
                ..SidebarOverrides::default()
            };
            view
        });
        cx.observe(&view, |_, _, cx| cx.notify()).detach();
        SidebarFixture(view)
    });
    cx.simulate_resize(size(px(800.), px(600.)));
    cx.run_until_parked();
    cx.update(|window, cx| full_draw(window, cx).clear(cx));
    let tree = cx
        .debug_bounds("tree-sidebar-child")
        .unwrap_or_else(|| panic!("a wide indent keeps tree lines"));
    assert!(tree.size.width > px(0.));
}
