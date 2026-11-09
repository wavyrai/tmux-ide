//! A pane row's menu: its … button and a right-click open the pane's menu,
//! as a right-click on the pane's title does (#746).
use super::*;

fn menu_view(
    window: &mut Window,
    cx: &mut Context<SnapshotView>,
    sender: mpsc::SyncSender<browser::Command>,
) -> SnapshotView {
    let mut view = make_view(window, cx, sender);
    view.browser_state.request = 7;
    view.browser_state.selected_pane = Some("pane-a".into());
    view.browser_state.pane_actions = Some(browser::PaneActions {
        id: "pane-a".into(),
        token: "token".into(),
        zoomed: false,
    });
    view
}

#[gpui::test]
fn right_click_and_the_more_button_open_the_panes_menu(cx: &mut TestAppContext) {
    for right_click in [true, false] {
        let (sender, receiver) = mpsc::sync_channel(64);
        let (view, cx) = cx.add_window_view(|window, cx| menu_view(window, cx, sender));
        cx.simulate_resize(size(px(640.), px(400.)));
        cx.update(|window, cx| window.draw(cx).clear(cx));
        receiver.try_iter().for_each(drop);
        let row = cx.debug_bounds("tmux-sidebar-pane:pane-a").unwrap();
        if right_click {
            cx.simulate_mouse_down(row.center(), MouseButton::Right, Modifiers::default());
        } else {
            let more = cx.debug_bounds("tmux-sidebar-pane-menu-1").unwrap();
            assert!(more.left() >= row.left() && more.right() <= row.right());
            cx.simulate_mouse_down(more.center(), MouseButton::Left, Modifiers::default());
        }
        assert!(
            view.read_with(cx, |v, _| v.picker.is_some()),
            "the pane menu (right_click: {right_click})"
        );
        assert!(
            receiver.try_recv().is_err(),
            "opening the menu sends nothing"
        );
        cx.simulate_keystrokes("enter");
        assert!(
            view.read_with(cx, |v, _| v.pane_actions.is_some()),
            "the menu acts on the selected pane"
        );
    }
}

#[gpui::test]
fn a_menu_for_another_pane_selects_it_first(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = menu_view(window, cx, sender);
        view.browser_state.panes.push(choice("pane-b", "Shell"));
        view
    });
    cx.simulate_resize(size(px(640.), px(400.)));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    receiver.try_iter().for_each(drop);
    let row = cx.debug_bounds("tmux-sidebar-pane:pane-b").unwrap();
    cx.simulate_mouse_down(row.center(), MouseButton::Right, Modifiers::default());
    assert!(
        matches!(receiver.try_recv().unwrap(), browser::Command::Pane { request: 8, id } if id == "pane-b")
    );
    assert!(
        view.read_with(cx, |v, _| v.picker.is_none()),
        "not before the pane is selected"
    );
}

/// Working shows only its glyph and an idle agent nothing; needs input is the
/// one full pill (#746).
#[gpui::test]
fn only_needs_input_wears_the_pill(cx: &mut TestAppContext) {
    for (status, attention, glyph, pill) in [
        ("WORKING", false, true, false),
        ("IDLE", false, false, false),
        ("DONE", false, true, false),
        ("IDLE", true, false, true),
    ] {
        let (sender, _receiver) = mpsc::sync_channel(64);
        let (_view, cx) = cx.add_window_view(|window, cx| {
            let mut view = make_view(window, cx, sender);
            view.browser_state.workspace_agents = Some(
                serde_json::from_value(serde_json::json!({"sessionId":"session-a","revision":1,
                    "phase":"live","rows":[{"key":"agent","sessionId":"session-a","paneId":"pane-a",
                    "name":"Claude","sessionLabel":"x","harness":"claude-code","status":status,
                    "attention":attention,"available":true}],"observedSessions":1,
                    "totalSessions":1,"truncatedSessions":0,"truncatedRows":0,"note":null}))
                .unwrap(),
            );
            view
        });
        cx.simulate_resize(size(px(640.), px(400.)));
        cx.update(|window, cx| window.draw(cx).clear(cx));
        assert_eq!(cx.debug_bounds("agent-glyph").is_some(), glyph, "{status}");
        assert_eq!(cx.debug_bounds("agent-badge").is_some(), pill, "{status}");
    }
}
