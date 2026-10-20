use super::*;
use crate::tmux_snapshot::{copy, selection};

#[gpui::test]
fn nr03_completed_selection_focus_and_composition_baseline(cx: &mut TestAppContext) {
    selection_round_trip(cx, false, false);
}
#[gpui::test]
fn nr03_completed_selection_returns_only_with_proven_viewport(cx: &mut TestAppContext) {
    selection_round_trip(cx, true, false);
}
#[gpui::test]
fn nr03_explicit_clear_supersedes_pending_selection_restore(cx: &mut TestAppContext) {
    selection_round_trip(cx, true, true);
}
fn selection_round_trip(cx: &mut TestAppContext, proven: bool, cancel: bool) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    receiver.try_iter().for_each(drop);
    cx.update(|window, cx| {
        view.update(cx, |v, cx| {
            prepare(v);
            v.browser_state.presence_revision = 1;
            v.browser_state.selection_identity = proven.then(|| "a".repeat(64));
            let frame = v.browser_state.frame.as_ref().unwrap();
            v.browser_state.copy_region = Some(copy::Region {
                id: "pane-a".into(),
                left: 0,
                top: 0,
                width: frame.width,
                height: frame.height,
                wrapped: vec![false; usize::from(frame.height)],
            });
            let mut selected = selection::Capture::begin(&v.browser_state, 0., 0.).unwrap();
            selected.update(3., 0.).unwrap();
            selected.dragging = false;
            assert!(!selected.empty());
            assert_eq!(selected.text().unwrap(), "tmu");
            v.selection = Some(selected);
            let original = v.browser_state.clone();
            assert!(v.terminal_focus.is_focused(window));
            v.choose_session_tab(7, 3, B, window, cx);
            assert!(matches!(
                receiver.try_recv().unwrap(),
                browser::Command::SessionTab { request: 8, .. }
            ));
            // An IME update arriving after admission must not follow navigation.
            v.marked = "NEVER_REPLAY_COMPOSITION".into();
            v.marked_selection = Some(0..3);
            let mut next = original.clone();
            next.request = 8;
            next.selected_pane = Some("pane-b".into());
            next.selection_identity = proven.then(|| "b".repeat(64));
            next.copy_region.as_mut().unwrap().id = "pane-b".into();
            next.regions[0].id = "pane-b".into();
            let tabs = next.session_tabs.as_mut().unwrap();
            tabs.request = 8;
            tabs.active = Some(tabs.rows[1].id.clone());
            tabs.close_active = Some(CB.into());
            assert!(tabs.valid());
            v.apply_browser_state(Some(next), cx);
            assert!(v.selection.is_none());
            assert!(v.marked.is_empty());
            assert!(v.marked_selection.is_none());
            assert!(v.terminal_focus.is_focused(window));
            assert!(
                receiver.try_recv().is_err(),
                "composition must not become input"
            );
            v.choose_session_tab(8, 3, A, window, cx);
            assert!(matches!(
                receiver.try_recv().unwrap(),
                browser::Command::SessionTab { request: 9, .. }
            ));
            let mut back = original;
            back.request = 9;
            back.session_tabs.as_mut().unwrap().request = 9;
            v.apply_browser_state(Some(back), cx);
            assert!(v.marked.is_empty());
            assert!(
                receiver.try_recv().is_err(),
                "returning must not replay input"
            );
            assert!(v.terminal_focus.is_focused(window));
            if cancel {
                v.clear_selection(cx);
            }
        });
        window.draw(cx).clear(cx);
        view.update(cx, |v, _| {
            assert_eq!(
                v.selection
                    .as_ref()
                    .map(|selection| selection.text().unwrap()),
                (proven && !cancel).then(|| "tmu".into())
            );
            assert!(
                v.selection
                    .as_ref()
                    .is_none_or(|selection| !selection.dragging)
            );
        });
    });
}

#[gpui::test]
fn nr03_sidebar_scope_returns_without_input_replay(cx: &mut TestAppContext) {
    sidebar_round_trip(cx, false);
}

#[gpui::test]
fn nr03_newer_sidebar_focus_supersedes_saved_terminal_scope(cx: &mut TestAppContext) {
    sidebar_round_trip(cx, true);
}

fn sidebar_round_trip(cx: &mut TestAppContext, supersede: bool) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    cx.update(|window, cx| {
        view.update(cx, |v, _| {
            prepare(v);
            v.browser_state.presence_revision = 1;
        });
        window.draw(cx).clear(cx);
    });
    receiver.try_iter().for_each(drop);
    if !supersede {
        cx.simulate_keystrokes("ctrl-g");
    }
    cx.update(|window, cx| {
        view.update(cx, |v, cx| {
            assert_eq!(v.sidebar_keyboard.active, !supersede);
            assert_eq!(v.terminal_focus.is_focused(window), supersede);
            let original = v.browser_state.clone();
            v.choose_session_tab(7, 3, B, window, cx);
            assert!(matches!(
                receiver.try_recv().unwrap(),
                browser::Command::SessionTab { request: 8, .. }
            ));
            let mut next = original.clone();
            next.request = 8;
            next.selected_pane = Some("pane-b".into());
            let tabs = next.session_tabs.as_mut().unwrap();
            tabs.request = 8;
            tabs.active = Some(tabs.rows[1].id.clone());
            tabs.close_active = Some(CB.into());
            assert!(tabs.valid());
            v.apply_browser_state(Some(next), cx);
            assert!(!v.sidebar_keyboard.active);
            v.choose_session_tab(8, 3, A, window, cx);
            assert!(matches!(
                receiver.try_recv().unwrap(),
                browser::Command::SessionTab { request: 9, .. }
            ));
            let mut back = original;
            back.request = 9;
            back.session_tabs.as_mut().unwrap().request = 9;
            v.apply_browser_state(Some(back), cx);
            if supersede {
                // Explicit sidebar focus arriving before the next draw supersedes restoration.
                assert!(v.sidebar_keyboard_key(
                    &KeyDownEvent {
                        keystroke: Keystroke::parse("ctrl-g").unwrap(),
                        is_held: false,
                        prefer_character_input: false,
                        layout: None,
                    },
                    window,
                    cx
                ));
            }
            v.input_interrupted = true;
            receiver.try_iter().for_each(drop);
        });
        window.draw(cx).clear(cx);
        view.update(cx, |v, _| {
            assert!(v.sidebar_keyboard.active);
            assert!(!v.terminal_focus.is_focused(window));
            assert!(v.input_interrupted, "restoring focus must not rearm input");
            let commands: Vec<_> = receiver
                .try_iter()
                .map(|command| serde_json::to_value(command).unwrap())
                .collect();
            // Drawing a newly admitted frame can publish its viewport geometry.
            assert!(
                commands.iter().all(|command| command["type"] == "input"
                    && command["request"] == 9
                    && command["id"] == "pane-a"
                    && command["input"]["kind"] == "resize"),
                "unexpected commands: {commands:?}"
            );
        });
    });
}
