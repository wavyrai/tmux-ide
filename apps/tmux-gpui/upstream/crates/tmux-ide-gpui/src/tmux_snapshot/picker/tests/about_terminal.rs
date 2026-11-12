//! With a terminal on screen, About keeps every key from tmux, also when a
//! session-tab switch lands and hands focus back to the terminal under it.
use super::*;
use crate::tmux_snapshot::menu_bar::AboutApp;

fn workspace(
    cx: &mut TestAppContext,
) -> (
    Entity<SnapshotView>,
    &mut VisualTestContext,
    mpsc::Receiver<browser::Command>,
) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = make_view(window, cx, sender);
        view.browser_state.surface = browser::Surface::Workspace;
        view.browser_state.request = view.browser_request;
        view.browser_state.selected_session = Some("session-a".into());
        view
    });
    cx.simulate_resize(size(px(1200.), px(900.)));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    receiver.try_iter().for_each(drop);
    (view, cx, receiver)
}

fn input_sent(receiver: &mpsc::Receiver<browser::Command>) -> bool {
    receiver
        .try_iter()
        .any(|c| matches!(c, browser::Command::Input { .. }))
}

fn type_some(cx: &mut VisualTestContext) {
    cx.simulate_keystrokes("a enter");
    cx.simulate_input("b");
    cx.update(|window, cx| window.draw(cx).clear(cx));
}

#[gpui::test]
fn without_about_the_terminal_takes_typing(cx: &mut TestAppContext) {
    let (_view, cx, receiver) = workspace(cx);
    type_some(cx);
    assert!(input_sent(&receiver), "the fixture's terminal takes input");
}

#[gpui::test]
fn about_over_a_terminal_keeps_typing_from_it(cx: &mut TestAppContext) {
    let (view, cx, receiver) = workspace(cx);
    cx.dispatch_action(AboutApp);
    cx.update(|window, cx| window.draw(cx).clear(cx));
    assert!(view.read_with(cx, |v, _| v.about.is_some()));
    type_some(cx);
    assert!(!input_sent(&receiver));
    assert!(view.read_with(cx, |v, _| v.about.is_some()));
}

/// A session-tab switch lands while About is open: it must not hand the
/// keyboard to the terminal under the card.
#[gpui::test]
fn a_tab_focus_restore_under_about_keeps_typing_from_the_terminal(cx: &mut TestAppContext) {
    let (view, cx, receiver) = workspace(cx);
    cx.update(|window, cx| {
        view.update(cx, |v, _| {
            v.browser_state.session_tabs = Some(
                serde_json::from_value(serde_json::json!({
                    "request": 7, "revision": 3,
                    "active": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                    "pending": null,
                    "next": "22222222-2222-4222-8222-222222222222",
                    "previous": "22222222-2222-4222-8222-222222222222",
                    "closeActive": "33333333-3333-4333-8333-333333333333",
                    "rows": [
                        {"id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "label": "One",
                         "hostLabel": "Machine A", "serverLabel": "Server A",
                         "available": true, "unread": false, "activity": "running",
                         "activate": "11111111-1111-4111-8111-111111111111",
                         "close": "33333333-3333-4333-8333-333333333333"},
                        {"id": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "label": "Two",
                         "hostLabel": "Machine B", "serverLabel": "Server B",
                         "available": true, "unread": true, "activity": "waiting",
                         "activate": "22222222-2222-4222-8222-222222222222",
                         "close": "44444444-4444-4444-8444-444444444444"}
                    ]
                }))
                .unwrap(),
            );
            v.remember_tab_focus(window);
        })
    });
    cx.update(|window, cx| view.update(cx, |v, cx| v.open_about(window, cx)));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    let terminal = view.read_with(cx, |v, _| v.terminal_focus.clone());
    cx.update(|window, _| assert!(!terminal.is_focused(window), "the card keeps focus"));
    type_some(cx);
    assert!(!input_sent(&receiver), "nothing reached tmux under About");
    assert!(view.read_with(cx, |v, _| v.about.is_some()));
}

/// Whatever moves focus to the terminal while About is open, the next frame
/// gives it back to the card.
#[gpui::test]
fn about_takes_the_keyboard_back_on_the_next_frame(cx: &mut TestAppContext) {
    let (view, cx, receiver) = workspace(cx);
    cx.dispatch_action(AboutApp);
    cx.update(|window, cx| window.draw(cx).clear(cx));
    cx.update(|window, cx| {
        let terminal = view.read(cx).terminal_focus.clone();
        terminal.focus(window, cx);
        window.draw(cx).clear(cx);
    });
    let terminal = view.read_with(cx, |v, _| v.terminal_focus.clone());
    cx.update(|window, _| assert!(!terminal.is_focused(window)));
    type_some(cx);
    assert!(!input_sent(&receiver));
}

/// The pane actions menu keeps the keyboard: About waits for it.
#[gpui::test]
fn about_does_not_open_over_the_pane_actions_menu(cx: &mut TestAppContext) {
    let (view, cx, _receiver) = workspace(cx);
    cx.update(|window, cx| {
        view.update(cx, |v, cx| {
            ready_pane(v, false);
            v.open_pane_actions(window, cx);
        })
    });
    if view.read_with(cx, |v, _| v.pane_actions.is_none()) {
        panic!("fixture: the pane actions menu did not open");
    }
    cx.dispatch_action(AboutApp);
    view.read_with(cx, |v, _| assert!(v.about.is_none()));
}
