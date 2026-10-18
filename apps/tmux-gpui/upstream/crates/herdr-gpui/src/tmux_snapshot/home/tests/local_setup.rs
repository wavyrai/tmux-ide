use super::*;
use browser::local_setup::{Phase, Setup};
#[gpui::test]
fn explicit_local_setup_preserves_request_and_refuses_duplicates(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    receiver.try_iter().for_each(drop);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.browser_state.local_setup = Some(Setup {
                phase: Phase::Available,
            });
            view.home_refresh(6, window, cx);
            assert!(receiver.try_recv().is_err());
            view.home_refresh(7, window, cx);
            assert!(matches!(
                receiver.try_recv().unwrap(),
                browser::Command::LocalSetup { request: 7 }
            ));
            assert_eq!(view.browser_request, 7);
            view.home_refresh(7, window, cx);
            assert!(receiver.try_recv().is_err());
        })
    });
}
#[gpui::test]
fn setup_cannot_bypass_workspace_picker_or_composition(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    receiver.try_iter().for_each(drop);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.browser_state.local_setup = Some(Setup {
                phase: Phase::Available,
            });
            view.browser_state.surface = browser::Surface::Workspace;
            view.home_refresh(7, window, cx);
            assert!(receiver.try_recv().is_err());
            view.browser_state.surface = browser::Surface::Home;
            view.marked = "composing".into();
            view.home_refresh(7, window, cx);
            assert!(receiver.try_recv().is_err());
            view.marked.clear();
            view.open_picker(window, cx);
            view.home_refresh(7, window, cx);
            assert!(receiver.try_recv().is_err());
        })
    });
}

#[test]
fn recovery_publication_prefers_supported_setup_guidance_without_rewriting_diagnostics() {
    let raw =
        "The local daemon could not be reached. Check the tmux-ide daemon, then Refresh sessions.";
    for (phase, expected) in [
        ("available", Phase::Available),
        ("running", Phase::Running),
        ("failed", Phase::Failed),
        ("stopped-waiting", Phase::StoppedWaiting),
        ("missing", Phase::Missing),
        ("unsupported", Phase::Unsupported),
    ] {
        let state = browser::State {
            status: raw.into(),
            home_phase: browser::HomePhase::Unavailable,
            local_setup: Some(serde_json::from_value(serde_json::json!({"phase": phase})).unwrap()),
            ..Default::default()
        };
        assert_eq!(status_message(&state, true), expected.guidance());
        assert_eq!(state.status, raw);
        assert_eq!(status_message(&state, false), raw);
    }
    let state = browser::State {
        status: raw.into(),
        ..Default::default()
    };
    assert_eq!(status_message(&state, true), raw);
}

#[gpui::test]
fn setup_queue_failure_shows_retry_without_automatic_submission(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let fill = sender.clone();
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    receiver.try_iter().for_each(drop);
    for _ in 0..64 {
        fill.try_send(browser::Command::LocalSetup { request: 99 })
            .unwrap();
    }
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.browser_state.local_setup = Some(Setup {
                phase: Phase::Available,
            });
            view.home_refresh(7, window, cx);
            assert!(
                view.browser_state
                    .local_setup
                    .as_ref()
                    .is_some_and(|setup| setup.phase == Phase::Failed)
            );
            assert_eq!(
                status_message(&view.browser_state, true),
                Phase::Failed.guidance()
            );
            assert_eq!(
                view.browser_state.status,
                "Local setup request could not be sent. Try again."
            );
            let queued: Vec<_> = receiver.try_iter().collect();
            assert_eq!(queued.len(), 64);
            assert!(
                queued
                    .iter()
                    .all(|command| matches!(command, browser::Command::LocalSetup { request: 99 }))
            );
            assert!(receiver.try_recv().is_err());
            view.home_refresh(7, window, cx);
            assert!(matches!(
                receiver.try_recv().unwrap(),
                browser::Command::LocalSetup { request: 7 }
            ));
            assert!(receiver.try_recv().is_err());
            assert_eq!(
                status_message(&view.browser_state, true),
                Phase::Running.guidance()
            );
        })
    });
}
