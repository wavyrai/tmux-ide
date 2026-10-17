//! Exercise the real metadata-only admission seam, not a synthetic direct live frame.
use super::*;
const ACTION: &str = "11111111-1111-4111-8111-111111111111";
fn prepare(v: &mut SnapshotView) {
    v.browser_state.request = 7;
    v.browser_state.surface = browser::Surface::Workspace;
    v.browser_state.session_history = Some(crate::tmux_snapshot::session_history::Capability {
        revision: 1,
        back: Some(ACTION.into()),
        forward: None,
    });
    v.browser_state.session_tabs = Some(serde_json::from_value(serde_json::json!({"request":7,"revision":1,"active":null,"pending":null,"next":ACTION,"previous":ACTION,"closeActive":null,"rows":[{"id":"22222222-2222-4222-8222-222222222222","label":"Session","hostLabel":"Local","serverLabel":null,"available":true,"unread":false,"activity":null,"activate":ACTION,"close":"33333333-3333-4333-8333-333333333333"}]})).unwrap());
}
fn exercise(
    v: &mut SnapshotView,
    window: &mut Window,
    cx: &mut Context<SnapshotView>,
    receiver: &mpsc::Receiver<browser::Command>,
    tabs: bool,
) {
    prepare(v);
    v.input_interrupted = true;
    v.picker_key(
        &KeyDownEvent {
            keystroke: Keystroke::parse(if tabs { "f9" } else { "f8" }).unwrap(),
            is_held: false,
            prefer_character_input: false,
            layout: None,
        },
        window,
        cx,
    );
    assert!(matches!(
        receiver.try_recv().unwrap(),
        browser::Command::SessionTab { request: 8, .. }
            | browser::Command::SessionHistory { request: 8, .. }
    ));
    let mut loading = v.browser_state.clone();
    loading.request = 8;
    loading.selected_session = None;
    loading.selected_pane = None;
    loading.frame = None;
    loading.input_ready = false;
    loading.session_catalog_complete = false;
    loading.preferred_pane = None;
    loading.panes.clear();
    loading.session_tabs = None;
    v.apply_browser_state(Some(loading.clone()), cx);
    v.finish_session_open(window, cx);
    assert!(
        receiver.try_recv().is_err(),
        "Loading cannot select a guessed pane"
    );
    let mut complete = loading;
    complete.selected_session = Some("admitted-session".into());
    let mut pane = choice("preferred-pane", "Pane");
    pane.window_id = Some("window".into());
    complete.panes = vec![pane];
    complete.preferred_pane = Some("preferred-pane".into());
    complete.session_catalog_complete = true;
    v.apply_browser_state(Some(complete.clone()), cx);
    v.finish_session_open(window, cx);
    assert!(
        matches!(receiver.try_recv().unwrap(),browser::Command::Pane{request:9,id}if id=="preferred-pane")
    );
    assert!(v.input_interrupted);
    v.apply_browser_state(Some(complete), cx);
    v.finish_session_open(window, cx);
    assert!(
        receiver.try_recv().is_err(),
        "Completed catalog cannot replay continuation"
    );
}
#[gpui::test]
fn retained_tab_admission_continues_completed_catalog_once(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|w, cx| make_view(w, cx, sender));
    receiver.try_iter().for_each(drop);
    cx.update(|w, cx| view.update(cx, |v, cx| exercise(v, w, cx, &receiver, true)));
}
#[gpui::test]
fn history_admission_continues_completed_catalog_once(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|w, cx| make_view(w, cx, sender));
    receiver.try_iter().for_each(drop);
    cx.update(|w, cx| view.update(cx, |v, cx| exercise(v, w, cx, &receiver, false)));
}

fn cancellation(cx: &mut TestAppContext, case: u8) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|w, cx| make_view(w, cx, sender));
    receiver.try_iter().for_each(drop);
    cx.update(|w, cx| view.update(cx, |v, cx| cancel_case(v, w, cx, &receiver, case)));
}
fn cancel_case(
    v: &mut SnapshotView,
    w: &mut Window,
    cx: &mut Context<SnapshotView>,
    receiver: &mpsc::Receiver<browser::Command>,
    case: u8,
) {
    prepare(v);
    let action = if case == 3 {
        "33333333-3333-4333-8333-333333333333"
    } else {
        ACTION
    };
    v.choose_session_tab(7, 1, action, w, cx);
    receiver.try_recv().unwrap();
    let original_frame = v.frame.clone();
    let mut state = v.browser_state.clone();
    state.request = 8;
    state.selected_session = None;
    state.selected_pane = None;
    state.frame = None;
    state.input_ready = false;
    state.session_catalog_complete = false;
    state.preferred_pane = None;
    state.panes.clear();
    state.session_tabs = None;
    if case == 3 {
        state.surface = browser::Surface::Home;
    }
    if case == 5 {
        state.selected_session = Some("admitted-session".into());
        state.selected_pane = Some("already-live".into());
        state.frame = original_frame;
        state.input_ready = true;
    }
    v.apply_browser_state(Some(state.clone()), cx);
    v.finish_session_open(w, cx);
    match case {
        0 => {
            v.presence.set_active(false);
            v.finish_session_open(w, cx);
        }
        1 => v.apply_browser_state(None, cx),
        2 => {
            v.select(Selection::Home, w, cx);
            receiver.try_iter().for_each(drop);
        }
        _ => {}
    }
    state.surface = browser::Surface::Workspace;
    state.selected_session = Some("admitted-session".into());
    state.selected_pane = None;
    state.frame = None;
    state.input_ready = false;
    let mut pane = choice("preferred-pane", "Pane");
    pane.window_id = Some("window".into());
    state.panes = vec![pane];
    state.session_catalog_complete = true;
    state.preferred_pane = if case == 4 {
        None
    } else {
        Some("preferred-pane".into())
    };
    v.apply_browser_state(Some(state.clone()), cx);
    v.finish_session_open(w, cx);
    assert!(receiver.try_recv().is_err());
    assert!(v.pending_session_open.is_none());
    state.preferred_pane = Some("preferred-pane".into());
    v.apply_browser_state(Some(state), cx);
    v.finish_session_open(w, cx);
    assert!(receiver.try_recv().is_err());
}
#[gpui::test]
fn admitted_continuation_background_cancels(cx: &mut TestAppContext) {
    cancellation(cx, 0);
}
#[gpui::test]
fn admitted_continuation_disconnect_cancels(cx: &mut TestAppContext) {
    cancellation(cx, 1);
}
#[gpui::test]
fn admitted_continuation_new_request_cancels(cx: &mut TestAppContext) {
    cancellation(cx, 2);
}
#[gpui::test]
fn closing_tab_never_arms_catalog_continuation(cx: &mut TestAppContext) {
    cancellation(cx, 3);
}
#[gpui::test]
fn admitted_continuation_missing_preference_consumes_intent(cx: &mut TestAppContext) {
    cancellation(cx, 4);
}
#[gpui::test]
fn direct_live_admission_never_arms_catalog_continuation(cx: &mut TestAppContext) {
    cancellation(cx, 5);
}
