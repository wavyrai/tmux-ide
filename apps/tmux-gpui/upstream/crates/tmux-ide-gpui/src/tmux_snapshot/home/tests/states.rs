use super::*;
use browser::local_setup::{Phase, Setup};

fn home_view(
    window: &mut Window,
    cx: &mut Context<SnapshotView>,
    sender: mpsc::SyncSender<browser::Command>,
) -> SnapshotView {
    let mut view = make_view(window, cx, sender);
    view.frame = None;
    view.painted_frame = None;
    view.browser_state.frame = None;
    view.browser_state.input_ready = false;
    view.browser_state.selected_session = None;
    view
}

fn draw(
    view: &Entity<SnapshotView>,
    cx: &mut VisualTestContext,
    change: impl FnOnce(&mut SnapshotView),
) {
    cx.update(|window, cx| {
        view.update(cx, |view, _| change(view));
        window.draw(cx).clear(cx);
    });
}

#[test]
fn only_setup_failure_and_an_unavailable_catalog_take_a_strip() {
    let state = |setup: Option<Phase>, home_phase| browser::State {
        status: "Daemon status".into(),
        home_phase,
        local_setup: setup.map(|phase| Setup { phase }),
        ..Default::default()
    };
    use browser::HomePhase::{Live, Loading, Unavailable};
    for (row, (setup, phase, connected, tone)) in [
        (Some(Phase::Failed), Live, true, StatusTone::Error),
        (Some(Phase::Failed), Unavailable, true, StatusTone::Error),
        (None, Unavailable, true, StatusTone::Warning),
        (None, Unavailable, false, StatusTone::Warning),
        (Some(Phase::Failed), Unavailable, false, StatusTone::Warning),
        (
            Some(Phase::Available),
            Unavailable,
            true,
            StatusTone::Normal,
        ),
        (Some(Phase::Running), Live, true, StatusTone::Normal),
        (Some(Phase::Missing), Live, true, StatusTone::Normal),
        (Some(Phase::StoppedWaiting), Live, true, StatusTone::Normal),
        (None, Loading, true, StatusTone::Normal),
        (None, Live, true, StatusTone::Normal),
        (None, Live, false, StatusTone::Normal),
    ]
    .into_iter()
    .enumerate()
    {
        assert_eq!(
            status_tone(&state(setup, phase), connected),
            tone,
            "row {row}"
        );
    }
}

#[gpui::test]
fn failure_status_renders_a_strip_and_normal_status_the_subtitle(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| home_view(window, cx, sender));
    cx.simulate_resize(size(px(900.), px(800.)));
    receiver.try_iter().for_each(drop);
    let shown = |cx: &mut VisualTestContext| {
        [
            "home-status-subtitle",
            "home-status-warning",
            "home-status-error",
            "home-act-card",
        ]
        .into_iter()
        .filter(|key| cx.debug_bounds(key).is_some())
        .collect::<Vec<_>>()
    };
    draw(&view, cx, |v| {
        v.browser_state.local_setup = Some(Setup {
            phase: Phase::Failed,
        })
    });
    // r3: setup that needs the user is the act card, at once.
    assert_eq!(shown(cx), ["home-act-card"]);
    draw(&view, cx, |v| {
        v.browser_state.local_setup = None;
        v.browser_state.home_phase = browser::HomePhase::Unavailable;
        v.browser_state.status = "The local daemon could not be reached.".into();
    });
    assert_eq!(shown(cx), ["home-status-warning"]);
    draw(&view, cx, |v| {
        v.browser_state.local_setup = Some(Setup {
            phase: Phase::Available,
        })
    });
    assert_eq!(shown(cx), ["home-act-card"]);
    draw(&view, cx, |v| {
        v.browser_state.local_setup = None;
        v.browser_state.home_phase = browser::HomePhase::Loading;
        v.browser_state.status = "Loading sessions…".into();
    });
    // r5: loading paints no text; the footer slot says it once it matters.
    assert!(shown(cx).is_empty());
}

#[gpui::test]
fn empty_state_renders_only_when_a_live_catalog_has_no_sessions(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| home_view(window, cx, sender));
    cx.simulate_resize(size(px(900.), px(800.)));
    receiver.try_iter().for_each(drop);
    let shown = |cx: &mut VisualTestContext| {
        [
            "home-empty",
            "home-guidance-warning",
            "home-guidance-error",
            "tmux-home-session-0",
        ]
        .into_iter()
        .filter(|key| cx.debug_bounds(key).is_some())
        .collect::<Vec<_>>()
    };
    draw(&view, cx, |_| {});
    assert_eq!(shown(cx), ["tmux-home-session-0"]);
    draw(&view, cx, |v| v.browser_state.sessions.clear());
    assert_eq!(shown(cx), ["home-empty"]);
    let empty = cx.debug_bounds("home-empty").unwrap();
    // The empty state fills the table's column, as the strips fill the page's.
    let column = cx.debug_bounds("home-fleet-column").unwrap();
    assert_eq!(
        (empty.left(), empty.right()),
        (column.left(), column.right())
    );
    assert!(empty.size.height > px(80.));
    draw(&view, cx, |v| {
        v.browser_state.home_phase = browser::HomePhase::Unavailable
    });
    assert_eq!(shown(cx), ["home-guidance-warning"]);
    draw(&view, cx, |v| v.browser_commands = None);
    assert_eq!(shown(cx), ["home-guidance-error"]);
}

#[gpui::test]
fn a_live_home_reconnects_quietly_and_shows_a_fatal_reason(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| home_view(window, cx, sender));
    cx.simulate_resize(size(px(900.), px(800.)));
    receiver.try_iter().for_each(drop);
    let shown = |cx: &mut VisualTestContext| {
        [
            "home-status-subtitle",
            "home-status-warning",
            "home-status-error",
            "tmux-reconnect-retry",
            "tmux-home-session-0",
        ]
        .into_iter()
        .filter(|key| cx.debug_bounds(key).is_some())
        .collect::<Vec<_>>()
    };
    draw(&view, cx, |v| {
        v.browser_state.local_setup = None;
        v.browser_state.home_phase = browser::HomePhase::Live;
        v.browser_state.status = "Sessions ready".into();
    });
    assert_eq!(
        shown(cx),
        ["tmux-home-session-0"],
        "a settled Home has no status line"
    );
    draw(&view, cx, |v| {
        v.browser_state.status = "Reconnecting… attempt 2".into();
        v.browser_state.reconnect_attempt = Some(2);
    });
    // r1: a reconnect is the footer slot's: no line, no Retry, the list stays.
    assert_eq!(shown(cx), ["tmux-home-session-0"]);
    draw(&view, cx, |v| {
        v.browser_state.status =
            "The daemon refused this app's credentials. Restart tmux-ide.".into();
        v.browser_state.reconnect_attempt = None;
        v.browser_state.home_fault = true;
    });
    assert_eq!(shown(cx), ["home-status-warning", "tmux-home-session-0"]);
}

/// #693: an unavailable list is said once. The status line carries the
/// reason, so the list's own strip stays out; with no reason to show, the
/// list's strip is the one that says it.
#[gpui::test]
fn an_unavailable_list_shows_one_strip_not_two(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| home_view(window, cx, sender));
    cx.simulate_resize(size(px(900.), px(800.)));
    receiver.try_iter().for_each(drop);
    let strips = |cx: &mut VisualTestContext| {
        [
            "home-status-warning",
            "home-status-error",
            "home-guidance-warning",
            "home-guidance-error",
        ]
        .into_iter()
        .filter(|key| cx.debug_bounds(key).is_some())
        .collect::<Vec<_>>()
    };
    draw(&view, cx, |v| {
        v.browser_state.sessions.clear();
        v.browser_state.local_setup = None;
        v.browser_state.home_phase = browser::HomePhase::Unavailable;
        v.browser_state.status = "No online tmux servers".into();
    });
    assert_eq!(strips(cx), ["home-status-warning"]);
    // The normal case: nothing above says it, so the list's strip does.
    draw(&view, cx, |v| v.browser_state.status.clear());
    assert_eq!(strips(cx), ["home-guidance-warning"]);
    // A lost connection is not this case: its own red strip stays.
    draw(&view, cx, |v| {
        v.browser_commands = None;
        v.browser_state.status = "Connection lost. Reopen tmux-ide to reconnect.".into();
    });
    assert!(strips(cx).contains(&"home-guidance-error"));
}
