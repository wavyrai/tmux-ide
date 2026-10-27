use super::*;
fn publication(scope: u64, revision: u64) -> super::super::attention::Publication {
    serde_json::from_value(serde_json::json!({
        "scope":scope,"revision":revision,"phase":"live","rows":[
            {"key":"one","sessionId":"session-a","paneId":"pane-a","name":"Same","sessionLabel":"A","status":"BLOCKED","attention":false,"available":true},
            {"key":"two","sessionId":"session-b","paneId":"pane-b","name":"Same","sessionLabel":"B","status":"IDLE","attention":true,"available":true}
        ],"observedSessions":2,"totalSessions":2,"truncatedSessions":0,"truncatedRows":0,"note":null
    })).unwrap()
}
#[gpui::test]
fn f7_preserves_workspace_and_dispatches_exact_scope_revision_key(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    cx.update(|window, cx| {
        view.update(cx, |v, _| {
            v.browser_state.surface = browser::Surface::Workspace;
            v.browser_state.request = 7;
            v.browser_state.attention_supported = true;
            v.input_interrupted = true;
        });
        window.draw(cx).clear(cx);
    });
    let geometry = view.read_with(cx, |v, _| v.input_geometry);
    receiver.try_iter().for_each(drop);
    cx.simulate_keystrokes("f7");
    assert!(matches!(
        receiver.try_recv().unwrap(),
        browser::Command::AttentionObserve {
            request: 7,
            scope: 1,
            active: true
        }
    ));
    cx.update(|window, cx| {
        view.update(cx, |v, cx| {
            v.browser_state.attention_agents = Some(publication(1, 3));
            v.refresh_picker(cx);
        });
        window.draw(cx).clear(cx);
    });
    view.read_with(cx, |v, _| {
        assert_eq!(v.input_geometry, geometry);
        assert!(v.input_interrupted);
        assert_eq!(v.picker.as_ref().unwrap().rows.len(), 1);
    });
    cx.simulate_keystrokes("enter");
    assert!(
        matches!(receiver.try_recv().unwrap(),browser::Command::OpenAttentionAgent{request:8,from_request:7,scope:1,roster_revision:3,key} if key=="two")
    );
    assert!(receiver.try_recv().is_err());
}
#[gpui::test]
fn f7_close_reopen_rejects_old_scope_and_revision(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    cx.update(|window, cx| {
        view.update(cx, |v, _| {
            v.browser_state.request = 7;
            v.browser_state.attention_supported = true;
        });
        window.draw(cx).clear(cx);
    });
    receiver.try_iter().for_each(drop);
    cx.simulate_keystrokes("f7 escape f7");
    assert!(matches!(
        receiver.try_recv().unwrap(),
        browser::Command::AttentionObserve {
            scope: 1,
            active: true,
            ..
        }
    ));
    assert!(matches!(
        receiver.try_recv().unwrap(),
        browser::Command::AttentionObserve {
            scope: 1,
            active: false,
            ..
        }
    ));
    assert!(matches!(
        receiver.try_recv().unwrap(),
        browser::Command::AttentionObserve {
            scope: 2,
            active: true,
            ..
        }
    ));
    cx.update(|window, cx| {
        view.update(cx, |v, cx| {
            v.browser_state.attention_agents = Some(publication(1, 1));
            v.refresh_picker(cx);
            assert!(v.picker.as_ref().unwrap().rows.is_empty());
            v.browser_state.attention_agents = Some(publication(2, 2));
            v.refresh_picker(cx);
            v.choose_picker(
                Target::Attention {
                    scope: 2,
                    revision: 1,
                    key: "two".into(),
                },
                window,
                cx,
            );
            assert!(v.picker.is_some());
            v.cancel_attention(); // same cancellation called by activation loss
            v.choose_picker(
                Target::Attention {
                    scope: 2,
                    revision: 2,
                    key: "two".into(),
                },
                window,
                cx,
            );
            assert!(v.picker.is_some());
        })
    });
    assert!(matches!(
        receiver.try_recv().unwrap(),
        browser::Command::AttentionObserve {
            scope: 2,
            active: false,
            ..
        }
    ));
    assert!(receiver.try_recv().is_err());
}
#[gpui::test]
fn f7_queue_full_and_legacy_helpers_do_not_claim_empty_attention(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(1);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    cx.update(|window, cx| {
        view.update(cx, |v, cx| {
            v.open_attention(window, cx);
            assert!(v.picker.as_ref().unwrap().error.is_some());
            assert!(v.attention.active.is_none());
            v.browser_state.attention_supported = true;
            v.open_attention(window, cx);
            assert!(v.picker.as_ref().unwrap().error.is_some());
            assert!(v.attention.active.is_none());
        })
    });
    assert!(matches!(
        receiver.try_recv().unwrap(),
        browser::Command::Presence { .. }
    ));
    assert!(receiver.try_recv().is_err());
}

#[gpui::test]
fn f7_cancel_survives_full_queue_and_composition_cannot_activate(cx: &mut TestAppContext) {
    use gpui::EntityInputHandler;
    let (sender, receiver) = mpsc::sync_channel(1);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    receiver.try_iter().for_each(drop);
    cx.update(|window, cx| {
        view.update(cx, |v, cx| {
            v.browser_state.request = 7;
            v.browser_state.attention_supported = true;
            v.open_attention(window, cx);
            v.browser_state.attention_agents = Some(publication(1, 1));
            v.refresh_picker(cx);
            let search = v.picker.as_ref().unwrap().search.clone();
            search.update(cx, |input, cx| {
                input.replace_and_mark_text_in_range(None, "界", None, window, cx)
            });
            for key in ["enter", "escape"] {
                v.picker_key(
                    &KeyDownEvent {
                        keystroke: Keystroke::parse(key).unwrap(),
                        is_held: false,
                        prefer_character_input: false,
                        layout: None,
                    },
                    window,
                    cx,
                );
                assert!(v.picker.is_some());
            }
            v.close_picker(window, cx); // close cannot fit while begin remains queued
            assert!(v.attention.active.is_none());
        })
    });
    assert!(matches!(
        receiver.try_recv().unwrap(),
        browser::Command::AttentionObserve {
            active: true,
            scope: 1,
            ..
        }
    ));
    cx.update(|_, cx| view.update(cx, |v, _| v.flush_attention()));
    assert!(matches!(
        receiver.try_recv().unwrap(),
        browser::Command::AttentionObserve {
            active: false,
            scope: 1,
            ..
        }
    ));
    assert!(receiver.try_recv().is_err());
}

#[test]
fn attention_publication_bounds_and_attention_flag_are_strict() {
    let mut value=serde_json::to_value(serde_json::json!({
        "scope":1,"revision":1,"phase":"live","rows":[],"observedSessions":0,"totalSessions":0,"truncatedSessions":0,"truncatedRows":0,"note":null
    })).unwrap();
    for scope in [0, 9_007_199_254_740_992u64] {
        value["scope"] = scope.into();
        let parsed: super::super::attention::Publication =
            serde_json::from_value(value.clone()).unwrap();
        assert!(!parsed.valid());
    }
    value["scope"] = 1.into();
    value["untrustedRoute"] = "other".into();
    assert!(serde_json::from_value::<super::super::attention::Publication>(value).is_err());
}

#[gpui::test]
fn attention_activation_full_queue_retires_old_scope_without_navigation(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(1);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    receiver.try_iter().for_each(drop);
    cx.update(|window, cx| {
        view.update(cx, |v, cx| {
            v.browser_state.request = 7;
            v.browser_state.attention_supported = true;
            v.open_attention(window, cx); // leave begin filling the channel
            v.browser_state.attention_agents = Some(publication(1, 1));
            v.refresh_picker(cx);
            v.choose_picker(
                Target::Attention {
                    scope: 1,
                    revision: 1,
                    key: "two".into(),
                },
                window,
                cx,
            );
            assert!(v.browser_commands.is_some());
            assert!(v.attention.active.is_none());
            assert!(v.browser_state.input_ready);
        })
    });
    assert!(matches!(
        receiver.try_recv().unwrap(),
        browser::Command::AttentionObserve { active: true, .. }
    ));
    cx.update(|_, cx| view.update(cx, |v, _| v.flush_attention()));
    assert!(matches!(
        receiver.try_recv().unwrap(),
        browser::Command::AttentionObserve {
            request: 7,
            scope: 1,
            active: false
        }
    ));
    assert!(receiver.try_recv().is_err());
}

#[gpui::test]
fn attention_rejection_preserves_workspace_and_never_reuses_request(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    receiver.try_iter().for_each(drop);
    cx.update(|window, cx| {
        view.update(cx, |v, cx| {
            v.browser_state.request = 7;
            v.browser_state.surface = browser::Surface::Workspace;
            v.browser_state.attention_supported = true;
            v.open_attention(window, cx);
            v.browser_state.attention_agents = Some(publication(1, 1));
            v.refresh_picker(cx);
            v.choose_picker(
                Target::Attention {
                    scope: 1,
                    revision: 1,
                    key: "two".into(),
                },
                window,
                cx,
            );
            assert_eq!(v.browser_request, 7);
            assert!(v.frame.is_some());
            assert!(v.browser_state.input_ready);
            let mut state = v.browser_state.clone();
            state.attention_selection_rejected = Some(super::super::attention::Rejected {
                request: 8,
                from_request: 7,
                scope: 1,
            });
            v.apply_browser_state(Some(state), cx);
            assert_eq!(v.browser_request, 7);
            assert!(v.frame.is_some());
            assert!(v.picker.as_ref().unwrap().error.is_some());
            v.choose_picker(
                Target::Attention {
                    scope: 1,
                    revision: 1,
                    key: "two".into(),
                },
                window,
                cx,
            );
            let mut unrelated = v.browser_state.clone();
            unrelated.request = 8;
            v.apply_browser_state(Some(unrelated), cx);
            assert_eq!(v.browser_request, 7);
            let mut accepted = v.browser_state.clone();
            accepted.request = 9;
            accepted.input_ready = false;
            accepted.frame = None;
            accepted.attention_selection_rejected = None;
            v.apply_browser_state(Some(accepted), cx);
            assert_eq!(v.browser_request, 9);
            assert!(v.picker.is_none());
            assert!(!v.browser_state.input_ready);
        })
    });
    assert!(matches!(
        receiver.try_recv().unwrap(),
        browser::Command::AttentionObserve { active: true, .. }
    ));
    assert!(matches!(
        receiver.try_recv().unwrap(),
        browser::Command::OpenAttentionAgent { request: 8, .. }
    ));
    assert!(matches!(
        receiver.try_recv().unwrap(),
        browser::Command::OpenAttentionAgent { request: 9, .. }
    ));
    assert!(receiver.try_recv().is_err());
}

#[gpui::test]
fn navigation_cancels_pending_attention_and_skips_reserved_request(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    receiver.try_iter().for_each(drop);
    cx.update(|window, cx| {
        view.update(cx, |v, cx| {
            v.browser_state.request = 7;
            v.browser_state.attention_supported = true;
            v.open_attention(window, cx);
            v.browser_state.attention_agents = Some(publication(1, 1));
            v.refresh_picker(cx);
            v.choose_picker(
                Target::Attention {
                    scope: 1,
                    revision: 1,
                    key: "two".into(),
                },
                window,
                cx,
            );
            let mut late = v.browser_state.clone();
            late.request = 8;
            v.select(Selection::Home, window, cx);
            assert_eq!(v.browser_request, 9);
            v.apply_browser_state(Some(late), cx);
            assert_eq!(v.browser_request, 9);
        })
    });
    assert!(matches!(
        receiver.try_recv().unwrap(),
        browser::Command::AttentionObserve { active: true, .. }
    ));
    assert!(matches!(
        receiver.try_recv().unwrap(),
        browser::Command::OpenAttentionAgent { request: 8, .. }
    ));
    assert!(matches!(
        receiver.try_recv().unwrap(),
        browser::Command::AttentionObserve { active: false, .. }
    ));
    assert!(matches!(
        receiver.try_recv().unwrap(),
        browser::Command::Home { request: 9 }
    ));
    assert!(receiver.try_recv().is_err());
}

#[gpui::test]
fn queued_attention_navigation_settles_after_dismissal_without_rearming_input(
    cx: &mut TestAppContext,
) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    receiver.try_iter().for_each(drop);
    cx.update(|window, cx| {
        view.update(cx, |v, cx| {
            v.browser_state.request = 7;
            v.browser_state.attention_supported = true;
            v.input_interrupted = true;
            v.open_attention(window, cx);
            v.browser_state.attention_agents = Some(publication(1, 1));
            v.refresh_picker(cx);
            v.choose_picker(
                Target::Attention {
                    scope: 1,
                    revision: 1,
                    key: "two".into(),
                },
                window,
                cx,
            );
            v.close_picker(window, cx);
            v.presence.set_active(false);
            v.cancel_attention();
            assert!(v.attention.active.is_none());
            assert!(v.attention.pending.is_some());
            let mut accepted = v.browser_state.clone();
            accepted.request = 8;
            accepted.input_ready = false;
            accepted.frame = None;
            v.apply_browser_state(Some(accepted), cx);
            assert_eq!(v.browser_request, 8);
            assert!(v.attention.pending.is_none());
            assert!(v.input_interrupted);
            assert!(!v.presence.ready());
            assert!(v.picker.is_none());
        })
    });
    assert!(matches!(
        receiver.try_recv().unwrap(),
        browser::Command::AttentionObserve { active: true, .. }
    ));
    assert!(matches!(
        receiver.try_recv().unwrap(),
        browser::Command::OpenAttentionAgent { request: 8, .. }
    ));
    assert!(matches!(
        receiver.try_recv().unwrap(),
        browser::Command::AttentionObserve { active: false, .. }
    ));
    assert!(receiver.try_recv().is_err());
}

#[gpui::test]
fn dismissed_attention_rejection_clears_pending_without_changing_current_view(
    cx: &mut TestAppContext,
) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    receiver.try_iter().for_each(drop);
    cx.update(|window, cx| {
        view.update(cx, |v, cx| {
            v.browser_state.request = 7;
            v.browser_state.attention_supported = true;
            v.open_attention(window, cx);
            v.browser_state.attention_agents = Some(publication(1, 1));
            v.refresh_picker(cx);
            v.choose_picker(
                Target::Attention {
                    scope: 1,
                    revision: 1,
                    key: "two".into(),
                },
                window,
                cx,
            );
            v.close_picker(window, cx);
            v.presence.set_active(false);
            let frame = v.frame.clone().unwrap();
            let mut rejected = v.browser_state.clone();
            rejected.attention_selection_rejected = Some(super::super::attention::Rejected {
                request: 8,
                from_request: 7,
                scope: 1,
            });
            v.apply_browser_state(Some(rejected), cx);
            assert_eq!(v.browser_request, 7);
            assert!(v.attention.pending.is_none());
            assert!(v.picker.is_none());
            assert!(frame.same(v.frame.as_ref().unwrap()));
            assert!(!v.presence.ready());
        })
    });
}
