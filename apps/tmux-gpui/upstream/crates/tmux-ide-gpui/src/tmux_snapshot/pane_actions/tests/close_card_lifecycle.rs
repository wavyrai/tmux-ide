//! #356 review: the close card ends the moment it loses its pane, wherever
//! the layout is applied, and never blocks the next close.
use super::*;

/// A header view with the card open on pane-a (Cmd-W).
fn opened(
    cx: &mut TestAppContext,
) -> (
    Entity<SnapshotView>,
    &mut VisualTestContext,
    mpsc::Receiver<browser::Command>,
) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| header_view(window, cx, sender));
    cx.simulate_resize(size(px(900.), px(700.)));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    receiver.try_iter().for_each(drop);
    crate::tmux_snapshot::fit_test_support::settle(&view, cx, &receiver);
    cx.simulate_keystrokes("cmd-w");
    cx.update(|window, cx| window.draw(cx).clear(cx));
    assert!(view.read_with(cx, |v, _| v.pane_close_open_for("pane-a")));
    (view, cx, receiver)
}

/// Applies a publication made from the current state by `change`, as the
/// browser tick does, then draws. Returns whether a card was still set
/// right after the publication, before any frame.
fn publish(
    view: &Entity<SnapshotView>,
    cx: &mut VisualTestContext,
    change: impl FnOnce(&mut SnapshotView, &mut browser::State),
) -> bool {
    cx.update(|window, cx| {
        let open = view.update(cx, |v, cx| {
            let mut state = v.browser_state.clone();
            change(v, &mut state);
            v.apply_browser_state(Some(state), cx);
            v.pane_close.is_some()
        });
        window.draw(cx).clear(cx);
        open
    })
}

/// The workspace back, pane-b selected with its own capability.
fn workspace_on_pane_b(
    v: &mut SnapshotView,
    state: &mut browser::State,
    template: &browser::State,
) {
    let request = v.browser_request;
    *state = template.clone();
    state.request = request;
    state.selected_pane = Some("pane-b".into());
    state.pane_actions = Some(browser::PaneActions {
        id: "pane-b".into(),
        token: "token-b".into(),
        zoomed: false,
    });
}

fn ended_and_focused(view: &Entity<SnapshotView>, cx: &mut VisualTestContext, path: &str) {
    cx.update(|window, cx| {
        view.read_with(cx, |v, _| {
            assert!(v.pane_close.is_none(), "{path}: the card's state ended");
            assert!(
                v.terminal_focus.is_focused(window),
                "{path}: the terminal has focus again"
            );
        })
    });
    assert!(cx.debug_bounds("pane-close-card").is_none(), "{path}");
}

/// Each way the card loses its pane, one check at a time: it ends, the
/// terminal has focus, and a close on pane-b afterwards opens a card for
/// pane-b.
#[gpui::test]
fn a_new_card_opens_after_the_target_vanished(cx: &mut TestAppContext) {
    type Change = fn(&mut SnapshotView, &mut browser::State);
    let paths: [(&str, Change); 7] = [
        ("pane closed elsewhere", |_, s| {
            s.panes.retain(|p| p.id != "pane-a");
            s.regions.retain(|r| r.id != "pane-a");
            s.selected_pane = Some("pane-b".into());
            s.pane_actions = None;
        }),
        ("layout reissued without it", |_, s| {
            s.regions.retain(|r| r.id != "pane-a");
        }),
        ("dropped from the pane list", |_, s| {
            s.panes.retain(|p| p.id != "pane-a");
        }),
        ("another session in the same request", |_, s| {
            s.selected_session = Some("another".into());
        }),
        ("session switched", |v, s| {
            v.browser_request += 1;
            s.request = v.browser_request;
            s.selected_session = Some("another".into());
        }),
        ("Home", |_, s| s.surface = browser::Surface::Home),
        ("reconnect hold", |_, s| {
            s.retained_preview = true;
            s.input_ready = false;
            s.pane_actions = None;
        }),
    ];
    for (path, change) in paths {
        let (view, cx, receiver) = opened(cx);
        let template = view.read_with(cx, |v, _| v.browser_state.clone());
        assert!(
            !publish(&view, cx, change),
            "{path}: ended where the publication is applied"
        );
        ended_and_focused(&view, cx, path);
        publish(&view, cx, |v, s| workspace_on_pane_b(v, s, &template));
        cx.simulate_keystrokes("cmd-w");
        cx.update(|window, cx| window.draw(cx).clear(cx));
        assert!(
            view.read_with(cx, |v, _| v.pane_close_open_for("pane-b")),
            "{path}: a later close opens its card"
        );
        assert!(cx.debug_bounds("pane-close-card").is_some(), "{path}");
        // Nothing was closed on the way.
        assert!(
            !receiver.try_iter().any(|c| matches!(
                c,
                browser::Command::PaneAction {
                    action: Action::Close,
                    ..
                }
            )),
            "{path}"
        );
    }
}

/// The layout can change without a publication (a window switch writes the
/// state directly): the next frame ends the card, and the next close opens
/// for the pane it names.
#[gpui::test]
fn a_close_after_an_unpublished_layout_change_opens_its_card(cx: &mut TestAppContext) {
    let (view, cx, receiver) = opened(cx);
    cx.update(|window, cx| {
        view.update(cx, |v, _| {
            let s = &mut v.browser_state;
            s.panes.retain(|p| p.id != "pane-a");
            s.regions.retain(|r| r.id != "pane-a");
            s.selected_pane = Some("pane-b".into());
            s.pane_actions = Some(browser::PaneActions {
                id: "pane-b".into(),
                token: "token-b".into(),
                zoomed: false,
            });
        });
        window.draw(cx).clear(cx);
    });
    cx.simulate_keystrokes("cmd-w");
    cx.update(|window, cx| window.draw(cx).clear(cx));
    assert!(view.read_with(cx, |v, _| v.pane_close_open_for("pane-b")));
    assert!(receiver.try_recv().is_err());
}

/// Losing the connection ends the card too.
#[gpui::test]
fn a_lost_connection_ends_the_card(cx: &mut TestAppContext) {
    let (view, cx, _receiver) = opened(cx);
    cx.update(|window, cx| {
        view.update(cx, |v, cx| v.apply_browser_state(None, cx));
        window.draw(cx).clear(cx);
    });
    ended_and_focused(&view, cx, "connection lost");
}

/// A target that is only stale (its capability spent) keeps the card, which
/// then refuses: "Pane changed", and nothing is sent.
#[gpui::test]
fn a_stale_capability_keeps_the_card_and_confirm_refuses(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| header_view(window, cx, sender));
    cx.simulate_resize(size(px(900.), px(700.)));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    receiver.try_iter().for_each(drop);
    crate::tmux_snapshot::fit_test_support::settle(&view, cx, &receiver);
    cx.simulate_keystrokes("cmd-w");
    publish(&view, cx, |_, s| {
        if let Some(actions) = &mut s.pane_actions {
            actions.token = "spent".into();
        }
    });
    assert!(view.read_with(cx, |v, _| v.pane_close_open_for("pane-a")));
    cx.simulate_keystrokes("cmd-w");
    view.read_with(cx, |v, _| {
        let card = v.pane_close.as_ref().unwrap();
        assert_eq!(card.error, Some("Pane changed. Cancel and close it again."));
    });
    assert!(receiver.try_recv().is_err());
}

/// A held Cmd-W (key repeat) never confirms: one press opens, repeats do
/// nothing, and only a fresh press closes.
#[gpui::test]
fn a_held_cmd_w_opens_the_card_and_never_confirms(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| header_view(window, cx, sender));
    cx.simulate_resize(size(px(900.), px(700.)));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    receiver.try_iter().for_each(drop);
    crate::tmux_snapshot::fit_test_support::settle(&view, cx, &receiver);
    cx.simulate_keystrokes("cmd-w");
    cx.update(|window, cx| {
        view.update(cx, |v, cx| {
            for _ in 0..4 {
                v.pane_close_key(
                    &KeyDownEvent {
                        keystroke: Keystroke::parse("cmd-w").unwrap(),
                        is_held: true,
                        prefer_character_input: false,
                        layout: None,
                    },
                    window,
                    cx,
                );
            }
        })
    });
    assert!(receiver.try_recv().is_err(), "a repeat closed the pane");
    assert!(view.read_with(cx, |v, _| v.pane_close_open_for("pane-a")));
    cx.simulate_keystrokes("cmd-w");
    assert!(matches!(
        receiver.try_recv().unwrap(),
        browser::Command::PaneAction {
            action: Action::Close,
            ..
        }
    ));
}
