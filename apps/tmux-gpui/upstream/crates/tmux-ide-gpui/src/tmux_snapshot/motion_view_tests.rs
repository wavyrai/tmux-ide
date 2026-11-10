//! The motion in a drawn window (#761): each surface on the test clock,
//! with Reduce motion on and off.
#![allow(clippy::unwrap_used)]
use crate::tmux_snapshot::{SnapshotView, browser, fit_test_support::fixture_view};
use gpui::{Entity, Pixels, TestAppContext, VisualTestContext, px, size};
use std::{sync::mpsc, time::Duration};

fn choice(id: &str) -> browser::Choice {
    browser::Choice {
        id: id.into(),
        label: format!("Session {id}"),
        pane_count: None,
        window_id: None,
        browser_icon: None,
        display_name_source: None,
        window_label: None,
    }
}

/// A Home window with `sessions`, drawn with Reduce motion `reduced`.
fn open<'a>(
    cx: &'a mut TestAppContext,
    sessions: &[&str],
    reduced: bool,
) -> (
    Entity<SnapshotView>,
    &'a mut VisualTestContext,
    mpsc::Receiver<browser::Command>,
) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let sessions: Vec<_> = sessions.iter().map(|id| choice(id)).collect();
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = fixture_view(
            window,
            cx,
            sender,
            7,
            browser::State {
                request: 7,
                surface: browser::Surface::Home,
                home_phase: browser::HomePhase::Live,
                input_ready: true,
                sessions,
                ..Default::default()
            },
        );
        view.chrome.force_motion(reduced);
        view
    });
    cx.simulate_resize(size(px(900.), px(700.)));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    // Let the window's own entrances (the sidebar's fade) finish first.
    cx.background_executor.advance_clock(Duration::from_secs(1));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    (view, cx, receiver)
}

fn draw(cx: &mut VisualTestContext) {
    cx.update(|window, cx| window.draw(cx).clear(cx));
}

fn top(cx: &mut VisualTestContext, selector: &'static str) -> Pixels {
    cx.debug_bounds(selector).unwrap().top()
}

/// How many next-frame requests one more draw leaves behind. Home asks
/// for some of its own; a settled motion adds none to them.
fn owed_when_idle(cx: &mut VisualTestContext) -> usize {
    cx.update(|window, cx| {
        window.simulate_next_frame(cx);
        window.draw(cx).clear(cx);
        window.simulate_next_frame(cx)
    })
}

#[gpui::test]
fn the_palette_enters_over_menu_in_and_reduce_motion_snaps_it(cx: &mut TestAppContext) {
    let (view, cx, _rx) = open(cx, &["a"], true);
    cx.simulate_keystrokes("f5");
    draw(cx);
    let settled = top(cx, "commands-popover");
    // Reduced: the first frame is the end state.
    let baseline = owed_when_idle(cx);
    assert_eq!(top(cx, "commands-popover"), settled);
    cx.simulate_keystrokes("escape");
    cx.update(|window, cx| {
        view.update(cx, |view, _| view.chrome.force_motion(false));
        window.draw(cx).clear(cx);
    });
    cx.simulate_keystrokes("f5");
    draw(cx);
    let first = top(cx, "commands-popover");
    assert_eq!(first, settled - px(2.), "MENU_IN starts 2 pt high");
    cx.background_executor
        .advance_clock(Duration::from_millis(70));
    draw(cx);
    let mid = top(cx, "commands-popover");
    assert!(mid > first && mid < settled, "partway at 70 ms: {mid:?}");
    cx.background_executor
        .advance_clock(Duration::from_millis(70));
    draw(cx);
    assert_eq!(top(cx, "commands-popover"), settled, "settled at 140 ms");
    // gpui ends an animation on the frame after its last, so step past it.
    cx.background_executor
        .advance_clock(Duration::from_millis(1));
    draw(cx);
    let owed = owed_when_idle(cx);
    assert!(
        owed <= baseline,
        "no frames once settled: {owed} > {baseline}"
    );
}

#[gpui::test]
fn switching_palette_modes_does_not_replay_the_entrance(cx: &mut TestAppContext) {
    let (_view, cx, _rx) = open(cx, &["a"], false);
    cx.simulate_keystrokes("f5");
    draw(cx);
    cx.background_executor
        .advance_clock(Duration::from_millis(200));
    draw(cx);
    let settled = top(cx, "commands-popover");
    cx.simulate_input("switch session");
    cx.simulate_keystrokes("enter");
    draw(cx);
    assert_eq!(top(cx, "commands-popover"), settled);
}

#[gpui::test]
fn a_session_arriving_on_home_fades_in_and_existing_rows_do_not(cx: &mut TestAppContext) {
    let (view, cx, _rx) = open(cx, &["a"], false);
    let baseline = owed_when_idle(cx);
    let a = top(cx, "tmux-home-session-0");
    draw(cx);
    assert_eq!(
        top(cx, "tmux-home-session-0"),
        a,
        "opening Home moves nothing"
    );
    cx.update(|_, cx| {
        view.update(cx, |view, cx| {
            view.browser_state.sessions.push(choice("b"));
            cx.notify();
        })
    });
    draw(cx);
    let first = top(cx, "tmux-home-session-1");
    assert_eq!(top(cx, "tmux-home-session-0"), a);
    cx.background_executor
        .advance_clock(Duration::from_millis(500));
    draw(cx);
    let settled = top(cx, "tmux-home-session-1");
    assert_eq!(first, settled + px(super::RISE), "FADE_IN starts 4 pt low");
    // gpui ends an animation on the frame after its last, so step past it.
    cx.background_executor
        .advance_clock(Duration::from_millis(1));
    draw(cx);
    let owed = owed_when_idle(cx);
    assert!(
        owed <= baseline,
        "no frames once settled: {owed} > {baseline}"
    );
}

#[gpui::test]
fn reduce_motion_draws_an_arriving_row_settled(cx: &mut TestAppContext) {
    let (view, cx, _rx) = open(cx, &["a"], true);
    cx.update(|_, cx| {
        view.update(cx, |view, cx| {
            view.browser_state.sessions.push(choice("b"));
            cx.notify();
        })
    });
    draw(cx);
    let first = top(cx, "tmux-home-session-1");
    cx.background_executor
        .advance_clock(Duration::from_millis(500));
    draw(cx);
    assert_eq!(top(cx, "tmux-home-session-1"), first);
}

#[gpui::test]
fn the_sidebar_reveal_glides_over_scroll_glide(cx: &mut TestAppContext) {
    let ids: Vec<String> = (0..40).map(|i| format!("s{i}")).collect();
    let ids: Vec<&str> = ids.iter().map(String::as_str).collect();
    let (view, cx, _rx) = open(cx, &ids, false);
    cx.simulate_resize(size(px(640.), px(400.)));
    cx.update(|window, cx| {
        view.update(cx, |view, _| {
            view.browser_state.surface = browser::Surface::Workspace;
            view.browser_state.selected_session = Some("s0".into());
        });
        window.draw(cx).clear(cx);
        window.draw(cx).clear(cx);
    });
    let start = top(cx, "tmux-sidebar-row-35");
    // Let the window's own entrances finish, then count what idle costs.
    cx.background_executor.advance_clock(Duration::from_secs(1));
    draw(cx);
    let baseline = owed_when_idle(cx);
    cx.update(|window, cx| {
        view.update(cx, |view, _| {
            view.browser_state.selected_session = Some("s35".into())
        });
        window.draw(cx).clear(cx);
        window.draw(cx).clear(cx);
    });
    let list = cx.debug_bounds("session-list").unwrap();
    cx.background_executor
        .advance_clock(Duration::from_millis(250));
    draw(cx);
    let mid = top(cx, "tmux-sidebar-row-35");
    assert!(mid < start, "moving at 250 ms: {mid:?} from {start:?}");
    assert!(mid > list.bottom(), "not there yet at 250 ms: {mid:?}");
    cx.background_executor
        .advance_clock(Duration::from_millis(250));
    draw(cx);
    draw(cx);
    let row = cx.debug_bounds("tmux-sidebar-row-35").unwrap();
    assert!(row.top() >= list.top() && row.bottom() <= list.bottom());
    draw(cx);
    assert_eq!(top(cx, "tmux-sidebar-row-35"), row.top(), "settled");
    // A settled glide asks for no more frames (#352 review).
    cx.background_executor
        .advance_clock(Duration::from_millis(1));
    draw(cx);
    let owed = owed_when_idle(cx);
    assert!(
        owed <= baseline,
        "no frames once settled: {owed} > {baseline}"
    );
}
