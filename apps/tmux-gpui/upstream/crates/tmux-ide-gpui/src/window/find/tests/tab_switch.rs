use super::*;

/// Moves the window to `pane_id` as a tab switch does: the snapshot focuses
/// it and the surface paints it alone, while the other pane still exists on
/// its own tab. Then lets the window poll.
fn focus_tab_of(view: &Entity<HerdrWindow>, cx: &mut VisualTestContext, pane_id: &str) {
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            let snapshot = Arc::make_mut(view.live.snapshot.as_mut().unwrap());
            if !snapshot.panes.iter().any(|pane| pane.pane_id == "w1:p2") {
                let mut other = snapshot.panes[0].clone();
                other.pane_id = "w1:p2".into();
                other.tab_id = "w1:t2".into();
                snapshot.panes.push(other);
            }
            snapshot.focused_pane_id = Some(pane_id.into());
            let surface = Arc::make_mut(view.live.surface.as_mut().unwrap());
            surface.panes[0].pane_id = pane_id.into();
            view.poll_find(window, cx);
            view.poll_copy_mode(cx);
        })
    });
}

fn query(view: &Entity<HerdrWindow>, cx: &mut VisualTestContext) -> String {
    view.read_with(cx, |view, cx| {
        view.find.as_ref().unwrap().input.read(cx).text().to_owned()
    })
}

/// A bar open over a pane is put away with its tab, handing the keyboard
/// to the terminal, and comes back with its query, its field focused and
/// searching again, when that pane's tab returns.
#[gpui::test]
fn the_find_bar_follows_its_pane_across_tabs(cx: &mut TestAppContext) {
    let (view, mut peer, cx) = open(cx, &["pane.copy_search", "pane.scroll"]);
    find(&view, cx);
    cx.simulate_keystrokes("x");
    let first = next_request(&mut peer);
    answer(&view, &mut peer, cx, &first, matches(&[], 0, 0, 0));

    focus_tab_of(&view, cx, "w1:p2");
    view.read_with(cx, |view, _| assert!(view.find.is_none()));
    cx.update(|window, cx| {
        assert!(
            view.read(cx).focus.is_focused(window),
            "the terminal has the keyboard, not a hidden field"
        );
    });

    focus_tab_of(&view, cx, "w1:p1");
    assert_eq!(query(&view, cx), "x");
    assert!(cx.update(|window, cx| view.read(cx).find_focused(window, cx)));
    let again = next_request(&mut peer);
    assert_eq!(again["method"], "pane.copy_search");
    assert_eq!(again["params"]["pane_id"], "w1:p1");
    assert_eq!(again["params"]["query"], "x");
}

/// A bar the user closed stays closed when its pane comes back, and opening
/// it there again starts from the last query.
#[gpui::test]
fn a_closed_bar_reopens_with_its_last_query(cx: &mut TestAppContext) {
    let (view, mut peer, cx) = open(cx, &["pane.copy_search", "pane.scroll"]);
    find(&view, cx);
    cx.simulate_keystrokes("x");
    let first = next_request(&mut peer);
    answer(&view, &mut peer, cx, &first, matches(&[], 0, 0, 0));
    cx.simulate_keystrokes("escape");

    focus_tab_of(&view, cx, "w1:p2");
    focus_tab_of(&view, cx, "w1:p1");
    view.read_with(cx, |view, _| assert!(view.find.is_none()));

    find(&view, cx);
    assert_eq!(query(&view, cx), "x");
    // A pane never searched opens empty.
    focus_tab_of(&view, cx, "w1:p2");
    find(&view, cx);
    assert_eq!(query(&view, cx), "");
}

/// Copy mode holds the keyboard, so it ends when its pane leaves the screen
/// rather than swallowing what is typed into the tab now shown.
#[gpui::test]
fn copy_mode_ends_when_its_pane_leaves_the_screen(cx: &mut TestAppContext) {
    let (view, _peer, cx) = open(cx, &["pane.copy_search", "pane.copy_motion"]);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.live.supports_copy_motion = true;
            view.enter_copy_mode(window, cx);
        })
    });
    assert!(view.read_with(cx, |view, _| view.copy_mode_active()));
    focus_tab_of(&view, cx, "w1:p2");
    assert!(!view.read_with(cx, |view, _| view.copy_mode_active()));
}
