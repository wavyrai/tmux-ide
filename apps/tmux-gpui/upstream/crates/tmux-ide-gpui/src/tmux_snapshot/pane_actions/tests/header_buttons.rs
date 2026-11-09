use super::*;
#[gpui::test]
fn direct_expand_uses_current_target_and_close_requires_confirmation(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (_view, cx) = cx.add_window_view(|window, cx| header_view(window, cx, sender));
    cx.simulate_resize(size(px(900.), px(700.)));
    cx.update(|window, cx| {
        window.draw(cx).clear(cx);
    });
    receiver.try_iter().for_each(drop);
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
    assert!(cx.debug_bounds("pane-close-confirmation").is_some());
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
    assert!(cx.debug_bounds("pane-close-confirmation").is_some());
    assert!(receiver.try_recv().is_err());
    cx.simulate_keystrokes("enter");
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
    assert_eq!(title_weight(true), FontWeight::SEMIBOLD);
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
    assert_eq!(buttons[3].right(), header.right());
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
