use super::*;

#[gpui::test]
fn the_sidebar_follows_the_selection_without_undoing_manual_scrolling(
    cx: &mut gpui::TestAppContext,
) {
    let (fixture, cx) = cx.add_window_view(|window, cx| {
        let view = cx.new(|cx| fixture_window(window, cx));
        cx.observe(&view, |_, _, cx| cx.notify()).detach();
        SidebarFixture(view)
    });
    let view = cx.update(|_, cx| fixture.read(cx).0.clone());
    // The window paints while the connection is still awaiting its first snapshot.
    let mut snapshot = cx
        .update(|_, cx| view.update(cx, |view, _| view.live.snapshot.take()))
        .unwrap();
    // Reserve the new footer while retaining this test's original list viewport.
    cx.simulate_resize(size(px(800.), px(640.)));
    cx.run_until_parked();
    cx.update(|window, cx| full_draw(window, cx).clear(cx));
    // The fixture's grouped worktrees stay contiguous, so w30 is the 31st row.
    const ROW: usize = 30;
    {
        let snapshot = Arc::make_mut(&mut snapshot);
        snapshot.focused_workspace_id = Some("w30".into());
        for workspace in &mut snapshot.workspaces {
            workspace.focused = workspace.workspace_id == "w30";
        }
    }
    cx.update(|_, cx| {
        view.update(cx, |view, cx| {
            view.live.snapshot = Some(snapshot);
            cx.notify();
        })
    });
    cx.update(|window, cx| {
        window.refresh();
        full_draw(window, cx).clear(cx);
    });
    cx.update(|_, cx| {
        let view = view.read(cx);
        let spaces = &view.sidebar_scroll[0];
        let offset = spaces.offset().y;
        let row = spaces.bounds_for_item(ROW).unwrap();
        assert!(offset < px(0.), "focused workspace must scroll into view");
        assert!(row.top() + offset >= spaces.bounds().top(), "{row:?}");
        assert!(row.bottom() + offset <= spaces.bounds().bottom(), "{row:?}");
        // The fixture focuses no agent, so that list must stay where it was.
        assert_eq!(view.sidebar_scroll[1].offset().y, px(0.));
    });
    // While the selection holds, later frames must not fight manual scrolling.
    cx.update(|window, cx| {
        view.read(cx).sidebar_scroll[0].set_offset(point(px(0.), px(0.)));
        window.refresh();
        full_draw(window, cx).clear(cx);
    });
    cx.update(|_, cx| {
        assert_eq!(view.read(cx).sidebar_scroll[0].offset().y, px(0.));
    });
    // A new selection is revealed in turn, from wherever the list now sits.
    cx.update(|_, cx| {
        view.update(cx, |view, cx| {
            let snapshot = Arc::make_mut(view.live.snapshot.as_mut().unwrap());
            snapshot.focused_workspace_id = Some("w20".into());
            for workspace in &mut snapshot.workspaces {
                workspace.focused = workspace.workspace_id == "w20";
            }
            cx.notify();
        })
    });
    cx.update(|window, cx| {
        window.refresh();
        full_draw(window, cx).clear(cx);
    });
    cx.update(|_, cx| {
        let view = view.read(cx);
        let spaces = &view.sidebar_scroll[0];
        let offset = spaces.offset().y;
        let row = spaces.bounds_for_item(20).unwrap();
        assert!(offset < px(0.), "a new selection must scroll into view");
        assert!(row.top() + offset >= spaces.bounds().top(), "{row:?}");
        assert!(row.bottom() + offset <= spaces.bounds().bottom(), "{row:?}");
    });

    // Selecting a visible neighbor must not move the list. A selection above or
    // below the viewport should land at the nearest edge, not always the bottom.
    for (id, row, edge) in [
        ("w19", 19, None),
        ("w0", 0, Some(false)),
        ("w4", 4, None),
        ("w5", 5, None),
        ("w30", 30, Some(true)),
        ("w4", 4, Some(false)),
        ("w5", 5, None),
    ] {
        let before = cx.update(|_, cx| view.read(cx).sidebar_scroll[0].offset());
        cx.update(|_, cx| {
            view.update(cx, |view, cx| {
                let snapshot = Arc::make_mut(view.live.snapshot.as_mut().unwrap());
                snapshot.focused_workspace_id = Some(id.into());
                for workspace in &mut snapshot.workspaces {
                    workspace.focused = workspace.workspace_id == id;
                }
                cx.notify();
            });
        });
        cx.update(|window, cx| {
            window.refresh();
            full_draw(window, cx).clear(cx);
        });
        cx.update(|_, cx| {
            let spaces = &view.read(cx).sidebar_scroll[0];
            let bounds = spaces.bounds_for_item(row).unwrap();
            match edge {
                None => assert_eq!(spaces.offset(), before, "visible {id} must not scroll"),
                Some(false) => assert_eq!(bounds.top() + spaces.offset().y, spaces.bounds().top()),
                Some(true) => assert_eq!(
                    bounds.bottom() + spaces.offset().y,
                    spaces.bounds().bottom()
                ),
            }
        });
    }
}
