use super::*;
use crate::tmux_snapshot::session_tabs::{Outcome, Publication, Result as TabResult};
const A: &str = "11111111-1111-4111-8111-111111111111";
const B: &str = "22222222-2222-4222-8222-222222222222";
const CA: &str = "33333333-3333-4333-8333-333333333333";
const CB: &str = "44444444-4444-4444-8444-444444444444";
fn tabs() -> Publication {
    serde_json::from_value(serde_json::json!({"request":7,"revision":3,"active":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","pending":null,"next":B,"previous":B,"closeActive":CA,"rows":[
{"id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","label":"Duplicate","hostLabel":"Machine A","serverLabel":"Server A","available":true,"unread":false,"activity":"running","activate":A,"close":CA},
{"id":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","label":"Duplicate","hostLabel":"Machine B","serverLabel":"Server B","available":true,"unread":true,"activity":"waiting","activate":B,"close":CB}]})).unwrap()
}
fn prepare(v: &mut SnapshotView) {
    v.browser_state.request = 7;
    v.browser_state.surface = browser::Surface::Workspace;
    v.browser_state.session_tabs = Some(tabs());
}
fn result(request: u64, action: &str, outcome: Outcome) -> TabResult {
    TabResult {
        request,
        from_request: 7,
        revision: 3,
        action: action.into(),
        outcome,
    }
}
#[gpui::test]
fn tab_f9_refusal_preserves_frame_then_close_ack_does_not_navigate(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|w, cx| make_view(w, cx, sender));
    cx.update(|w, cx| {
        view.update(cx, |v, _| prepare(v));
        w.draw(cx).clear(cx);
    });
    receiver.try_iter().for_each(drop);
    cx.simulate_keystrokes("f9");
    assert!(
        matches!(receiver.try_recv().unwrap(),browser::Command::SessionTab{request:8,action,..}if action==B)
    );
    cx.simulate_keystrokes("f9");
    assert!(receiver.try_recv().is_err());
    cx.update(|_, cx| {
        view.update(cx, |v, cx| {
            let mut s = v.browser_state.clone();
            s.session_tab_result = Some(result(8, A, Outcome::Rejected));
            v.apply_browser_state(Some(s), cx);
            assert!(v.session_tabs.pending.is_some());
            let mut s = v.browser_state.clone();
            s.session_tab_result = Some(result(8, B, Outcome::Rejected));
            v.apply_browser_state(Some(s), cx);
            assert!(v.session_tabs.pending.is_none());
            assert!(v.frame.is_some());
            assert_eq!(v.browser_request, 7);
        })
    });
    let close = cx.debug_bounds("close-retained-session-1").unwrap();
    cx.simulate_click(close.center(), Modifiers::default());
    assert!(
        matches!(receiver.try_recv().unwrap(),browser::Command::SessionTab{request:9,action,..}if action==CB)
    );
    cx.update(|_, cx| {
        view.update(cx, |v, cx| {
            let mut s = v.browser_state.clone();
            s.session_tab_result = Some(result(9, CB, Outcome::Closed));
            s.session_tabs.as_mut().unwrap().rows.pop();
            v.apply_browser_state(Some(s), cx);
            assert_eq!(v.browser_request, 7);
            assert!(v.frame.is_some());
            assert!(v.session_tabs.pending.is_none());
        })
    });
}
#[gpui::test]
fn tab_cycle_uses_owner_no_active_quirk_and_close_active_admits_home(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|w, cx| make_view(w, cx, sender));
    cx.update(|w, cx| {
        view.update(cx, |v, _| {
            prepare(v);
            let p = v.browser_state.session_tabs.as_mut().unwrap();
            p.active = None;
            p.close_active = None;
            p.previous = Some(A.into());
        });
        w.draw(cx).clear(cx);
    });
    receiver.try_iter().for_each(drop);
    cx.simulate_keystrokes("shift-f9");
    assert!(
        matches!(receiver.try_recv().unwrap(),browser::Command::SessionTab{request:8,action,..}if action==A)
    );
    cx.update(|_, cx| {
        view.update(cx, |v, cx| {
            let mut s = v.browser_state.clone();
            s.session_tab_result = Some(result(8, A, Outcome::Rejected));
            s.session_tabs = Some(tabs());
            v.apply_browser_state(Some(s), cx);
        })
    });
    cx.simulate_keystrokes("ctrl-f9");
    assert!(
        matches!(receiver.try_recv().unwrap(),browser::Command::SessionTab{request:9,action,..}if action==CA)
    );
    cx.update(|_, cx| {
        view.update(cx, |v, cx| {
            let mut s = v.browser_state.clone();
            s.request = 9;
            s.surface = browser::Surface::Home;
            s.frame = None;
            s.input_ready = false;
            s.session_tabs = None;
            s.session_tab_result = None;
            v.apply_browser_state(Some(s), cx);
            assert_eq!(v.browser_request, 9);
            assert!(v.frame.is_none());
            assert!(v.session_tabs.pending.is_none());
        })
    });
    assert!(receiver.try_recv().is_err());
}
#[gpui::test]
fn tab_stale_pointer_composition_background_queue_and_pending_guards(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(1);
    let (view, cx) = cx.add_window_view(|w, cx| make_view(w, cx, sender));
    cx.update(|w, cx| {
        view.update(cx, |v, cx| {
            prepare(v);
            v.choose_session_tab(7, 3, B, w, cx);
            assert!(v.session_tabs.pending.is_none());
            assert_eq!(v.browser_request, 7);
        })
    });
    receiver.try_iter().for_each(drop);
    cx.update(|w, cx| {
        view.update(cx, |v, cx| {
            v.browser_state.session_tabs.as_mut().unwrap().revision = 4;
            v.choose_session_tab(7, 3, B, w, cx);
            v.marked = "compose".into();
            v.choose_session_tab(7, 4, B, w, cx);
            v.marked.clear();
            v.presence.set_active(false);
            v.choose_session_tab(7, 4, B, w, cx);
        })
    });
    assert!(receiver.try_recv().is_err());
}

#[gpui::test]
fn tab_shortcuts_held_modal_and_unsupported_combination_never_reach_terminal(
    cx: &mut TestAppContext,
) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|w, cx| make_view(w, cx, sender));
    cx.update(|w, cx| {
        view.update(cx, |v, _| prepare(v));
        w.draw(cx).clear(cx);
    });
    receiver.try_iter().for_each(drop);
    cx.simulate_keystrokes("ctrl-shift-f9");
    assert!(receiver.try_recv().is_err());
    cx.update(|w, cx| {
        view.update(cx, |v, cx| {
            v.picker_key(
                &KeyDownEvent {
                    keystroke: Keystroke::parse("f9").unwrap(),
                    is_held: true,
                    prefer_character_input: false,
                },
                w,
                cx,
            );
            assert!(receiver.try_recv().is_err());
            v.open_commands(w, cx);
            v.picker_key(
                &KeyDownEvent {
                    keystroke: Keystroke::parse("f9").unwrap(),
                    is_held: false,
                    prefer_character_input: false,
                },
                w,
                cx,
            );
            assert!(receiver.try_recv().is_err());
        })
    });
}
#[gpui::test]
fn tab_pending_blocks_other_navigation_owners_then_new_navigation_supersedes(
    cx: &mut TestAppContext,
) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|w, cx| make_view(w, cx, sender));
    cx.update(|w, cx| {
        view.update(cx, |v, _| prepare(v));
        w.draw(cx).clear(cx);
    });
    receiver.try_iter().for_each(drop);
    cx.simulate_keystrokes("f9");
    receiver.try_recv().unwrap();
    cx.update(|w, cx| {
        view.update(cx, |v, cx| {
            v.palette.active = Some((7, 1));
            v.attention.active = Some((7, 2));
            v.choose_palette(1, 1, "other", cx);
            v.choose_attention(2, 1, "other", cx);
            v.browser_state.session_history =
                Some(crate::tmux_snapshot::session_history::Capability {
                    revision: 1,
                    back: Some(A.into()),
                    forward: None,
                });
            v.session_history_key(
                &KeyDownEvent {
                    keystroke: Keystroke::parse("f8").unwrap(),
                    is_held: false,
                    prefer_character_input: false,
                },
                w,
                cx,
            );
            assert!(receiver.try_recv().is_err());
            v.select(Selection::Home, w, cx);
            let current = v.browser_request;
            assert!(current > 8);
            assert!(v.session_tabs.pending.is_none());
            let mut late = v.browser_state.clone();
            late.request = 8;
            v.apply_browser_state(Some(late), cx);
            assert_eq!(v.browser_request, current);
        })
    });
}

#[gpui::test]
fn retained_tab_pointer_narrow_strip_and_cross_owner_guard(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|w, cx| make_view(w, cx, sender));
    cx.simulate_resize(size(px(640.), px(400.)));
    cx.update(|w, cx| {
        view.update(cx, |v, _| prepare(v));
        w.draw(cx).clear(cx);
    });
    receiver.try_iter().for_each(drop);
    let strip = cx.debug_bounds("retained-session-tabs").unwrap();
    let header = cx.debug_bounds("titlebar").unwrap();
    let home = cx.debug_bounds("application-home").unwrap();
    let body = cx.debug_bounds("tmux-shell-body").unwrap();
    assert_eq!(strip.top(), header.top());
    assert_eq!(strip.bottom(), header.bottom());
    assert_eq!(
        body.top(),
        header.bottom(),
        "retained tabs add no second strip"
    );
    assert!(home.right() <= strip.left());
    let tab = cx.debug_bounds("retained-session-1").unwrap();
    // The unified titlebar reserves Home and fixed controls. Reveal the second
    // long tab through the retained scroll owner before targeting its pixels.
    if tab.right() > strip.right() {
        cx.simulate_event(ScrollWheelEvent {
            position: strip.center(),
            delta: ScrollDelta::Pixels(point(strip.right() - tab.right(), px(0.))),
            modifiers: Modifiers::default(),
            touch_phase: TouchPhase::Moved,
        });
        cx.update(|w, cx| w.draw(cx).clear(cx));
    }
    let strip = cx.debug_bounds("retained-session-tabs").unwrap();
    let tab = cx.debug_bounds("retained-session-1").unwrap();
    let close = cx.debug_bounds("close-retained-session-1").unwrap();
    assert!(close.size.width >= px(24.));
    assert!(close.left() >= strip.left() && close.right() <= strip.right());
    let label_left = tab.left().max(strip.left());
    let label_right = close.left().min(strip.right());
    assert!(
        label_right > label_left,
        "visible label target must exclude nested close"
    );
    let hit = point(label_left + (label_right - label_left) / 2., tab.center().y);
    cx.simulate_click(hit, Modifiers::default());
    assert!(
        matches!(receiver.try_recv().unwrap(), browser::Command::SessionTab { action, .. } if action == B)
    );
    cx.update(|w, cx| {
        view.update(cx, |v, cx| {
            let mut state = v.browser_state.clone();
            state.session_tab_result = Some(result(8, B, Outcome::Rejected));
            v.apply_browser_state(Some(state), cx);
            v.attention.active = Some((7, 1));
            v.choose_attention(1, 2, "agent", cx);
            assert!(matches!(
                receiver.try_recv().unwrap(),
                browser::Command::OpenAttentionAgent { .. }
            ));
            v.choose_session_tab(7, 3, A, w, cx);
            assert!(receiver.try_recv().is_err());
            assert!(v.session_tabs.pending.is_none());
        })
    });
}
