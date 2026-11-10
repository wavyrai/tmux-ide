use super::*;
#[gpui::test]
fn direct_expand_uses_current_target_and_close_requires_confirmation(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| header_view(window, cx, sender));
    cx.simulate_resize(size(px(900.), px(700.)));
    cx.update(|window, cx| {
        window.draw(cx).clear(cx);
    });
    receiver.try_iter().for_each(drop);
    // Send the resized viewport's fit now: left pending, a draw sends it
    // after 150 ms of wall clock, among the messages this test counts.
    crate::tmux_snapshot::fit_test_support::settle(&view, cx, &receiver);
    let expand = cx.debug_bounds("pane-expand:pane-a").unwrap();
    let close = cx.debug_bounds("pane-close:pane-a").unwrap();
    assert!(expand.right() <= close.left());
    // The two hit areas sit edge to edge at the header's right end: a gap
    // between them would be a dead strip in the header.
    assert_eq!(expand.right(), close.left());
    assert_eq!(expand.size, close.size);
    // The pane title sits flat inside the header row, not in a chip.
    let title = cx.debug_bounds("pane-title:pane-a").unwrap();
    assert!(title.top() >= close.top() && title.bottom() <= close.bottom());
    cx.simulate_click(close.center(), Modifiers::default());
    assert!(
        receiver.try_recv().is_err(),
        "Close must wait for confirmation"
    );
    cx.update(|window, cx| {
        window.draw(cx).clear(cx);
    });
    // The card hangs 6 pt under the close button, trailing edges aligned:
    // the 22 pt button sits centred in its 24 pt slot (c1, #746 v3).
    let card = cx.debug_bounds("pane-close-card").unwrap();
    assert_eq!(card.right(), close.right() - px(1.));
    assert_eq!(card.top(), close.top() + px(6. + 22. + 6.));
    assert_eq!(card.size.width, px(300.));
    // No scrim and no palette.
    view.read_with(cx, |view, _| assert!(view.picker.is_none()));
    assert!(cx.debug_bounds("commands-popover").is_none());
    cx.simulate_keystrokes("escape");
    cx.update(|window, cx| {
        window.draw(cx).clear(cx);
    });
    cx.simulate_click(expand.center(), Modifiers::default());
    assert!(
        matches!(receiver.try_recv().unwrap(), browser::Command::PaneAction { id, action: Action::Zoom { desired: Zoom::Zoomed }, .. } if id == "pane-a")
    );
    assert!(receiver.try_recv().is_err());
}

#[gpui::test]
fn closing_an_unselected_header_waits_for_that_panes_authority(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| header_view(window, cx, sender));
    cx.simulate_resize(size(px(900.), px(700.)));
    cx.update(|window, cx| {
        window.draw(cx).clear(cx);
    });
    receiver.try_iter().for_each(drop);
    // Send the resized viewport's fit now: left pending, a draw sends it
    // after 150 ms of wall clock, among the messages this test counts.
    crate::tmux_snapshot::fit_test_support::settle(&view, cx, &receiver);
    let close = cx.debug_bounds("pane-close:pane-b").unwrap();
    cx.simulate_click(close.center(), Modifiers::default());
    assert!(
        matches!(receiver.try_recv().unwrap(), browser::Command::Pane { request: 8, id } if id == "pane-b")
    );
    assert!(receiver.try_recv().is_err());
    cx.update(|window, cx| {
        view.update(cx, |v, cx| {
            v.browser_state.request = 8;
            v.browser_state.selected_pane = Some("pane-b".into());
            v.browser_state.input_ready = true;
            v.browser_state.pane_actions = Some(browser::PaneActions {
                id: "pane-b".into(),
                token: "new-token".into(),
                zoomed: false,
            });
            v.finish_header_actions(window, cx);
        });
        window.draw(cx).clear(cx);
    });
    assert!(cx.debug_bounds("pane-close-card").is_some());
    assert!(receiver.try_recv().is_err());
    // Cmd-W again confirms, on the pane the card names (c1).
    cx.simulate_keystrokes("cmd-w");
    assert!(
        matches!(receiver.try_recv().unwrap(), browser::Command::PaneAction { request: 8, id, token, action: Action::Close } if id == "pane-b" && token == "new-token")
    );
    assert!(receiver.try_recv().is_err());
}

#[gpui::test]
fn pane_titles_sit_flat_in_the_header_with_or_without_focus(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| header_view(window, cx, sender));
    cx.simulate_resize(size(px(900.), px(700.)));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    receiver.try_iter().for_each(drop);
    // Send the resized viewport's fit now: left pending, a draw sends it
    // after 150 ms of wall clock, among the messages this test counts.
    crate::tmux_snapshot::fit_test_support::settle(&view, cx, &receiver);
    let mut seen = Vec::new();
    for focused in ["pane-a", "pane-b"] {
        view.update(cx, |v, _| {
            v.browser_state.selected_pane = Some(focused.into())
        });
        cx.update(|window, cx| {
            window.draw(cx).clear(cx);
        });
        receiver.try_iter().for_each(drop);
        for (id, header, title) in [
            ("pane-a", "pane-card-header:pane-a", "pane-title:pane-a"),
            ("pane-b", "pane-card-header:pane-b", "pane-title:pane-b"),
        ] {
            let header = cx.debug_bounds(header).unwrap();
            let title = cx.debug_bounds(title).unwrap();
            // The title is a line of text centred in its header row, not a
            // plate filling the row up to the card's top edge (the old chip).
            assert!(
                title.top() > header.top(),
                "{id} reaches the card's top edge"
            );
            assert!(
                title.bottom() < header.bottom(),
                "{id} fills its header row"
            );
            let centre =
                (title.top() + title.bottom()) / 2. - (header.top() + header.bottom()) / 2.;
            assert!(centre.abs() <= px(1.), "{id} sits off centre by {centre:?}");
            assert_eq!(
                header.size.height,
                px(crate::tmux_snapshot::pane_cards::HEADER)
            );
            seen.push((focused == id, header.size.height, title.size.height));
        }
    }
    // Focused and unfocused titles are the same height in the same header.
    let heights: std::collections::BTreeSet<_> = seen
        .iter()
        .map(|(_, h, t)| (f32::from(*h).to_bits(), f32::from(*t).to_bits()))
        .collect();
    assert_eq!(heights.len(), 1, "{seen:?}");
    // Ink and weight are what is left to mark focus.
    use crate::tmux_snapshot::pane_chrome::title_weight;
    assert_eq!(title_weight(true), FontWeight::MEDIUM);
    assert_eq!(title_weight(false), FontWeight::NORMAL);
}

#[gpui::test]
fn header_buttons_split_right_split_down_zoom_close_edge_to_edge(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| header_view(window, cx, sender));
    cx.simulate_resize(size(px(900.), px(700.)));
    cx.update(|window, cx| {
        window.draw(cx).clear(cx);
    });
    receiver.try_iter().for_each(drop);
    // Send the resized viewport's fit now: left pending, a draw sends it
    // after 150 ms of wall clock, among the messages this test counts.
    crate::tmux_snapshot::fit_test_support::settle(&view, cx, &receiver);
    assert!(
        cx.debug_bounds("pane-overflow:pane-a").is_none(),
        "no menu button"
    );
    let mut buttons = Vec::new();
    for selector in [
        "pane-split-right:pane-a",
        "pane-split-down:pane-a",
        "pane-expand:pane-a",
        "pane-close:pane-a",
    ] {
        buttons.push(cx.debug_bounds(selector).unwrap());
    }
    for pair in buttons.windows(2) {
        assert_eq!(pair[0].right(), pair[1].left());
        assert_eq!(pair[0].size, pair[1].size);
    }
    let header = cx.debug_bounds("pane-card-header:pane-a").unwrap();
    // #746 v3: 24 pt slots, the last 6 pt in from the card's edge.
    assert_eq!(buttons[0].size.width, px(24.));
    // Each slot holds a 22 pt button, centred.
    for selector in [
        "pane-split-right-glyph:pane-a",
        "pane-split-down-glyph:pane-a",
        "pane-expand-glyph:pane-a",
        "pane-close-glyph:pane-a",
    ] {
        let glyph = cx.debug_bounds(selector).unwrap();
        assert_eq!(glyph.size, size(px(22.), px(22.)), "{selector}");
    }
    let glyph = cx.debug_bounds("pane-close-glyph:pane-a").unwrap();
    assert_eq!(glyph.center(), buttons[3].center());
    assert_eq!(buttons[3].right(), header.right() - px(6.));
    let title = cx.debug_bounds("pane-title:pane-a").unwrap();
    assert!(title.right() <= buttons[0].left());
    for (index, direction) in [(0, SplitDirection::Right), (1, SplitDirection::Down)] {
        // Each action spends the pane's one-use capability; the daemon
        // publishes a fresh one.
        view.update(cx, |v, _| {
            v.browser_state.pane_actions = Some(browser::PaneActions {
                id: "pane-a".into(),
                token: format!("token-{index}"),
                zoomed: false,
            });
        });
        cx.simulate_click(buttons[index].center(), Modifiers::default());
        let sent = receiver.try_recv().unwrap();
        assert!(
            matches!(&sent, browser::Command::PaneAction { id, action: Action::Split { direction: sent }, .. }
                if id == "pane-a" && std::mem::discriminant(sent) == std::mem::discriminant(&direction)),
            "button {index}"
        );
        assert!(receiver.try_recv().is_err());
        cx.update(|window, cx| {
            window.draw(cx).clear(cx);
        });
    }
}

#[gpui::test]
fn right_click_on_the_selected_panes_title_opens_its_menu(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| header_view(window, cx, sender));
    cx.simulate_resize(size(px(900.), px(700.)));
    cx.update(|window, cx| {
        window.draw(cx).clear(cx);
    });
    receiver.try_iter().for_each(drop);
    // Send the resized viewport's fit now: left pending, a draw sends it
    // after 150 ms of wall clock, among the messages this test counts.
    crate::tmux_snapshot::fit_test_support::settle(&view, cx, &receiver);
    let title = cx.debug_bounds("pane-title:pane-a").unwrap();
    // A left click on the title only focuses the terminal.
    cx.simulate_click(title.center(), Modifiers::default());
    assert!(view.read_with(cx, |v, _| v.picker.is_none()));
    cx.simulate_mouse_down(title.center(), MouseButton::Right, Modifiers::default());
    assert!(view.read_with(cx, |v, _| v.picker.is_some()), "pane menu");
    assert!(
        receiver.try_recv().is_err(),
        "the menu sends nothing by itself"
    );
    cx.simulate_keystrokes("enter");
    view.read_with(cx, |v, _| {
        let menu = v.pane_actions.as_ref().unwrap();
        assert_eq!(menu.target.actions.id, "pane-a");
    });
}

/// Without pane cards (the preview windows) a title sits in the separator
/// row above its pane, in the cell grid. A right-click there opens the menu,
/// selecting the pane first. With cards on, the title is the card header's,
/// covered above; the cell header row above the frame only renders when the
/// cards are off in the browsing shell, which happens only when the regions
/// are invalid and so carry no titles.
#[gpui::test]
fn right_click_on_a_lower_cell_header_opens_the_menu(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = header_view(window, cx, sender);
        view.browsing = false;
        view
    });
    cx.simulate_resize(size(px(900.), px(700.)));
    cx.update(|window, cx| {
        window.draw(cx).clear(cx);
    });
    receiver.try_iter().for_each(drop);
    assert!(
        cx.debug_bounds("pane-card-header:pane-b").is_none(),
        "no cards"
    );
    let lower = cx.debug_bounds("pane-title:pane-b").unwrap();
    let terminal = view.read_with(cx, |v, _| v.input_geometry.unwrap().0);
    assert!(
        lower.top() > terminal.top(),
        "inside the grid, not above it"
    );
    cx.simulate_mouse_down(lower.center(), MouseButton::Right, Modifiers::default());
    assert!(
        matches!(receiver.try_recv().unwrap(), browser::Command::Pane { request: 8, id } if id == "pane-b")
    );
    assert!(receiver.try_recv().is_err());
}

/// F5's Open folder in VS Code sends only for the current request, with
/// presence ready, on the exact pane capability it captured (#746).
#[gpui::test]
fn open_captured_editor_needs_the_request_presence_and_a_current_target(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| header_view(window, cx, sender));
    cx.update(|window, cx| {
        window.draw(cx).clear(cx);
    });
    receiver.try_iter().for_each(drop);
    view.update(cx, |view, _| {
        let target = Target::capture(&view.browser_state).unwrap();
        // A newer request.
        view.browser_request += 1;
        assert!(!view.open_captured_editor(&target));
        view.browser_request -= 1;
        // Presence not ready.
        let ready = std::mem::replace(
            &mut view.presence,
            crate::tmux_snapshot::presence::Presence::new(true),
        );
        assert!(!view.presence.ready());
        assert!(!view.open_captured_editor(&target));
        view.presence = ready;
        // A replaced capability: the captured target is no longer current.
        let token = view
            .browser_state
            .pane_actions
            .as_ref()
            .unwrap()
            .token
            .clone();
        view.browser_state.pane_actions.as_mut().unwrap().token = "replacement".into();
        assert!(!view.open_captured_editor(&target));
        view.browser_state.pane_actions.as_mut().unwrap().token = token;
        assert!(
            receiver.try_recv().is_err(),
            "no gate let a command through"
        );
        // All three hold: the admission goes, and spends the capability.
        assert!(view.open_captured_editor(&target));
        assert!(view.browser_state.pane_actions.is_none());
    });
    assert!(matches!(
        receiver.try_recv().unwrap(),
        browser::Command::OpenEditor { request: 7, id, .. } if id == "pane-a"
    ));
}

/// The cell header row above the frame: with the cards off, the top pane's
/// title sits there, and a right-click on it opens the pane's menu.
#[gpui::test]
fn right_click_on_the_header_row_title_opens_the_menu(cx: &mut TestAppContext) {
    struct Row(Entity<SnapshotView>);
    impl Render for Row {
        fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
            self.0
                .update(cx, |view, cx| view.pane_header_row(window, cx))
        }
    }
    let (sender, receiver) = mpsc::sync_channel(64);
    let (row, cx) = cx.add_window_view(|window, cx| {
        let view = cx.new(|cx| {
            let mut view = header_view(window, cx, sender);
            // No cards, so the top pane's title is in the header row.
            view.browsing = false;
            view
        });
        Row(view)
    });
    let view = row.read_with(cx, |row, _| row.0.clone());
    cx.simulate_resize(size(px(900.), px(700.)));
    cx.update(|window, cx| {
        window.draw(cx).clear(cx);
    });
    receiver.try_iter().for_each(drop);
    assert!(view.read_with(cx, |v, _| v.card_layout(8.).is_none()));
    let title = cx.debug_bounds("pane-title:pane-a").unwrap();
    cx.simulate_mouse_down(title.center(), MouseButton::Right, Modifiers::default());
    assert!(
        view.read_with(cx, |v, _| v.picker.is_some()),
        "pane-a's menu"
    );
    assert!(receiver.try_recv().is_err());
}

/// c1 keys: Return cancels (Cancel has focus), Tab moves focus so Return
/// closes, Escape cancels; Cmd-W twice closes.
#[gpui::test]
fn the_close_card_keys_cancel_by_default_and_confirm_on_purpose(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| header_view(window, cx, sender));
    cx.simulate_resize(size(px(900.), px(700.)));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    receiver.try_iter().for_each(drop);
    crate::tmux_snapshot::fit_test_support::settle(&view, cx, &receiver);
    let open = |cx: &mut VisualTestContext| {
        cx.simulate_keystrokes("cmd-w");
        cx.update(|window, cx| window.draw(cx).clear(cx));
        assert!(cx.debug_bounds("pane-close-card").is_some());
    };
    open(cx);
    cx.simulate_keystrokes("enter");
    view.read_with(cx, |v, _| assert!(v.pane_close.is_none(), "Return cancels"));
    assert!(receiver.try_recv().is_err());
    open(cx);
    cx.simulate_keystrokes("escape");
    view.read_with(cx, |v, _| assert!(v.pane_close.is_none(), "Escape cancels"));
    assert!(receiver.try_recv().is_err());
    open(cx);
    cx.simulate_keystrokes("tab enter");
    assert!(matches!(
        receiver.try_recv().unwrap(),
        browser::Command::PaneAction {
            action: Action::Close,
            ..
        }
    ));
    assert!(receiver.try_recv().is_err());
    view.read_with(cx, |v, _| assert!(v.pane_close.is_none()));
}

/// c1: a click outside the card cancels it, and sends nothing.
#[gpui::test]
fn a_click_outside_the_close_card_cancels(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| header_view(window, cx, sender));
    cx.simulate_resize(size(px(900.), px(700.)));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    receiver.try_iter().for_each(drop);
    crate::tmux_snapshot::fit_test_support::settle(&view, cx, &receiver);
    cx.simulate_keystrokes("cmd-w");
    cx.update(|window, cx| window.draw(cx).clear(cx));
    let card = cx.debug_bounds("pane-close-card").unwrap();
    cx.simulate_click(
        point(card.left() - px(40.), card.bottom() + px(80.)),
        Modifiers::default(),
    );
    view.read_with(cx, |v, _| assert!(v.pane_close.is_none()));
    assert!(!receiver.try_iter().any(|c| matches!(
        c,
        browser::Command::PaneAction {
            action: Action::Close,
            ..
        }
    )));
}

/// c1: Cmd-W opens the card on the focused pane, and Cmd-W again closes it.
#[gpui::test]
fn cmd_w_twice_closes_the_focused_pane(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| header_view(window, cx, sender));
    cx.simulate_resize(size(px(900.), px(700.)));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    receiver.try_iter().for_each(drop);
    crate::tmux_snapshot::fit_test_support::settle(&view, cx, &receiver);
    cx.simulate_keystrokes("cmd-w");
    assert!(receiver.try_recv().is_err());
    view.read_with(cx, |v, _| assert!(v.pane_close.is_some()));
    cx.simulate_keystrokes("cmd-w");
    assert!(matches!(
        receiver.try_recv().unwrap(),
        browser::Command::PaneAction {
            action: Action::Close,
            ..
        }
    ));
    view.read_with(cx, |v, _| assert!(v.pane_close.is_none()));
}
