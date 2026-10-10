use super::*;

/// The label column of the first workspace row, after a full draw.
fn name_left(cx: &mut gpui::VisualTestContext, selector: &'static str) -> Pixels {
    cx.simulate_resize(size(px(800.), px(600.)));
    cx.run_until_parked();
    cx.update(|window, cx| full_draw(window, cx).clear(cx));
    cx.debug_bounds(selector)
        .unwrap_or_else(|| panic!("missing {selector}"))
        .left()
}

fn remote_endpoint(view: &HerdrWindow) -> crate::endpoint::Endpoint {
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
    let snapshot = Arc::make_mut(remote.live.snapshot.as_mut().unwrap());
    snapshot.workspaces[0].label = "remote workspace".into();
    remote
}

/// With host headers on screen, every workspace row steps in under its host;
/// a single-host sidebar has no header to nest under and keeps its column.
#[gpui::test]
fn workspaces_nest_under_their_host_in_every_layout(cx: &mut gpui::TestAppContext) {
    for mode in crate::config::LayoutMode::ALL {
        let (_single, cx_single) = cx.add_window_view(|window, cx| {
            let view = cx.new(|cx| {
                let mut view = fixture_window(window, cx);
                view.config.layout.mode = mode;
                view
            });
            cx.observe(&view, |_, _, cx| cx.notify()).detach();
            SidebarFixture(view)
        });
        let alone = name_left(cx_single, "name-herdr");

        let (_multi, cx_multi) = cx.add_window_view(|window, cx| {
            let view = cx.new(|cx| {
                let mut view = fixture_window(window, cx);
                view.config.layout.mode = mode;
                let remote = remote_endpoint(&view);
                view.endpoints.push(remote);
                view
            });
            cx.observe(&view, |_, _, cx| cx.notify()).detach();
            SidebarFixture(view)
        });
        let local = name_left(cx_multi, "name-herdr");
        let remote = name_left(cx_multi, "name-remote workspace");
        assert!(
            local > alone,
            "{mode}: nested {local:?} should sit right of unnested {alone:?}"
        );
        assert_eq!(local, remote, "{mode}: every host nests its rows alike");
    }
}

/// A narrow sidebar with two hosts: every row gives up the host indent, and a
/// worktree child its own on top, yet the child stays stepped in under its
/// repository and its row and label stay inside the sidebar in every layout.
#[gpui::test]
fn nested_worktree_rows_fit_a_narrow_sidebar(cx: &mut gpui::TestAppContext) {
    let (view, cx) = cx.add_window_view(|window, cx| {
        let view = cx.new(|cx| {
            let mut view = fixture_window(window, cx);
            // Few enough rows per host that the remote host's child is on
            // screen below the local host's rows.
            view.live.snapshot = Some(Arc::new(snapshot(6)));
            let mut remote = remote_endpoint(&view);
            let snapshot = Arc::make_mut(remote.live.snapshot.as_mut().unwrap());
            // Its own branch name, so the row's selector is not the local
            // host's, and long enough to overflow 160 px on its own.
            snapshot.workspaces[4].branch =
                Some("worktree/remote-child-with-a-long-readable-branch-name".into());
            view.endpoints.push(remote);
            view
        });
        cx.observe(&view, |_, _, cx| cx.notify()).detach();
        SidebarFixture(view)
    });
    cx.simulate_resize(size(px(800.), px(900.)));
    cx.run_until_parked();
    for mode in crate::config::LayoutMode::ALL {
        view.update(cx, |fixture, cx| {
            fixture.0.update(cx, |view, cx| {
                view.config.layout.mode = mode;
                view.sidebar_width = Some(160.);
                cx.notify();
            });
        });
        cx.update(|window, cx| full_draw(window, cx).clear(cx));
        let context = format!("{mode} at 160px");
        let sidebar = cx.debug_bounds("sidebar").unwrap();
        let mut bounds = |selector: &'static str| {
            cx.debug_bounds(selector)
                .unwrap_or_else(|| panic!("{context}: {selector} missing"))
        };
        // Roots of both repositories share a column, so the remote host's
        // first workspace stands in for the child's own repository row.
        let parent = bounds("name-remote workspace");
        // With several hosts a row is selected by its host and id.
        let row = bounds("workspace-ssh:test-w4");
        let name = bounds("name-remote-child-with-a-long-readable-branch-name");
        assert!(
            name.left() > parent.left(),
            "{context}: child {name:?} should step in under {parent:?}"
        );
        assert!(
            row.right() <= sidebar.right(),
            "{context}: {row:?} spills past {sidebar:?}"
        );
        assert!(
            name.right() <= row.right(),
            "{context}: {name:?} spills past {row:?}"
        );
        assert!(
            name.bottom() <= row.bottom(),
            "{context}: {name:?} below {row:?}"
        );
    }
}
