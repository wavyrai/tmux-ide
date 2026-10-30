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
    assert_eq!(shown(cx), ["home-status-error"]);
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
    assert_eq!(shown(cx), ["home-status-subtitle"]);
    draw(&view, cx, |v| {
        v.browser_state.local_setup = None;
        v.browser_state.home_phase = browser::HomePhase::Loading;
        v.browser_state.status = "Loading sessions…".into();
    });
    assert_eq!(shown(cx), ["home-status-subtitle"]);
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
    assert!(empty.size.width <= px(CARD_MAX) && empty.size.height > px(80.));
    draw(&view, cx, |v| {
        v.browser_state.home_phase = browser::HomePhase::Unavailable
    });
    assert_eq!(shown(cx), ["home-guidance-warning"]);
    draw(&view, cx, |v| v.browser_commands = None);
    assert_eq!(shown(cx), ["home-guidance-error"]);
}

fn rows(count: usize) -> browser::home_agents::Roster {
    let rows: Vec<_> = (0..count)
        .map(|i| serde_json::json!({"key":format!("s\u{0}a{i}"),"sessionId":"s","paneId":format!("p{i}"),
            "name":format!("Agent {i}"),"sessionLabel":"Main","status":"WORKING","attention":false,"available":true}))
        .collect();
    serde_json::from_value(serde_json::json!({"revision":4,"phase":"live","rows":rows,
        "observedSessions":1,"totalSessions":1,"truncatedSessions":0,"truncatedRows":0,"note":null}))
    .unwrap()
}

/// The agents list sits below a column of session cards in a short, narrow
/// window: moving the selection scrolls the page through Bezel's viewport
/// until the list is in view, and the viewport shows its scrollbar.
#[gpui::test]
fn keyboard_selection_scrolls_the_page_to_the_agent_list(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = home_view(window, cx, sender);
        view.browser_state.sessions = (0..12)
            .map(|i| choice(&format!("session-{i}"), "Session"))
            .collect();
        view.browser_state.home_agents = Some(rows(3));
        view
    });
    cx.update(|_, cx| {
        bezel_ui::AppExt::set_scrollbar_visibility(cx, bezel_ui::scroll::Visibility::Always)
    });
    cx.simulate_resize(size(px(600.), px(500.)));
    draw(&view, cx, |_| {});
    draw(&view, cx, |_| {});
    receiver.try_iter().for_each(drop);
    let page = cx.debug_bounds("tmux-home-page").unwrap();
    let before = cx.debug_bounds("tmux-home-agent-0").unwrap();
    assert!(
        before.top() > page.bottom(),
        "the list must start out of view"
    );
    assert!(cx.debug_bounds("tmux-home-page-thumb").is_some());
    cx.simulate_keystrokes("down");
    draw(&view, cx, |_| {});
    let offset = view.read_with(cx, |v, _| {
        v.home_filter.as_ref().unwrap().page_scroll.offset()
    });
    assert!(offset.y < px(0.), "page did not scroll: {offset:?}");
    let after = cx.debug_bounds("tmux-home-agent-0").unwrap();
    assert!(
        after.top() >= page.top() && after.bottom() <= page.bottom(),
        "{after:?} not inside {page:?}"
    );
    assert!(receiver.try_recv().is_err());
}
