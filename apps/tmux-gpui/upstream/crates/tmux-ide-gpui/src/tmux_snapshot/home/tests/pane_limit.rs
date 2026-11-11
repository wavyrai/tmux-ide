//! A session over the native pane limit: Home stays live, lists every session,
//! marks the large one, and shows the notice that says what to do.
use super::*;

const NOTICE: &str = "“big” has 38 panes. This app opens sessions with up to 24.";

fn session(id: &str, label: &str, panes: u64) -> browser::Choice {
    browser::Choice {
        pane_count: Some(panes),
        id: id.into(),
        label: label.into(),
        window_id: None,
        window_label: None,
        browser_icon: None,
        display_name_source: None,
    }
}

#[gpui::test]
fn a_notice_keeps_the_live_list_and_takes_the_warning_strip(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = make_view(window, cx, sender);
        view.frame = None;
        view.painted_frame = None;
        view.browser_state.frame = None;
        view.browser_state.input_ready = false;
        view.browser_state.selected_session = None;
        view.browser_state.home_phase = browser::HomePhase::Live;
        view.browser_state.status = "Sessions ready".into();
        view.browser_state.sessions = vec![session("small", "small", 3), session("big", "big", 38)];
        view.browser_state.home_notice = Some(NOTICE.into());
        view
    });
    cx.simulate_resize(size(px(900.), px(800.)));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    receiver.try_iter().for_each(drop);
    assert!(cx.debug_bounds("home-status-warning").is_some());
    assert!(cx.debug_bounds("home-guidance-warning").is_none());
    assert!(cx.debug_bounds("tmux-home-session-0").is_some());
    assert!(cx.debug_bounds("tmux-home-session-1").is_some());
    view.update(cx, |view, _| {
        let state = &view.browser_state;
        assert_eq!(status_tone(state, true), StatusTone::Warning);
        assert_eq!(status_message(state, true), NOTICE);
    });
    // A reconnect never outranks the notice (quiet reconnect, #357); a
    // fault, which the user must act on, does.
    view.update(cx, |view, _| {
        let mut state = view.browser_state.clone();
        state.status = "Reconnecting… attempt 2".into();
        state.reconnect_attempt = Some(2);
        assert_eq!(status_message(&state, true), NOTICE);
        state.reconnect_attempt = None;
        state.home_fault = true;
        state.status = "The daemon needs an update.".into();
        assert_eq!(status_message(&state, true), "The daemon needs an update.");
        let state = &view.browser_state;
        assert_eq!(
            state.sessions[1].pane_count_label().as_deref(),
            Some("38 panes · too many")
        );
    });
}

#[test]
fn fleet_rows_over_the_limit_say_they_are_too_many_to_open() {
    let row = |panes: u64, windows: u64| -> browser::fleet::Session {
        serde_json::from_value(serde_json::json!({
            "favoriteAction": null,
            "id": "session",
            "name": "work",
            "paneCount": panes,
            "windowCount": windows,
            "sessionId": null,
            "selection": null,
        }))
        .unwrap()
    };
    assert_eq!(fleet_rows::layout(&row(24, 3)), "3 windows · 24 panes");
    assert_eq!(fleet_rows::layout(&row(25, 3)), "25 panes · too many");
    assert_eq!(fleet_rows::layout(&row(38, 38)), "38 panes · too many");
}

/// #357 review, item 1: a catalog drop with a pane-limit notice on Home keeps
/// the notice, shows no reconnect words in Home's strip and no attempt count,
/// at 0 s, 3 s and 9 s; the footer slot alone carries the drop.
#[gpui::test]
fn a_drop_keeps_the_pane_limit_notice_and_says_nothing_in_homes_strip(cx: &mut TestAppContext) {
    use crate::tmux_snapshot::connection::Stage;
    use std::{cell::Cell, rc::Rc, time::Duration};
    let (sender, _receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = make_view(window, cx, sender);
        view.browser_state.home_notice = Some(NOTICE.into());
        view
    });
    let start = std::time::Instant::now();
    let offset = Rc::new(Cell::new(Duration::ZERO));
    let read = offset.clone();
    view.update(cx, |view, _| {
        view.connection.clock = Rc::new(move || (start + read.get(), std::time::SystemTime::now()))
    });
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.browser_state.status = "Reconnecting… attempt 2".into();
            view.browser_state.reconnect_attempt = Some(2);
            view.observe_connection(cx);
        });
        window.draw(cx).clear(cx);
    });
    for (secs, stage) in [(0, Stage::Quiet), (3, Stage::Spinner), (9, Stage::Words)] {
        offset.set(Duration::from_secs(secs));
        cx.update(|window, cx| window.draw(cx).clear(cx));
        assert!(cx.debug_bounds("home-status-warning").is_some(), "{secs} s");
        view.read_with(cx, |view, _| {
            assert_eq!(view.connection_stage(), stage, "{secs} s");
            let shown = status_message(&view.browser_state, true);
            assert_eq!(shown, NOTICE, "{secs} s");
            assert!(!shown.contains("Reconnecting") && !shown.contains("attempt"));
        });
    }
}
