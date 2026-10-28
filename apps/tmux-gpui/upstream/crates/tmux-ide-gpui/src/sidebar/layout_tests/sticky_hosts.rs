use super::*;
use gpui::{Pixels, ScrollDelta, ScrollWheelEvent, VisualTestContext};

const WORKSPACES: usize = 12;
/// Past a header's own edge, so it is unambiguously above the list's top.
const PAST: f32 = 5.;

/// Where the host headers sit in an unscrolled frame, in pixels.
struct Geometry {
    /// A host header's height.
    header: f32,
    /// How far below the top of the list the remote header starts.
    remote: f32,
}

fn endpoint(id: &str, label: &str) -> crate::endpoint::Endpoint {
    let mut remote = crate::endpoint::Endpoint::new(
        id.into(),
        label.into(),
        ConnectTarget::Ssh {
            target: "unused".into(),
            session: "default".into(),
        },
        true,
    );
    remote.live.snapshot = Some(Arc::new(snapshot(WORKSPACES)));
    remote
}

/// A window with `WORKSPACES` workspaces per host, so the spaces list scrolls
/// well past both headers, drawn until it is settled at the top.
fn open(
    cx: &mut gpui::TestAppContext,
    remote: bool,
) -> (Entity<HerdrWindow>, &mut VisualTestContext) {
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = fixture_window(window, cx);
        view.live.snapshot = Some(Arc::new(snapshot(WORKSPACES)));
        if remote {
            view.endpoints.push(endpoint("ssh:test", "Remote"));
        }
        view
    });
    cx.simulate_resize(size(px(800.), px(600.)));
    cx.run_until_parked();
    // The first frame measures the list; the second lets the pass that follows
    // the selection record that the focused workspace is already visible, so it
    // leaves the offsets set below alone.
    for _ in 0..2 {
        cx.update(|window, cx| full_draw(window, cx).clear(cx));
    }
    (view, cx)
}

fn geometry(cx: &mut VisualTestContext) -> Geometry {
    let list = cx.debug_bounds("spaces-scroll").unwrap();
    let local = cx.debug_bounds("host-local").unwrap();
    let remote = cx.debug_bounds("host-ssh:test").unwrap();
    Geometry {
        header: f32::from(local.size.height),
        remote: f32::from(remote.top() - list.top()),
    }
}

/// Scroll the spaces list `distance` below its top and draw. Scrolling moves
/// rows without relaying them out, and the pinned header reads the offset live
/// while taking each header's position from the previous frame's layout, which
/// the unscrolled frames in `open` already measured: one frame is enough.
fn scroll_to(view: &Entity<HerdrWindow>, cx: &mut VisualTestContext, distance: f32) {
    cx.update(|window, cx| {
        let scroll = view.read(cx).sidebar_scroll[0].clone();
        scroll.set_offset(point(px(0.), px(-distance)));
        full_draw(window, cx).clear(cx);
        assert_eq!(
            scroll.offset().y,
            px(-distance),
            "{distance} is past the end of the list, so it was clamped"
        );
    });
}

fn near(actual: Pixels, expected: Pixels) -> bool {
    (actual - expected).abs() < px(0.5)
}

fn list_top(cx: &mut VisualTestContext) -> Pixels {
    cx.debug_bounds("spaces-scroll").unwrap().top()
}

#[gpui::test]
fn the_pinned_header_follows_the_scroll_and_is_pushed_out_by_the_next_host(
    cx: &mut gpui::TestAppContext,
) {
    let (view, cx) = open(cx, true);
    let Geometry { header, remote } = geometry(cx);
    assert!(
        remote > 3. * header,
        "the remote header must start well below the fold: {remote} vs {header}"
    );

    // Unscrolled, every header shows its own row.
    for selector in ["sticky-host-local", "sticky-host-ssh:test"] {
        assert!(cx.debug_bounds(selector).is_none(), "{selector}");
    }

    // A little past the local header: its copy sits at the top of the list.
    scroll_to(&view, cx, header + PAST);
    let top = list_top(cx);
    let pinned = cx.debug_bounds("sticky-host-local").unwrap();
    assert!(near(pinned.top(), top), "{:?} vs {top:?}", pinned.top());
    assert!(near(pinned.size.height, px(header)));
    assert_eq!(
        pinned.size.width,
        cx.debug_bounds("spaces-scroll").unwrap().size.width
    );
    assert!(cx.debug_bounds("sticky-host-ssh:test").is_none());
    for part in ["sticky-host-status-local", "sticky-collapse-host-local"] {
        assert!(pinned.contains(&cx.debug_bounds(part).unwrap().center()));
    }

    // The remote header arrives half under the pinned one and pushes it up.
    scroll_to(&view, cx, remote - header / 2.);
    let top = list_top(cx);
    let pinned = cx.debug_bounds("sticky-host-local").unwrap();
    assert!(
        near(pinned.top(), top - px(header / 2.)),
        "{:?} vs {top:?}",
        pinned.top()
    );
    assert!(cx.debug_bounds("sticky-host-ssh:test").is_none());

    // Once it has scrolled past the top, the remote header pins instead.
    scroll_to(&view, cx, remote + PAST);
    let top = list_top(cx);
    let pinned = cx.debug_bounds("sticky-host-ssh:test").unwrap();
    assert!(near(pinned.top(), top), "{:?} vs {top:?}", pinned.top());
    assert!(cx.debug_bounds("sticky-host-local").is_none());

    // Back at the top, the rows show their own headers again.
    scroll_to(&view, cx, 0.);
    for selector in ["sticky-host-local", "sticky-host-ssh:test"] {
        assert!(cx.debug_bounds(selector).is_none(), "{selector}");
    }
}

#[gpui::test]
fn the_pinned_header_takes_input_instead_of_the_rows_under_it(cx: &mut gpui::TestAppContext) {
    let (view, cx) = open(cx, true);
    let Geometry { header, .. } = geometry(cx);
    scroll_to(&view, cx, header + PAST);
    let pinned = cx.debug_bounds("sticky-host-local").unwrap();
    // A workspace row lies under the middle of the pinned header.
    let under = cx.debug_bounds("workspace-local-w0").unwrap();
    assert!(under.contains(&pinned.center()), "{under:?} vs {pinned:?}");

    // Clicking it selects the host and reaches no row, which would navigate.
    cx.simulate_click(pinned.center(), Default::default());
    view.read_with(cx, |view, _| {
        assert_eq!(view.selected_endpoint, 0);
        assert!(view.pending_navigation.is_none());
    });
    // The same click on a visible row does navigate, so the check above can fail.
    let row = cx.debug_bounds("workspace-local-w2").unwrap();
    cx.simulate_click(row.center(), Default::default());
    view.read_with(cx, |view, _| assert!(view.pending_navigation.is_some()));
    view.update(cx, |view, _| view.pending_navigation = None);

    // The wheel still scrolls the list with the pointer on the pinned header.
    let before = view.read_with(cx, |view, _| view.sidebar_scroll[0].offset());
    cx.simulate_event(ScrollWheelEvent {
        position: pinned.center(),
        delta: ScrollDelta::Pixels(point(px(0.), px(-20.))),
        ..Default::default()
    });
    cx.update(|window, cx| full_draw(window, cx).clear(cx));
    view.read_with(cx, |view, _| {
        assert!(view.sidebar_scroll[0].offset().y < before.y);
    });
}

#[gpui::test]
fn the_pinned_arrow_collapses_its_host(cx: &mut gpui::TestAppContext) {
    let (view, cx) = open(cx, true);
    let Geometry { header, .. } = geometry(cx);
    scroll_to(&view, cx, header + PAST);
    let arrow = cx.debug_bounds("sticky-collapse-host-local").unwrap();
    cx.simulate_click(arrow.center(), Default::default());
    view.read_with(cx, |view, _| {
        assert!(view.endpoints[0].collapsed);
        assert!(!view.endpoints[1].collapsed);
    });
}

#[gpui::test]
fn a_single_host_has_no_header_to_pin(cx: &mut gpui::TestAppContext) {
    let (view, cx) = open(cx, false);
    cx.update(|window, cx| {
        let scroll = view.read(cx).sidebar_scroll[0].clone();
        assert!(scroll.max_offset().y > px(100.), "the list must scroll");
        scroll.set_offset(point(px(0.), px(-100.)));
        full_draw(window, cx).clear(cx);
        assert_eq!(scroll.offset().y, px(-100.));
    });
    for selector in ["host-local", "sticky-host-local"] {
        assert!(cx.debug_bounds(selector).is_none(), "{selector}");
    }
}

#[gpui::test]
fn revealing_the_selection_pins_again_for_where_the_list_lands(cx: &mut gpui::TestAppContext) {
    let (view, cx) = open(cx, true);
    let Geometry { remote, .. } = geometry(cx);
    scroll_to(&view, cx, remote + PAST);
    assert!(cx.debug_bounds("sticky-host-ssh:test").is_some());

    // Focus a local workspace far above the viewport. The frame that reveals it
    // scrolls in prepaint, after its render pinned a header for the old offset;
    // nothing here notifies a view, so only the reveal's own request can bring
    // another render.
    cx.update(|window, cx| {
        view.update(cx, |view, _| {
            let snapshot = Arc::make_mut(view.live.snapshot.as_mut().unwrap());
            snapshot.focused_workspace_id = Some("w2".into());
            for workspace in &mut snapshot.workspaces {
                workspace.focused = workspace.workspace_id == "w2";
            }
        });
        full_draw(window, cx).clear(cx);
    });
    let offset = view.read_with(cx, |view, _| view.sidebar_scroll[0].offset().y);
    assert!(offset > px(-(remote + PAST)), "the list must scroll up");
    assert!(cx.debug_bounds("sticky-host-ssh:test").is_some());
    assert!(cx.debug_bounds("sticky-host-local").is_none());

    // The next frame pins the header of the host the list landed on, and
    // moves the revealed row, which GPUI left at the top edge, out from under
    // it. A plain draw replays the cached sidebar unless something notified it.
    cx.update(|window, cx| {
        assert!(window.simulate_next_frame(cx) > 0, "no frame was requested");
        window.draw(cx).clear(cx);
    });
    let pinned = cx.debug_bounds("sticky-host-local").unwrap();
    assert!(cx.debug_bounds("sticky-host-ssh:test").is_none());
    let revealed = cx.debug_bounds("workspace-local-w2").unwrap();
    assert!(
        near(revealed.top(), pinned.bottom()),
        "{revealed:?} under {pinned:?}"
    );
    assert!(view.read_with(cx, |view, _| view.sidebar_scroll[0].offset().y) > offset);
    // Settled: a later frame leaves the user's scrolling alone.
    cx.update(|window, cx| {
        view.update(cx, |_, cx| cx.notify());
        window.draw(cx).clear(cx);
    });
    assert_eq!(cx.debug_bounds("workspace-local-w2").unwrap(), revealed);
}

#[gpui::test]
fn a_selection_hidden_under_the_pinned_header_is_revealed_below_it(cx: &mut gpui::TestAppContext) {
    let (view, cx) = open(cx, true);
    let Geometry { header, .. } = geometry(cx);
    // Scrolled so w0, the local host's first workspace, ends halfway down the
    // pinned copy: inside the list, but wholly under the header. A row only
    // partly hidden counts as seen, as one clipped at either edge does.
    let w0_bottom = cx.debug_bounds("workspace-local-w0").unwrap().bottom() - list_top(cx);
    scroll_to(&view, cx, f32::from(w0_bottom) - header / 2.);
    let pinned = cx.debug_bounds("sticky-host-local").unwrap();
    let hidden = cx.debug_bounds("workspace-local-w0").unwrap();
    assert!(hidden.bottom() > list_top(cx), "{hidden:?} is off the list");
    assert!(hidden.bottom() <= pinned.bottom(), "{hidden:?} {pinned:?}");
    cx.update(|window, cx| {
        view.update(cx, |view, _| {
            let snapshot = Arc::make_mut(view.live.snapshot.as_mut().unwrap());
            snapshot.focused_workspace_id = Some("w1".into());
            for workspace in &mut snapshot.workspaces {
                workspace.focused = workspace.workspace_id == "w1";
            }
        });
        full_draw(window, cx).clear(cx);
    });
    cx.update(|window, cx| {
        view.update(cx, |view, _| {
            let snapshot = Arc::make_mut(view.live.snapshot.as_mut().unwrap());
            snapshot.focused_workspace_id = Some("w0".into());
            for workspace in &mut snapshot.workspaces {
                workspace.focused = workspace.workspace_id == "w0";
            }
        });
        full_draw(window, cx).clear(cx);
        window.simulate_next_frame(cx);
        window.draw(cx).clear(cx);
    });
    let revealed = cx.debug_bounds("workspace-local-w0").unwrap();
    let list = list_top(cx);
    // Moved below the pinned copy; here that brings the local header itself
    // back to the top, so nothing is pinned any more.
    match cx.debug_bounds("sticky-host-local") {
        Some(pinned) => assert!(
            near(revealed.top(), pinned.bottom()),
            "{revealed:?} {pinned:?}"
        ),
        None => assert!(revealed.top() >= list, "{revealed:?} above {list:?}"),
    }
}
