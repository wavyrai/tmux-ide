use super::*;

/// [`snapshot`] with the main checkout behind its upstream, one child
/// diverged, and another in sync.
#[cfg(test)]
fn snapshot_with_upstream() -> ClientShellSnapshot {
    let mut snapshot = snapshot(6);
    for (index, counts) in [(0, (0, 18)), (4, (2, 3)), (5, (0, 0))] {
        snapshot.workspaces[index].git_ahead_behind = Some(counts);
    }
    snapshot
}

#[cfg(test)]
/// Every layout keeps its text inside the box it was measured for and its
/// rows inside the sidebar, and marks the focused row.
fn check_layouts(modes: &[crate::config::LayoutMode], cx: &mut gpui::TestAppContext) {
    use crate::config::LayoutMode;
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = fixture_window(window, cx);
        view.live.snapshot = Some(Arc::new(snapshot_with_upstream()));
        let input = crate::pull_request::Input {
            checkout: None,
            repo_key: Some(REPO_KEY.into()),
            branch: "worktree/sidebar-child".into(),
        };
        let now = std::time::Instant::now();
        let mut pr = crate::pull_request::fixture().unwrap();
        pr.number = 7;
        pr.additions = 234;
        pr.deletions = 567;
        view.menu.pr_cache.seed(input.clone(), pr, now);
        view.git.seed_probe(input, true, now);
        // Its work was teleported away, so the row carries that mark too.
        view.teleport_marks.add(crate::teleport::Mark {
            endpoint: crate::endpoint::LOCAL.into(),
            repo_key: REPO_KEY.into(),
            branch: "worktree/sidebar-child".into(),
            destination: crate::teleport::MarkDestination {
                endpoint: "ssh:box".into(),
                label: "box".into(),
                repo_key: "/home/me/agent-launcher/.git".into(),
                workspace_id: "w9".into(),
            },
        });
        // And a note, marked and read under the row.
        crate::worktree_notes::Notes::update(cx, |notes| {
            notes.set(
                crate::worktree_notes::Checkout {
                    endpoint: crate::endpoint::LOCAL.into(),
                    repo_key: REPO_KEY.into(),
                    branch: "worktree/sidebar-child".into(),
                },
                "wait for the FX rates PR before rebasing onto main",
            )
        });
        view
    });
    cx.simulate_resize(size(px(800.), px(900.)));
    cx.run_until_parked();
    for font_size in [12., 18.] {
        for width in [160., 232., 480.] {
            for &mode in modes {
                view.update(cx, |view, cx| {
                    view.config.layout.mode = mode;
                    view.config.sidebar.size = font_size;
                    view.sidebar_width = Some(width);
                    cx.notify();
                });
                let context = format!("{mode} at {width}px, {font_size}pt");
                cx.update(|window, cx| {
                    cx.default_global::<TextProbes>().0.clear();
                    full_draw(window, cx).clear(cx);
                    let probes = &cx.global::<TextProbes>().0;
                    for text in ["herdr", "agent-launcher", "Claude Code"] {
                        assert!(probes.contains_key(text), "{context}: {text} missing");
                    }
                    for (text, (bounds, _, glyphs)) in probes {
                        // Headers and the device footer are not rows; the
                        // rows' own text must fit where it was placed.
                        // A box too narrow for an ellipsis clips instead;
                        // subpixel shaping may overhang a whole-pixel box.
                        assert!(
                            *glyphs <= bounds.size.width + px(1.)
                                || bounds.size.width < px(2. * font_size),
                            "{context}: {text:?} overflows {bounds:?} with {glyphs:?}"
                        );
                    }
                });
                let sidebar = cx.debug_bounds("sidebar").unwrap();
                for (row, name) in [
                    ("row-herdr", "name-herdr"),
                    ("row-agent-launcher", "name-agent-launcher"),
                    ("row-sidebar-child", "name-sidebar-child"),
                    ("row-agent-p0", "name-agent-p0"),
                ] {
                    let row_bounds = cx
                        .debug_bounds(row)
                        .unwrap_or_else(|| panic!("{context}: {row} missing"));
                    assert!(row_bounds.right() <= sidebar.right(), "{context}: {row}");
                    let name_bounds = cx.debug_bounds(name).unwrap();
                    assert!(
                        name_bounds.right() <= row_bounds.right(),
                        "{context}: {name}"
                    );
                    assert!(
                        name_bounds.bottom() <= row_bounds.bottom(),
                        "{context}: {name}"
                    );
                }
                // Minimal rows show no pull request or uncommitted work.
                if mode != LayoutMode::Minimal {
                    let row = cx.debug_bounds("row-sidebar-child").unwrap();
                    let badge = cx.debug_bounds("pr-sidebar-child").unwrap();
                    assert!(
                        badge.right() <= row.right(),
                        "{context}: badge {badge:?} {row:?}"
                    );
                    assert!(
                        badge.bottom() <= row.bottom(),
                        "{context}: badge {badge:?} {row:?}"
                    );
                    assert!(cx.debug_bounds("dirty-sidebar-child").is_some());
                }
                // Every layout reads the note on a line under its row.
                let row = cx.debug_bounds("row-sidebar-child").unwrap();
                let line = cx
                    .debug_bounds("note-line-local-w4")
                    .unwrap_or_else(|| panic!("{context}: no note line"));
                assert_eq!(line.top(), row.bottom(), "{context}: note line");
                assert!(line.right() <= sidebar.right(), "{context}: note line");
                // Minimal rows leave upstream counts off too; the rest keep
                // them inside the row, and never on a branch in sync.
                if mode != LayoutMode::Minimal {
                    for (key, row, upstream) in [
                        ("herdr", "row-herdr", "upstream-herdr"),
                        (
                            "sidebar-child",
                            "row-sidebar-child",
                            "upstream-sidebar-child",
                        ),
                    ] {
                        let row = cx.debug_bounds(row).unwrap();
                        let upstream = cx
                            .debug_bounds(upstream)
                            .unwrap_or_else(|| panic!("{context}: no upstream on {key}"));
                        assert!(upstream.right() <= row.right(), "{context}: {key}");
                        assert!(upstream.bottom() <= row.bottom(), "{context}: {key}");
                    }
                }
                assert!(
                    cx.debug_bounds("upstream-sidebar-child-with-a-long-readable-branch-name")
                        .is_none(),
                    "{context}"
                );
                // Every layout, Minimal included, marks a teleported checkout.
                let row = cx.debug_bounds("row-sidebar-child").unwrap();
                let teleported = cx
                    .debug_bounds("teleported-sidebar-child")
                    .unwrap_or_else(|| panic!("{context}: no teleported mark"));
                assert!(teleported.right() <= row.right(), "{context}");
                assert!(cx.debug_bounds("teleported-herdr").is_none(), "{context}");
                // Only the focused workspace draws a selection mark in the
                // layouts whose highlight exists only while selected.
                assert!(cx.debug_bounds("highlight-herdr").is_some() || mode == LayoutMode::Orca);
            }
        }
    }
}

#[gpui::test]
fn classic_layouts_fit_the_sidebar(cx: &mut gpui::TestAppContext) {
    check_layouts(&crate::config::LayoutMode::ALL[..6], cx);
}

#[gpui::test]
fn superset_layout_fits_the_sidebar(cx: &mut gpui::TestAppContext) {
    check_layouts(&[crate::config::LayoutMode::Superset], cx);
}

#[gpui::test]
fn orca_layout_fits_the_sidebar(cx: &mut gpui::TestAppContext) {
    check_layouts(&[crate::config::LayoutMode::Orca], cx);
}

#[gpui::test]
fn minimal_layout_fits_the_sidebar(cx: &mut gpui::TestAppContext) {
    check_layouts(&[crate::config::LayoutMode::Minimal], cx);
}

#[gpui::test]
fn sidebar_densities_keep_details_and_badges_within_their_rows(cx: &mut gpui::TestAppContext) {
    use crate::config::{Density, LayoutMode, Style};
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = fixture_window(window, cx);
        view.live.snapshot = Some(Arc::new(snapshot(6)));
        let input = crate::pull_request::Input {
            checkout: None,
            repo_key: Some(REPO_KEY.into()),
            branch: "worktree/sidebar-child".into(),
        };
        let now = std::time::Instant::now();
        let mut pr = crate::pull_request::fixture().unwrap();
        pr.number = 7;
        pr.additions = 234;
        pr.deletions = 567;
        view.menu.pr_cache.seed(input.clone(), pr, now);
        view.git.seed_probe(input, true, now);
        view
    });
    cx.simulate_resize(size(px(800.), px(900.)));
    cx.run_until_parked();
    for font_size in [12., 18.] {
        for width in [160., 232.] {
            // Switching density must restore the corresponding details and spacing.
            for mode in [Density::Compact, Density::Normal, Density::Comfortable]
                .into_iter()
                .flat_map(|density| {
                    [Style::Flat, Style::Rounded].map(|style| LayoutMode::new(density, style))
                })
            {
                let compact = mode.density() == Density::Compact;
                let comfortable = mode.density() == Density::Comfortable;
                let rounded = mode.style() == Style::Rounded;
                view.update(cx, |view, cx| {
                    view.config.layout.mode = mode;
                    view.config.sidebar.size = font_size;
                    view.sidebar_width = Some(width);
                    cx.notify();
                });
                cx.update(|window, cx| {
                    cx.default_global::<TextProbes>().0.clear();
                    window.refresh();
                    full_draw(window, cx).clear(cx);
                    let probes = &cx.global::<TextProbes>().0;
                    assert_eq!(probes.contains_key("main"), !compact);
                    for text in ["worktree/sidebar-child", "+234", "-567"] {
                        assert_eq!(probes.contains_key(text), comfortable, "{text}");
                    }
                    for text in ["Claude Code", "#7"] {
                        assert!(probes.contains_key(text), "{text}");
                    }
                });
                let line = font_size * 4. / 3.;
                let density_padding = match mode.density() {
                    Density::Compact => 6.,
                    Density::Normal => 8.,
                    Density::Comfortable => 12.,
                };
                // Rounded rows sit inside a highlight inset by the density's
                // gap, with a third of that gap as padding and twice it as
                // spacing between rows.
                let (inset, trim) = match (mode.style(), mode.density()) {
                    (Style::Flat, _) => (0., 0.),
                    (Style::Rounded, Density::Compact) => (4., 1.),
                    (Style::Rounded, Density::Normal) => (6., 2.),
                    (Style::Rounded, Density::Comfortable) => (8., 3.),
                };
                let padding = inset + density_padding;
                let vertical_padding = if comfortable { 4. } else { 0. } + trim;
                let spacing = 2. * trim;
                for (row, name, detail, highlight) in [
                    ("row-herdr", "name-herdr", "detail-herdr", "highlight-herdr"),
                    (
                        "row-agent-launcher",
                        "name-agent-launcher",
                        "detail-agent-launcher",
                        "highlight-agent-launcher",
                    ),
                    (
                        "row-sidebar-child",
                        "name-sidebar-child",
                        "detail-sidebar-child",
                        "highlight-sidebar-child",
                    ),
                    (
                        "row-agent-p0",
                        "name-agent-p0",
                        "detail-agent-p0",
                        "highlight-agent-p0",
                    ),
                ] {
                    let show_detail = row == "row-agent-p0"
                        || (!compact && (comfortable || row != "row-sidebar-child"));
                    let highlight = cx.debug_bounds(highlight).unwrap();
                    let row = cx.debug_bounds(row).unwrap();
                    let name = cx.debug_bounds(name).unwrap();
                    assert_eq!(
                        row.size.height,
                        px(line * if show_detail { 2. } else { 1. }
                            + 2. * vertical_padding
                            + spacing)
                    );
                    assert_eq!(name.top(), row.top() + px(vertical_padding + spacing / 2.));
                    // The highlight is the row less its inset and spacing, so a
                    // click between highlights still lands on a row.
                    assert_eq!(highlight.left(), row.left() + px(inset));
                    assert_eq!(highlight.right(), row.right() - px(inset));
                    assert_eq!(highlight.top(), row.top() + px(spacing / 2.));
                    assert_eq!(highlight.bottom(), row.bottom() - px(spacing / 2.));
                    assert!(name.right() <= row.right() - px(padding));
                    if show_detail {
                        assert!(cx.debug_bounds(detail).is_some());
                    }
                }
                let agent = cx.debug_bounds("row-agent-p0").unwrap();
                assert_eq!(
                    agent.size.height,
                    px(2. * line + 2. * vertical_padding + spacing)
                );
                assert!(cx.debug_bounds("detail-agent-p0").is_some());
                let row = cx.debug_bounds("row-sidebar-child").unwrap();
                let badge = cx.debug_bounds("pr-sidebar-child").unwrap();
                assert_eq!(badge.right(), row.right() - px(padding));
                assert!(badge.bottom() <= row.bottom());
                assert!(cx.debug_bounds("name-sidebar-child").unwrap().right() <= badge.left());
                assert!(cx.debug_bounds("dirty-sidebar-child").is_some());
                // Debug bounds outlive the element that recorded them, so a
                // rounded frame cannot prove tree lines absent here; see
                // `rounded_rows_drop_tree_lines_and_title_headers`.
                if !rounded {
                    let gutter = cx.debug_bounds("tree-sidebar-child").unwrap();
                    assert_eq!(
                        gutter.left(),
                        cx.debug_bounds("column-agent-launcher").unwrap().left()
                    );
                }
                let arrow = cx.debug_bounds("collapse-3").unwrap();
                let parent = cx.debug_bounds("row-agent-launcher").unwrap();
                assert!(arrow.top() >= parent.top() && arrow.bottom() <= parent.bottom());
            }
        }
    }
}

#[gpui::test]
fn rounded_rows_drop_tree_lines_and_title_headers(cx: &mut gpui::TestAppContext) {
    use crate::config::{Density, LayoutMode, Style};
    // A fresh window per mode: GPUI keeps debug bounds from earlier frames,
    // so absence is only observable when the element never rendered.
    for (style, header) in [(Style::Rounded, "Spaces"), (Style::Flat, "spaces")] {
        let (view, cx) = cx.add_window_view(|window, cx| {
            let mut view = fixture_window(window, cx);
            view.live.snapshot = Some(Arc::new(snapshot(6)));
            view.config.layout.mode = LayoutMode::new(Density::Normal, style);
            view
        });
        cx.simulate_resize(size(px(800.), px(900.)));
        cx.run_until_parked();
        cx.update(|window, cx| {
            full_draw(window, cx).clear(cx);
        });
        assert!(cx.debug_bounds("row-sidebar-child").is_some());
        assert_eq!(
            cx.debug_bounds("tree-sidebar-child").is_some(),
            style == Style::Flat
        );
        let heading = cx.debug_bounds("header-spaces").unwrap();
        let row = cx.debug_bounds("row-herdr").unwrap();
        let column = cx.debug_bounds("column-herdr").unwrap();
        // Headings start where rows' status dots do, inside the highlight.
        let label = cx.debug_bounds("header-label-spaces").unwrap();
        assert_eq!(label.left(), column.left() - px(8. + 6.));
        assert!(heading.left() <= row.left());
        cx.update(|window, cx| {
            cx.default_global::<TextProbes>().0.clear();
            full_draw(window, cx).clear(cx);
            assert!(
                cx.global::<TextProbes>().0.contains_key(header),
                "{header}: {:?}",
                cx.global::<TextProbes>().0.keys()
            );
        });
        // The row, not its highlight, is the click target: the inset beside a
        // rounded highlight still selects the row, so there are no dead zones.
        let row = cx.debug_bounds("row-agent-launcher").unwrap();
        let highlight = cx.debug_bounds("highlight-agent-launcher").unwrap();
        let margin = point(row.left() + px(2.), row.center().y);
        assert_eq!(highlight.contains(&margin), style == Style::Flat);
        view.read_with(cx, |view, _| assert!(view.pending_navigation.is_none()));
        cx.simulate_click(margin, Default::default());
        view.read_with(cx, |view, _| {
            assert_eq!(
                view.pending_navigation,
                Some(crate::NavigationTarget::Workspace("w3".into()))
            );
        });
    }
}

#[gpui::test]
fn choosing_a_layout_redraws_the_sidebar_and_saves_it(cx: &mut gpui::TestAppContext) {
    use crate::config::{Density, LayoutMode, Style};
    use std::sync::{Arc as SyncArc, Mutex};

    let (view, cx) = cx.add_window_view(fixture_window);
    cx.simulate_resize(size(px(800.), px(900.)));
    cx.update(|window, cx| full_draw(window, cx).clear(cx));
    assert!(cx.debug_bounds("icon-herdr").is_none());
    let saved = SyncArc::new(Mutex::new(Vec::new()));
    let compact = LayoutMode::new(Density::Compact, Style::Rounded);
    let modes = [LayoutMode::Superset, LayoutMode::Superset, compact];
    for mode in modes {
        let record = saved.clone();
        view.update(cx, |view, cx| {
            view.set_layout_with(
                mode,
                move |mode| {
                    record.lock().unwrap().push(mode);
                    Ok(())
                },
                cx,
            )
        });
        cx.run_until_parked();
        cx.update(|window, cx| full_draw(window, cx).clear(cx));
        view.read_with(cx, |view, _| assert_eq!(view.config.layout.mode, mode));
        if mode == LayoutMode::Superset {
            assert!(cx.debug_bounds("icon-herdr").is_some());
        }
    }
    // Choosing the layout already in use saves nothing.
    assert_eq!(*saved.lock().unwrap(), vec![modes[0], modes[2]]);
}

/// Every entry under View > Layout draws the sidebar its own way: no two
/// share the same row heights, name placement, and highlight.
#[gpui::test]
fn every_layout_looks_different(cx: &mut gpui::TestAppContext) {
    use crate::config::LayoutMode;
    let mut seen: Vec<(LayoutMode, Vec<Pixels>)> = Vec::new();
    for mode in LayoutMode::ALL {
        // A fresh window per layout: debug bounds outlive their elements.
        let (_, cx) = cx.add_window_view(|window, cx| {
            let mut view = fixture_window(window, cx);
            view.config.layout.mode = mode;
            view
        });
        cx.simulate_resize(size(px(800.), px(900.)));
        cx.update(|window, cx| full_draw(window, cx).clear(cx));
        let row = cx.debug_bounds("row-herdr").unwrap();
        let name = cx.debug_bounds("name-herdr").unwrap();
        let agent = cx.debug_bounds("row-agent-p0").unwrap();
        let highlight = cx
            .debug_bounds("highlight-herdr")
            .map_or(px(-1.), |h| h.left() - row.left());
        let signature = vec![
            row.size.height,
            agent.size.height,
            name.left() - row.left(),
            name.top() - row.top(),
            highlight,
        ];
        if let Some((other, _)) = seen.iter().find(|(_, other)| *other == signature) {
            panic!("{mode} draws the same as {other}: {signature:?}");
        }
        seen.push((mode, signature));
    }
}

#[gpui::test]
fn upstream_counts_follow_the_branch_or_trail_one_line_rows(cx: &mut gpui::TestAppContext) {
    use crate::config::{Density, LayoutMode, Style};
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = fixture_window(window, cx);
        view.live.snapshot = Some(Arc::new(snapshot_with_upstream()));
        view
    });
    cx.simulate_resize(size(px(800.), px(900.)));
    cx.run_until_parked();
    let draw = |density, cx: &mut gpui::VisualTestContext| {
        view.update(cx, |view, cx| {
            view.config.layout.mode = LayoutMode::Classic {
                density,
                style: Style::Flat,
            };
            view.sidebar_width = Some(320.);
            cx.notify();
        });
        cx.update(|window, cx| {
            cx.default_global::<TextProbes>().0.clear();
            full_draw(window, cx).clear(cx);
            let probes = &cx.global::<TextProbes>().0;
            assert!(probes.contains_key("\u{2193}18"), "{density:?}");
            assert!(probes.contains_key("\u{2191}2"), "{density:?}");
            assert!(probes.contains_key("\u{2193}3"), "{density:?}");
            assert!(!probes.contains_key("\u{2191}0"), "{density:?}");
        });
    };

    // Like the TUI's `main ↓18`: the counts sit right after the branch on
    // the repository's second line, not pushed to the row's edge.
    draw(Density::Normal, cx);
    let detail = cx.debug_bounds("detail-herdr").unwrap();
    let name = cx.debug_bounds("name-herdr").unwrap();
    let upstream = cx.debug_bounds("upstream-herdr").unwrap();
    assert!(upstream.top() >= name.bottom());
    assert!(upstream.left() >= detail.right());
    assert!(upstream.left() - detail.right() < px(20.));
    assert!(upstream.right() < cx.debug_bounds("row-herdr").unwrap().right() - px(100.));
    // A one-line worktree child keeps them in a trailing column instead.
    let child = cx.debug_bounds("name-sidebar-child").unwrap();
    let trailing = cx.debug_bounds("upstream-sidebar-child").unwrap();
    assert_eq!(trailing.top(), child.top());
    assert!(trailing.left() >= child.right());

    // Compact rows have no branch line, so the repository's counts trail
    // its name on the one line it has.
    draw(Density::Compact, cx);
    let name = cx.debug_bounds("name-herdr").unwrap();
    let upstream = cx.debug_bounds("upstream-herdr").unwrap();
    assert_eq!(upstream.top(), name.top());
    assert!(upstream.left() >= name.right());
    assert!(cx.debug_bounds("detail-herdr").is_none());
}
