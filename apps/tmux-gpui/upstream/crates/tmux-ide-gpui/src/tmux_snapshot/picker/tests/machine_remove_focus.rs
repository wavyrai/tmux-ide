#![allow(clippy::unwrap_used)]
use super::*;
use core::prelude::v1::test;
use gpui::TestAppContext;
use std::sync::mpsc;

const ID: &str = "00000000-0000-4000-8000-000000000001";
fn prepare(view: &mut SnapshotView, window: &mut Window, cx: &mut Context<SnapshotView>) {
    view.browser_state.machines = Some(
        serde_json::from_value(serde_json::json!({
            "revision":12,"available":true,"pending":false,"message":null,"error":null,
            "machines":[{"id":ID,"label":"Original", "sshTarget":"old-host",
            "enabled":true,"expectedEnvironmentId":null}]
        }))
        .unwrap(),
    );
    view.input_interrupted = true;
    view.open_picker_mode(Mode::ManageMachines, window, cx);
    view.begin_machine_removal(ID, 12, window, cx);
}

#[gpui::test]
fn removal_footer_cycles_both_directions_and_cancel_restores_focus(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|w, cx| tests::make_view(w, cx, sender));
    cx.update(|w, cx| {
        view.update(cx, |v, cx| prepare(v, w, cx));
        w.draw(cx).clear(cx);
    });
    receiver.try_iter().for_each(drop);
    for (keys, confirm) in [
        ("tab", true),
        ("tab", false),
        ("tab", true),
        ("shift-tab", false),
    ] {
        cx.simulate_keystrokes(keys);
        cx.update(|w, cx| {
            view.read_with(cx, |v, _| {
                let form = v.picker.as_ref().unwrap().removal.as_ref().unwrap();
                assert_eq!(form.confirm_focus.is_focused(w), confirm);
                assert_eq!(form.cancel_focus.is_focused(w), !confirm);
            })
        });
    }
    cx.simulate_keystrokes("space");
    assert!(view.read_with(cx, |v, _| v.picker.is_some()));
    cx.simulate_event(KeyUpEvent {
        layout: None,
        keystroke: Keystroke::parse("space").unwrap(),
    });
    cx.update(|w, cx| {
        view.read_with(cx, |v, _| {
            assert!(v.picker.is_none());
            assert!(v.terminal_focus.is_focused(w));
            assert!(v.input_interrupted);
        })
    });
    assert!(receiver.try_recv().is_err());
    cx.update(|w, cx| {
        view.update(cx, |v, cx| prepare(v, w, cx));
        w.draw(cx).clear(cx);
    });
    receiver.try_iter().for_each(drop);
    cx.simulate_keystrokes("shift-tab");
    cx.update(|w, cx| {
        view.read_with(cx, |v, _| {
            assert!(
                v.picker
                    .as_ref()
                    .unwrap()
                    .removal
                    .as_ref()
                    .unwrap()
                    .cancel_focus
                    .is_focused(w)
            );
        })
    });
    cx.simulate_keystrokes("escape");
    assert!(view.read_with(cx, |v, _| v.picker.is_none()));
    assert!(receiver.try_recv().is_err());
}

#[gpui::test]
fn removal_footer_waits_for_keyup_submits_once_and_pending_keeps_cancel(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|w, cx| tests::make_view(w, cx, sender));
    cx.update(|w, cx| {
        view.update(cx, |v, cx| prepare(v, w, cx));
        w.draw(cx).clear(cx);
    });
    receiver.try_iter().for_each(drop);
    cx.simulate_keystrokes("tab enter");
    cx.simulate_event(KeyDownEvent {
        keystroke: Keystroke::parse("enter").unwrap(),
        is_held: true,
        prefer_character_input: false,
        layout: None,
    });
    assert!(receiver.try_recv().is_err());
    cx.simulate_event(KeyUpEvent {
        layout: None,
        keystroke: Keystroke::parse("enter").unwrap(),
    });
    let command = serde_json::to_value(receiver.try_recv().unwrap()).unwrap();
    assert_eq!(command["change"]["id"], ID);
    assert_eq!(command["change"]["operation"], "remove");
    assert!(receiver.try_recv().is_err());
    cx.update(|w, cx| {
        view.update(cx, |v, _| {
            v.browser_state.machines.as_mut().unwrap().pending = true
        });
        w.draw(cx).clear(cx);
    });
    assert!(cx.debug_bounds("machine-remove-confirm").is_none());
    for keys in ["tab", "shift-tab"] {
        cx.simulate_keystrokes(keys);
        cx.update(|w, cx| {
            view.read_with(cx, |v, _| {
                assert!(
                    v.picker
                        .as_ref()
                        .unwrap()
                        .removal
                        .as_ref()
                        .unwrap()
                        .cancel_focus
                        .is_focused(w)
                );
            })
        });
    }
    cx.simulate_keystrokes("enter");
    cx.simulate_event(KeyUpEvent {
        layout: None,
        keystroke: Keystroke::parse("enter").unwrap(),
    });
    assert!(view.read_with(cx, |v, _| v.picker.is_none()));
    assert!(receiver.try_recv().is_err());
}

#[gpui::test]
fn removal_stale_request_keyup_and_pointer_cannot_confirm_or_cancel(cx: &mut TestAppContext) {
    for keys in ["tab enter", "shift-tab enter"] {
        tests::assert_stale_form_inert(
            cx,
            prepare,
            None,
            keys,
            &["machine-remove-confirm", "machine-remove-cancel"],
            |v| v.picker.as_ref().unwrap().removal.is_some(),
        );
    }
}

#[gpui::test]
fn removal_feedback_tracks_registry_confirmation_without_retrying(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|w, cx| tests::make_view(w, cx, sender));
    cx.update(|w, cx| view.update(cx, |v, cx| prepare(v, w, cx)));
    receiver.try_iter().for_each(drop);
    cx.update(|w, cx| view.update(cx, |v, cx| v.confirm_machine_removal(w, cx)));
    assert!(matches!(
        receiver.try_recv().unwrap(),
        browser::Command::Machines { .. }
    ));
    for (available, pending, present, confirmed, text) in [
        (true, false, true, false, "Removal not confirmed."),
        (true, true, true, false, "Removal submitted"),
        (true, false, true, false, "Removal not confirmed."),
        (false, false, false, false, "Removal not confirmed."),
        (true, false, false, true, "Saved connection removed."),
    ] {
        cx.update(|w, cx| {
            view.update(cx, |v, cx| {
                let captured = v.picker.as_ref().unwrap().removal.as_ref().unwrap();
                let registry = v.browser_state.machines.as_mut().unwrap();
                registry.available = available;
                registry.pending = pending;
                registry.machines = if present {
                    vec![captured.profile.clone()]
                } else {
                    vec![]
                };
                // Feedback is uncorrelated: neither stale errors nor uncertain messages prove failure.
                registry.error = Some("Earlier registry error".into());
                registry.message = Some("Could not confirm write".into());
                let (removed, status) = captured.feedback(Some(registry));
                assert_eq!(removed, confirmed);
                assert!(status.starts_with(text));
                v.confirm_machine_removal(w, cx);
            });
            w.draw(cx).clear(cx);
        });
        assert!(cx.debug_bounds("machine-remove-confirm").is_none());
        assert!(receiver.try_recv().is_err());
    }
    cx.update(|w, cx| {
        view.update(cx, |v, _| {
            v.browser_state.machines = None;
            let captured = v.picker.as_ref().unwrap().removal.as_ref().unwrap();
            assert!(!captured.feedback(None).0);
            assert!(
                captured
                    .feedback(None)
                    .1
                    .starts_with("Removal not confirmed.")
            );
        });
        w.draw(cx).clear(cx);
    });
    cx.simulate_keystrokes("escape");
    assert!(view.read_with(cx, |v, _| v.picker.is_none()));
    assert!(receiver.try_recv().is_err());
}
