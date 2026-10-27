use super::*;
fn ready(view: &mut SnapshotView) {
    view.browser_state.surface = browser::Surface::Workspace;
    view.browser_state.request = view.browser_request;
    view.browser_state.selected_session = Some("session-a".into());
    view.browser_state.pane_actions = Some(browser::PaneActions {
        token: "312b2c16-a13d-4411-82e5-1fdb58adab92".into(),
        id: "pane-a".into(),
        zoomed: false,
    });
}
#[gpui::test]
fn zoom_shortcut_uses_capability_once_and_never_types(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    cx.update(|window, cx| {
        view.update(cx, |view, _| ready(view));
        window.draw(cx).clear(cx);
    });
    cx.update(|window, cx| {
        window.draw(cx).clear(cx);
    });
    receiver.try_iter().for_each(drop);
    cx.simulate_keystrokes("cmd-shift-enter");
    assert!(matches!(
        receiver.try_recv().unwrap(),
        browser::Command::PaneAction {
            action: super::super::super::pane_actions::Action::Zoom {
                desired: super::super::super::pane_actions::Zoom::Zoomed
            },
            ..
        }
    ));
    cx.simulate_keystrokes("cmd-shift-enter");
    assert!(receiver.try_recv().is_err());
}
#[gpui::test]
fn pane_shortcuts_do_not_escape_text_fields_or_composition(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    cx.update(|window, cx| {
        view.update(cx, |view, _| ready(view));
        window.draw(cx).clear(cx);
    });
    receiver.try_iter().for_each(drop);
    cx.simulate_keystrokes("f5");
    receiver.try_iter().for_each(drop);
    cx.simulate_keystrokes("cmd-shift-enter");
    assert!(receiver.try_recv().is_err());
    cx.simulate_keystrokes("escape");
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.marked = "composition".into();
            assert!(!view.pane_shortcut_key(
                &KeyDownEvent {
                    keystroke: Keystroke::parse("cmd-shift-enter").unwrap(),
                    is_held: false,
                    prefer_character_input: false,
                    layout: None
                },
                window,
                cx
            ));
        })
    });
    assert!(receiver.try_recv().is_err());
}
#[gpui::test]
fn zoom_hint_works_with_context_menu_open(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    cx.update(|window, cx| {
        view.update(cx, |view, _| ready(view));
        window.draw(cx).clear(cx);
        view.update(cx, |view, cx| {
            view.open_header_actions(window, cx);
            assert!(view.picker.as_ref().unwrap().pane_scope.is_some());
        })
    });
    cx.update(|window, cx| {
        window.draw(cx).clear(cx);
    });
    receiver.try_iter().for_each(drop);
    cx.simulate_keystrokes("cmd-shift-enter");
    assert!(matches!(
        receiver.try_recv().unwrap(),
        browser::Command::PaneAction { .. }
    ));
    view.read_with(cx, |view, _| assert!(view.picker.is_none()));
    let extra: Vec<_> = receiver
        .try_iter()
        .map(|c| serde_json::to_value(c).unwrap())
        .collect();
    assert!(extra.is_empty(), "Unexpected commands: {extra:?}");
}
#[gpui::test]
fn header_focus_shortcut_selects_adjacent_pane_without_terminal_keys(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    cx.update(|window, cx| {
        view.update(cx, |view, _| {
            ready(view);
            view.browser_state.panes.push(choice("pane-b", "Shell"));
            view.browser_state.regions = serde_json::from_str(r#"[{"id":"pane-a","left":0,"top":0,"width":1,"height":1},{"id":"pane-b","left":2,"top":0,"width":1,"height":1}]"#).unwrap();
        });
        window.draw(cx).clear(cx);
        view.update(cx, |view, cx| {
            view.open_header_actions(window, cx);
            let rows = &view.picker.as_ref().unwrap().rows;
            assert!(rows.iter().any(|r| r.label == "Focus pane right"));
            assert!(!rows.iter().any(|r| r.label == "Focus pane left"));
        });
        window.draw(cx).clear(cx);
    });
    receiver.try_iter().for_each(drop);
    cx.simulate_keystrokes("cmd-alt-right");
    let commands: Vec<_> = receiver.try_iter().collect();
    assert!(
        commands
            .iter()
            .any(|c| matches!(c, browser::Command::Pane { id, .. } if id == "pane-b"))
    );
    assert!(!commands.iter().any(|c| matches!(
        c,
        browser::Command::Input {
            input: crate::tmux_snapshot::keys::Input::Key(_)
                | crate::tmux_snapshot::keys::Input::Text(_),
            ..
        }
    )));
    view.read_with(cx, |view, _| assert!(view.picker.is_none()));
}
