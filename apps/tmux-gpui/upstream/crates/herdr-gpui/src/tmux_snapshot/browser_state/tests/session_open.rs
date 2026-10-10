use super::*;

#[gpui::test]
fn explicit_session_open_consumes_current_catalog_preference_once(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    receiver.try_iter().for_each(drop);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.input_interrupted = true;
            // Foreground intent survives an unacknowledged initial presence.
            view.presence = Presence::new(true);
            view.select(Selection::Session("session-a".into()), window, cx);
            assert!(matches!(receiver.try_recv().unwrap(), browser::Command::Session { request: 8, .. }));
            let mut state = view.browser_state.clone();
            state.request = 8;
            state.selected_session = Some("session-a".into());
            state.selected_pane = None;
            state.frame = None;
            state.input_ready = false;
            state.presence_revision = 1;
            state.panes = vec![pane("pane-a", Some("window-a")), pane("pane-b", Some("window-b"))];
            state.preferred_pane = Some("pane-b".into());
            view.apply_browser_state(Some(state.clone()), cx);
            view.finish_session_open(window, cx);
            assert!(receiver.try_recv().is_err(), "loading does not navigate");
            state.session_catalog_complete = true;
            view.apply_browser_state(Some(state.clone()), cx);
            view.finish_session_open(window, cx);
            assert!(matches!(receiver.try_recv().unwrap(), browser::Command::Pane { request: 9, id } if id == "pane-b"));
            assert!(view.input_interrupted);
            assert!(!view.browser_state.input_ready);
            assert!(view.frame.is_none());
            view.apply_browser_state(Some(state), cx);
            view.finish_session_open(window, cx);
            assert!(receiver.try_recv().is_err(), "late completed catalog cannot replay");
        });
    });
}

#[gpui::test]
fn stale_missing_and_removed_preferences_never_fallback(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    receiver.try_iter().for_each(drop);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            for preferred in [None, Some("removed".to_owned())] {
                view.select(Selection::Session("session-a".into()), window, cx);
                receiver.try_iter().for_each(drop);
                let mut state = view.browser_state.clone();
                state.request = view.browser_request;
                state.selected_session = Some("session-a".into());
                state.selected_pane = None;
                state.frame = None;
                state.input_ready = false;
                state.presence_revision = 1;
                state.session_catalog_complete = true;
                state.preferred_pane = preferred;
                state.panes = vec![pane("pane-a", Some("window-a"))];
                view.apply_browser_state(Some(state.clone()), cx);
                view.finish_session_open(window, cx);
                assert!(receiver.try_recv().is_err());
                assert!(view.pending_session_open.is_none());
                state.preferred_pane = Some("pane-a".into());
                view.apply_browser_state(Some(state), cx);
                view.finish_session_open(window, cx);
                assert!(
                    receiver.try_recv().is_err(),
                    "later publication cannot revive consumed intent"
                );
            }
            view.select(Selection::Session("session-a".into()), window, cx);
            let mut stale = view.browser_state.clone();
            stale.request = view.browser_request;
            view.select(Selection::Home, window, cx);
            receiver.try_iter().for_each(drop);
            view.apply_browser_state(Some(stale), cx);
            view.finish_session_open(window, cx);
            assert!(receiver.try_recv().is_err());
            assert!(view.pending_session_open.is_none());
        });
    });
}

#[gpui::test]
fn session_followup_refuses_background_wrong_session_and_queue_failure(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    receiver.try_iter().for_each(drop);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            for wrong_session in [true, false] {
                view.select(Selection::Session("session-a".into()), window, cx);
                receiver.try_iter().for_each(drop);
                let mut state = view.browser_state.clone();
                state.request = view.browser_request;
                state.presence_revision = 1;
                state.selected_session =
                    Some(if wrong_session { "other" } else { "session-a" }.into());
                state.selected_pane = None;
                state.frame = None;
                state.input_ready = false;
                state.session_catalog_complete = true;
                state.preferred_pane = Some("pane-b".into());
                state.panes = vec![pane("pane-b", Some("window-b"))];
                if !wrong_session {
                    view.presence.set_active(false);
                }
                view.apply_browser_state(Some(state), cx);
                view.finish_session_open(window, cx);
                assert!(receiver.try_recv().is_err());
                assert!(view.pending_session_open.is_none());
            }
            // An EOF invalidates even a pending request with no completed catalog.
            view.pending_session_open = Some((view.browser_request, "session-a".into()));
            view.apply_browser_state(None, cx);
            assert!(view.pending_session_open.is_none());
            // Failed admission of the initial Session command must never arm a follow-up.
            let (sender, full) = mpsc::sync_channel(1);
            sender
                .try_send(browser::Command::Home { request: 99 })
                .unwrap();
            view.browser_commands = Some(sender);
            view.select(Selection::Session("session-a".into()), window, cx);
            assert!(view.pending_session_open.is_none());
            assert!(matches!(
                full.try_recv().unwrap(),
                browser::Command::Home { request: 99 }
            ));
        });
    });
}
